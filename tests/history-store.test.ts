import { describe, expect, it, vi } from 'vitest';

import {
  HistoryRestorer,
  HistoryStore,
  undoableOperationId,
  type HistoryGroup,
  type HistoryPlatform,
  type PriorTabState,
} from '../src/background/history-store';
import type { LocalStorageArea, StoredValues } from '../src/background/settings-service';

class MemoryStorage implements LocalStorageArea {
  readonly values: StoredValues = {};

  async get(keys: readonly string[]): Promise<StoredValues> {
    return Object.fromEntries(keys.filter((key) => key in this.values).map((key) => [key, this.values[key]]));
  }

  async set(items: StoredValues): Promise<void> {
    Object.assign(this.values, items);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) delete this.values[key];
  }
}

class RecordingHistoryPlatform implements HistoryPlatform {
  readonly actions: string[] = [];
  readonly existingTabs = new Map([
    [1, { tabId: 1, windowId: 3, groupId: 7, splitViewId: undefined }],
    [2, { tabId: 2, windowId: 3, groupId: 7, splitViewId: undefined }],
  ]);

  async listTabs(_windowIds: readonly number[]) {
    return [...this.existingTabs.values()];
  }

  async listGroups(): Promise<HistoryGroup[]> {
    return [{ groupId: 7, windowId: 3, title: 'After', color: 'red' as const }];
  }

  async moveToExistingGroup(tabIds: number[], groupId: number) {
    this.actions.push(`existing:${tabIds.join(',')}:${groupId}`);
  }

  async moveToNewGroup(tabIds: number[], windowId: number, title: string) {
    this.actions.push(`new:${tabIds.join(',')}:${windowId}:${title}`);
  }

  async ungroup(tabIds: number[]) {
    this.actions.push(`ungroup:${tabIds.join(',')}`);
  }
}

const priorTabs: PriorTabState[] = [
  { tabId: 1, windowId: 3, group: null, expectedGroup: { groupId: 7, title: 'After', color: 'red' } },
  { tabId: 2, windowId: 3, group: { groupId: 5, title: 'Before', color: 'blue' }, expectedGroup: { groupId: 7, title: 'After', color: 'red' } },
  { tabId: 99, windowId: 3, group: null, expectedGroup: { groupId: 7, title: 'After', color: 'red' } },
];

describe('HistoryStore and HistoryRestorer', () => {
  it('keeps only the ten most recent committed operations', async () => {
    const store = new HistoryStore(new MemoryStorage(), () => 'operation', () => 100);
    for (let index = 0; index < 12; index += 1) {
      await store.record('sync', [{ tabId: index, windowId: 1, group: null }]);
    }

    const history = await store.list();
    expect(history).toHaveLength(10);
    expect(history[0]?.tabs[0]?.tabId).toBe(11);
    expect(history[9]?.tabs[0]?.tabId).toBe(2);
  });

  it('preserves concurrent history records', async () => {
    const storage = new MemoryStorage();
    let nextId = 0;
    const store = new HistoryStore(storage, () => `operation-${nextId += 1}`, () => 100);

    await Promise.all([
      store.record('automatic', [{ tabId: 1, windowId: 1, group: null }]),
      store.record('automatic', [{ tabId: 2, windowId: 1, group: null }]),
    ]);

    expect((await store.list()).map((operation) => operation.tabs[0]?.tabId)).toEqual([2, 1]);
  });

  it('refuses to undo anything but the most recent operation still in effect', async () => {
    const storage = new MemoryStorage();
    let nextId = 0;
    const store = new HistoryStore(storage, () => `operation-${nextId += 1}`, () => 100);
    const expectedGroup = { groupId: 7, title: 'After', color: 'red' as const };
    await store.record('sync', [{ tabId: 1, windowId: 3, group: null, expectedGroup }]);
    await store.record('sync', [{ tabId: 2, windowId: 3, group: null, expectedGroup }]);
    const restorer = new HistoryRestorer(store, new RecordingHistoryPlatform());

    // Undo is a stack: reverting the older run while the newer one stands is not a state the user
    // could have reached by acting.
    await expect(restorer.undo('operation-1')).rejects.toThrow('history_not_latest');

    await restorer.undo('operation-2');

    // Once the newer one is undone the older becomes the top of the stack.
    expect(undoableOperationId(await store.list())).toBe('operation-1');
    await expect(restorer.undo('operation-1')).resolves.toBeDefined();
  });

  it('has nothing to undo once every operation has been undone', async () => {
    const store = new HistoryStore(new MemoryStorage(), () => 'operation-1', () => 100);
    await store.record('sync', [{ tabId: 1, windowId: 1, group: null }]);
    await store.markUndone('operation-1');

    expect(undoableOperationId(await store.list())).toBeNull();
  });

  it('restores existing tabs, recreates missing groups, and skips closed tabs', async () => {
    const storage = new MemoryStorage();
    const store = new HistoryStore(storage, () => 'operation-1', () => 100);
    await store.record('sync', priorTabs);
    const platform = new RecordingHistoryPlatform();
    const restorer = new HistoryRestorer(store, platform);

    const result = await restorer.undo('operation-1');

    expect(result).toEqual({ restored: 2, skipped: 1 });
    expect(platform.actions).toEqual(['ungroup:1', 'new:2:3:Before']);
    await expect(restorer.undo('operation-1')).rejects.toThrow('history_already_undone');
  });

  it('batches a large undo by prior group and window', async () => {
    const storage = new MemoryStorage();
    const store = new HistoryStore(storage, () => 'operation-1', () => 100);
    const tabs = Array.from({ length: 100 }, (_, index) => ({
      tabId: index + 1,
      windowId: 3,
      group: { title: 'Before', color: 'blue' as const },
      expectedGroup: { groupId: 8, title: 'After', color: 'red' as const },
    }));
    await store.record('sync', tabs);
    let groupQueries = 0;
    let tabQueries = 0;
    let tabSnapshots = 0;
    let requestedWindows: readonly number[] | undefined;
    const moves: number[][] = [];
    const platform: HistoryPlatform & { getTab(tabId: number): Promise<{ tabId: number; windowId: number }> } = {
      getTab: async (tabId) => {
        tabQueries += 1;
        return { tabId, windowId: 3 };
      },
      listTabs: async (windowIds: readonly number[]) => {
        tabSnapshots += 1;
        requestedWindows = windowIds;
        return tabs.map(({ tabId, windowId }) => ({ tabId, windowId, groupId: 8 }));
      },
      listGroups: async () => {
        groupQueries += 1;
        return [
          { groupId: 7, windowId: 3, title: 'Before', color: 'blue' },
          { groupId: 8, windowId: 3, title: 'After', color: 'red' },
        ];
      },
      moveToExistingGroup: async (tabIds) => { moves.push(tabIds); },
      moveToNewGroup: async () => undefined,
      ungroup: async () => undefined,
    };

    const result = await new HistoryRestorer(store, platform).undo('operation-1');

    expect(result).toEqual({ restored: 100, skipped: 0 });
    expect(tabSnapshots).toBe(1);
    expect(requestedWindows).toEqual([3]);
    expect(tabQueries).toBe(0);
    expect(groupQueries).toBe(1);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toHaveLength(100);
  });

  it('skips undo when the user moved a tab after the recorded operation', async () => {
    const store = new HistoryStore(new MemoryStorage(), () => 'operation-1', () => 100);
    await store.record('sync', [{
      tabId: 1,
      windowId: 3,
      group: { groupId: 5, title: 'Before', color: 'blue' },
      expectedGroup: { groupId: 7, title: 'After', color: 'red' },
    }]);
    const platform = new RecordingHistoryPlatform();
    platform.existingTabs.set(1, { tabId: 1, windowId: 3, groupId: 9, splitViewId: undefined });

    const result = await new HistoryRestorer(store, platform).undo('operation-1');

    expect(result).toEqual({ restored: 0, skipped: 1 });
    expect(platform.actions).toEqual([]);
    // Nothing moved, so the entry must stay actionable rather than read as already undone.
    await expect(store.list()).resolves.toMatchObject([{ id: 'operation-1', undoneAt: null }]);
  });

  it('keeps an operation undoable when every recorded tab is gone', async () => {
    const store = new HistoryStore(new MemoryStorage(), () => 'operation-1', () => 100);
    await store.record('sync', [{
      tabId: 1,
      windowId: 3,
      group: null,
      expectedGroup: { groupId: 7, title: 'After', color: 'red' },
    }]);
    // What a Chrome restart looks like: the recorded tab and window IDs no longer exist.
    const platform = new RecordingHistoryPlatform();
    platform.existingTabs.clear();

    const first = await new HistoryRestorer(store, platform).undo('operation-1');

    expect(first).toEqual({ restored: 0, skipped: 1 });
    expect(platform.actions).toEqual([]);
    await expect(store.list()).resolves.toMatchObject([{ undoneAt: null }]);

    // The tab comes back under a new ID later; the entry can still be retried rather than being
    // retired by the attempt that could not reach it.
    platform.existingTabs.set(1, { tabId: 1, windowId: 3, groupId: 7, splitViewId: undefined });

    await expect(new HistoryRestorer(store, platform).undo('operation-1')).resolves.toEqual({
      restored: 1, skipped: 0,
    });
    await expect(store.list()).resolves.toMatchObject([{ undoneAt: 100 }]);
  });

  it('restores the exact prior group ID when it still exists', async () => {
    const store = new HistoryStore(new MemoryStorage(), () => 'operation-1', () => 100);
    await store.record('sync', [{
      tabId: 1,
      windowId: 3,
      group: { groupId: 5, title: 'Before', color: 'blue' },
      expectedGroup: { groupId: 7, title: 'After', color: 'red' },
    }]);
    const platform = new RecordingHistoryPlatform();
    platform.listGroups = async () => [
      { groupId: 5, windowId: 3, title: 'Renamed', color: 'yellow' },
      { groupId: 6, windowId: 3, title: 'Before', color: 'blue' },
      { groupId: 7, windowId: 3, title: 'After', color: 'red' },
    ];

    await new HistoryRestorer(store, platform).undo('operation-1');

    expect(platform.actions).toEqual(['existing:1:5']);
  });

  it('coalesces concurrent undo requests for the same operation', async () => {
    const store = new HistoryStore(new MemoryStorage(), () => 'operation-1', () => 100);
    await store.record('sync', [priorTabs[0] as PriorTabState]);
    const platform = new RecordingHistoryPlatform();
    let releaseUngroup: (() => void) | undefined;
    const ungroupGate = new Promise<void>((resolve) => { releaseUngroup = resolve; });
    platform.ungroup = async (tabIds) => {
      platform.actions.push(`ungroup:${tabIds.join(',')}`);
      await ungroupGate;
    };
    const restorer = new HistoryRestorer(store, platform);

    const first = restorer.undo('operation-1');
    await vi.waitFor(() => expect(platform.actions).toEqual(['ungroup:1']));
    const second = restorer.undo('operation-1');
    releaseUngroup?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { restored: 1, skipped: 0 },
      { restored: 1, skipped: 0 },
    ]);
    expect(platform.actions).toEqual(['ungroup:1']);
  });
});
