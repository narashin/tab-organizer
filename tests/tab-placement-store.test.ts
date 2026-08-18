import { describe, expect, it } from 'vitest';

import type { LocalStorageArea, StoredValues } from '../src/background/settings-service';
import { TabPlacementStore } from '../src/background/tab-placement-store';

class MemoryStorage implements LocalStorageArea {
  readonly values: StoredValues = {};
  async get(keys: readonly string[]): Promise<StoredValues> {
    return Object.fromEntries(keys.filter((key) => key in this.values).map((key) => [key, this.values[key]]));
  }
  async set(items: StoredValues): Promise<void> { Object.assign(this.values, items); }
  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) delete this.values[key];
  }
}

const grouped = (tabId: number, hostname: string) => ({ tabId, groupId: 7, hostname });

describe('TabPlacementStore', () => {
  it('reports a grouped tab whose host has changed since it was examined', async () => {
    const store = new TabPlacementStore(new MemoryStorage());
    await store.record([{ tabId: 1, hostname: 'atlas.test' }, { tabId: 2, hostname: 'docs.test' }]);

    const unsettled = await store.unsettledTabIds([
      grouped(1, 'sandy.test'),
      grouped(2, 'docs.test'),
    ]);

    // Tab 1 was examined as a ATLAS page and now shows something else, so it is not settled.
    expect(unsettled).toEqual([1]);
  });

  it('reports a grouped tab it has never examined, rather than assuming it is settled', async () => {
    const store = new TabPlacementStore(new MemoryStorage());

    // Recording its current host on sight was the earlier answer, and it wrote down a tab that had
    // already drifted as though that were where it started.
    expect(await store.unsettledTabIds([grouped(9, 'unseen.test')])).toEqual([9]);
  });

  it('ignores a tab that has left its group, since the review already covers it', async () => {
    const store = new TabPlacementStore(new MemoryStorage());
    await store.record([{ tabId: 1, hostname: 'atlas.test' }]);

    expect(await store.unsettledTabIds([{ tabId: 1, groupId: -1, hostname: 'sandy.test' }])).toEqual([]);
  });

  it('replaces an earlier record for the same tab', async () => {
    const store = new TabPlacementStore(new MemoryStorage());
    await store.record([{ tabId: 1, hostname: 'atlas.test' }]);
    await store.record([{ tabId: 1, hostname: 'sandy.test' }]);

    expect(await store.list()).toEqual([{ tabId: 1, hostname: 'sandy.test' }]);
    expect(await store.unsettledTabIds([grouped(1, 'sandy.test')])).toEqual([]);
  });

  it('forgets a tab that was closed', async () => {
    const store = new TabPlacementStore(new MemoryStorage());
    await store.record([{ tabId: 1, hostname: 'atlas.test' }, { tabId: 2, hostname: 'docs.test' }]);

    await store.removeClosedTab(1);

    expect(await store.list()).toEqual([{ tabId: 2, hostname: 'docs.test' }]);
  });

  it('drops malformed records rather than failing the read', async () => {
    const storage = new MemoryStorage();
    storage.values.tabPlacements = [
      { tabId: 1, hostname: 'atlas.test' },
      { tabId: 'two', hostname: 'docs.test' },
      null,
    ];
    const store = new TabPlacementStore(storage);

    expect(await store.list()).toEqual([{ tabId: 1, hostname: 'atlas.test' }]);
  });
});
