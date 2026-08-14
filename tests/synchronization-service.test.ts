import { describe, expect, it, vi } from 'vitest';

import type {
  ClassificationRequest,
  Classifier,
  TaxonomyPlanner,
  TaxonomyRequest,
} from '../src/background/classifier';
import { PresetStore } from '../src/background/preset-store';
import type { LocalStorageArea, StoredValues } from '../src/background/settings-service';
import {
  SYNCHRONIZATION_CHUNK_SIZE,
  SYNCHRONIZATION_MAX_CONCURRENT_CHUNKS,
  SynchronizationService,
  type BrowserTab,
  type SynchronizationPlatform,
} from '../src/background/synchronization-service';
import { TabLockStore } from '../src/background/tab-lock-store';
import { HistoryStore } from '../src/background/history-store';

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

class RecordingClassifier implements Classifier {
  readonly requests: ClassificationRequest[] = [];
  async classify(request: ClassificationRequest) {
    this.requests.push(request);
    return request.tabs.map((tab) => ({
      tabRef: tab.ref,
      kind: 'new_group' as const,
      targetRef: null,
      suggestedName: 'Suggested',
      suggestedDescription: 'Related work',
      confidence: 0.8,
      reason: 'Similar titles',
    }));
  }
}

const tabs: BrowserTab[] = [
  { tabId: 1, windowId: 10, title: 'Keep private', url: 'https://locked.test/x', groupId: -1, incognito: false },
  { tabId: 2, windowId: 10, title: 'Internal', url: 'chrome://settings', groupId: -1, incognito: false },
  { tabId: 3, windowId: 10, title: 'Split left', url: 'https://split.test/a', groupId: -1, incognito: false, splitViewId: 7 },
  { tabId: 4, windowId: 10, title: 'Normal A', url: 'https://a.test/page', groupId: -1, incognito: false },
  { tabId: 5, windowId: 20, title: 'Normal B', url: 'https://b.test/page', groupId: -1, incognito: false },
  { tabId: 6, windowId: 20, title: 'Private', url: 'https://private.test', groupId: -1, incognito: true },
];

class RecordingPlatform implements SynchronizationPlatform {
  readonly actions: string[] = [];
  closedTabs = new Set<number>();
  currentTabs = tabs.map((tab) => ({ ...tab }));

  async listTabs(scope: 'all' | 'current') {
    const openTabs = this.currentTabs.filter((tab) => !this.closedTabs.has(tab.tabId));
    return scope === 'current' ? openTabs.filter((tab) => tab.windowId === 10) : openTabs;
  }
  async listGroups() { return []; }
  async getTab(tabId: number) {
    return this.closedTabs.has(tabId)
      ? null
      : this.currentTabs.find((tab) => tab.tabId === tabId) ?? null;
  }
  async moveToExistingGroup(tabIds: number[], groupId: number) {
    this.actions.push(`existing:${tabIds.join(',')}:${groupId}`);
  }
  async moveToNewGroup(tabIds: number[], windowId: number, title: string) {
    this.actions.push(`new:${tabIds.join(',')}:${windowId}:${title}`);
    return 77;
  }
}

function createHarness() {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const classifier = new RecordingClassifier();
  const platform = new RecordingPlatform();
  const presets = new PresetStore(local, () => 'preset-1');
  const locks = new TabLockStore(session, () => 100);
  const history = new HistoryStore(local, () => 'history-1', () => 100);
  const service = new SynchronizationService(
    classifier, presets, locks, history, platform, () => 'en', () => 'proposal-1', session,
  );
  return { service, classifier, platform, locks, history, presets, session };
}

describe('SynchronizationService', () => {
  it('handles every eligible current-window tab and protects locked/internal tabs before payload creation', async () => {
    const { service, classifier, locks } = createHarness();
    await locks.lock(1);

    const proposal = await service.review('current');

    expect(classifier.requests).toHaveLength(1);
    expect(classifier.requests[0]?.tabs.map((tab) => tab.ref)).toEqual(['tab-3', 'tab-4']);
    expect(JSON.stringify(classifier.requests[0])).not.toContain('Keep private');
    expect(JSON.stringify(classifier.requests[0])).not.toContain('chrome://settings');
    expect(proposal.changes).toHaveLength(2);
    expect(proposal.changes.find((change) => change.tabId === 3)).toMatchObject({ selected: false, blockedReason: 'split_view' });
  });

  it('reviews all normal windows separately and applies only selected, valid same-window tabs', async () => {
    const { service, classifier, platform, history } = createHarness();
    const proposal = await service.review('all');
    platform.closedTabs.add(5);

    const result = await service.apply(proposal.id, [4, 5]);

    expect(classifier.requests).toHaveLength(2);
    expect(classifier.requests.flatMap((request) => request.tabs.map((tab) => tab.ref))).toEqual([
      'tab-1',
      'tab-3',
      'tab-4',
      'tab-5',
    ]);
    expect(JSON.stringify(classifier.requests)).not.toContain('Private');
    expect(result).toEqual({ applied: 1, skipped: 1 });
    expect(platform.actions).toEqual(['new:4:10:Suggested']);
    expect(await history.list()).toMatchObject([{ status: 'completed' }]);
  });

  it('hands back a pending proposal from storage alone and drops it once applied', async () => {
    const { service, session } = createHarness();
    const proposal = await service.review('current');

    // A fresh instance stands in for the popup reopening against a restarted service worker.
    const restarted = createHarness();
    Object.assign(restarted.session.values, session.values);
    const restored = await restarted.service.latestProposal();

    expect(restored).toEqual(proposal);
    expect(restored?.changes.map((change) => change.selected)).toEqual(
      proposal.changes.map((change) => change.selected),
    );

    await service.apply(proposal.id, [4]);

    expect(await service.latestProposal()).toBeNull();
    const afterApply = createHarness();
    Object.assign(afterApply.session.values, session.values);
    expect(await afterApply.service.latestProposal()).toBeNull();
  });

  it('joins a group that already carries the name instead of creating a second one', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = [
      { tabId: 21, windowId: 10, title: 'ATLAS board', url: 'https://atlas.test/a', groupId: -1, incognito: false },
      { tabId: 22, windowId: 10, title: 'ATLAS wiki', url: 'https://atlas.test/b', groupId: -1, incognito: false },
    ];
    // A ATLAS group already exists and the user recolored it, so its color no longer matches the
    // preset that names it.
    const liveGroups = [
      { groupId: 500, windowId: 10, ref: 'group-500', title: 'ATLAS', color: 'grey' as const },
    ];
    const presets = new PresetStore(local, () => 'preset-atlas');
    const preset = await presets.create({
      name: 'ATLAS', description: 'Internal tracker', cues: [], color: 'blue',
    });
    const actions: string[] = [];
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => liveGroups,
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async (tabIds, groupId) => {
        actions.push(`existing:${tabIds.join(',')}:${groupId}`);
      },
      moveToNewGroup: async (tabIds, windowId, title) => {
        actions.push(`new:${tabIds.join(',')}:${windowId}:${title}`);
        return 900;
      },
    };
    // One tab is routed by preset, the other invents the same name. Both mean the live group.
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab) => tab.ref === 'tab-21'
        ? {
            tabRef: tab.ref, kind: 'preset' as const, targetRef: preset.id, suggestedName: null,
            suggestedDescription: null, confidence: 0.9, reason: 'Preset match',
          }
        : {
            tabRef: tab.ref, kind: 'new_group' as const, targetRef: null, suggestedName: 'atlas',
            suggestedDescription: 'Tracker pages', confidence: 0.9, reason: 'Same product',
          }),
    };
    const service = new SynchronizationService(
      classifier, presets, new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'dedup',
      session,
    );

    const proposal = await service.review('current');
    const result = await service.apply(proposal.id, [21, 22]);

    expect(result).toEqual({ applied: 2, skipped: 0 });
    // Both tabs land in the group that already had the name; nothing new is created.
    expect(actions).toEqual(['existing:21,22:500']);
    expect(proposal.changes.map((change) => change.target.title)).toEqual(['ATLAS', 'ATLAS']);
  });

  it('creates one group when two chunks propose the same new name', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = Array.from({ length: 8 }, (_, index) => ({
      tabId: 30 + index,
      windowId: 10,
      title: `Apollo ${index}`,
      url: `https://apollo.test/${index}`,
      groupId: -1,
      incognito: false,
    }));
    const actions: string[] = [];
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async (tabIds, groupId) => {
        actions.push(`existing:${tabIds.join(',')}:${groupId}`);
      },
      moveToNewGroup: async (tabIds, windowId, title) => {
        actions.push(`new:${tabIds.length}:${windowId}:${title}`);
        return 901;
      },
    };
    // Eight tabs exceed the chunk size, so this runs as two independent chunks. They answer with
    // the same name in different casing, which must still be one group.
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab, index) => ({
        tabRef: tab.ref,
        kind: 'new_group' as const,
        targetRef: null,
        suggestedName: index % 2 === 0 ? 'Apollo' : 'apollo ',
        suggestedDescription: 'Apollo pages',
        confidence: 0.9,
        reason: 'Same product',
      })),
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'chunked',
      session,
    );

    const proposal = await service.review('current');
    await service.apply(proposal.id, windowTabs.map((tab) => tab.tabId));

    expect(actions).toEqual(['new:8:10:Apollo']);
  });

  it('marks both sides as a Split View conflict when their targets differ', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const splitTabs: BrowserTab[] = [
      { tabId: 11, windowId: 10, title: 'Left', url: 'https://left.test', groupId: -1, incognito: false, splitViewId: 4 },
      { tabId: 12, windowId: 10, title: 'Right', url: 'https://right.test', groupId: -1, incognito: false, splitViewId: 4 },
    ];
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab) => ({
        tabRef: tab.ref, kind: 'new_group', targetRef: null,
        suggestedName: tab.ref === 'tab-11' ? 'Left group' : 'Right group',
        suggestedDescription: null, confidence: 0.9, reason: 'Different topics',
      })),
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => splitTabs,
      listGroups: async () => [],
      getTab: async (tabId) => splitTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier,
      new PresetStore(local, () => 'preset'),
      new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1),
      platform,
      () => 'en',
      () => 'proposal',
    );

    const proposal = await service.review('current');

    expect(proposal.changes.map((change) => change.blockedReason)).toEqual([
      'split_view_conflict',
      'split_view_conflict',
    ]);
  });

  it('reviews more than one hundred tabs in bounded per-window chunks', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const largeTabs: BrowserTab[] = Array.from({ length: 120 }, (_, index) => ({
      tabId: index + 100,
      windowId: 1 + (index % 3),
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    const requests: ClassificationRequest[] = [];
    const classifier: Classifier = {
      classify: async (request) => {
        requests.push(request);
        return request.tabs.map((tab) => ({
          tabRef: tab.ref, kind: 'no_change', targetRef: null, suggestedName: null,
          suggestedDescription: null, confidence: 0.5, reason: 'No change',
        }));
      },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => largeTabs,
      listGroups: async () => [],
      getTab: async (tabId) => largeTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'large',
    );

    const proposal = await service.review('all');

    const refs = requests.flatMap((request) => request.tabs.map((tab) => tab.ref));
    expect(requests).toHaveLength(24);
    expect(Math.max(...requests.map((request) => request.tabs.length)))
      .toBeLessThanOrEqual(SYNCHRONIZATION_CHUNK_SIZE);
    expect(refs).toHaveLength(120);
    expect(new Set(refs).size).toBe(120);
    expect(proposal).toMatchObject({ unchangedCount: 120, changes: [] });
  });

  it('keeps other chunks when one chunk keeps failing and reports the lost tabs', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = Array.from({ length: 12 }, (_, index) => ({
      tabId: index + 800,
      windowId: 11,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    let attempts = 0;
    const classifier: Classifier = {
      classify: async (request) => {
        attempts += 1;
        if (request.tabs.some((tab) => tab.ref === 'tab-800')) {
          throw new Error('classification_invalid_response');
        }
        return request.tabs.map((tab) => ({
          tabRef: tab.ref, kind: 'new_group' as const, targetRef: null,
          suggestedName: 'Reading', suggestedDescription: null, confidence: 0.9, reason: 'Ok',
        }));
      },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'isolated',
    );

    const proposal = await service.review('all');

    // 3 chunks: the failing one is attempted twice, the other two once each.
    expect(attempts).toBe(4);
    expect(proposal.changes).toHaveLength(7);
    expect(proposal.failedTabCount).toBe(5);
    expect(proposal.changes.some((change) => change.tabId === 800)).toBe(false);
  });

  it('retries a failed chunk once and keeps the retried result', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = Array.from({ length: 6 }, (_, index) => ({
      tabId: index + 900,
      windowId: 12,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    let failuresLeft = 1;
    const classifier: Classifier = {
      classify: async (request) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('classification_invalid_response');
        }
        return request.tabs.map((tab) => ({
          tabRef: tab.ref, kind: 'new_group' as const, targetRef: null,
          suggestedName: 'Reading', suggestedDescription: null, confidence: 0.9, reason: 'Ok',
        }));
      },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'retried',
    );

    const proposal = await service.review('all');

    expect(proposal.changes).toHaveLength(6);
    expect(proposal.failedTabCount).toBe(0);
  });

  it('sends the path only when opted in, and never the query behind it', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = [
      { tabId: 3001, windowId: 23, title: 'Ticket', url: 'https://jira.example.test/browse/ATLAS-431?token=abc123', groupId: -1, incognito: false },
    ];
    const seen: string[] = [];
    const classifier: Classifier = {
      classify: async (request) => {
        seen.push(...request.tabs.map((tab) => tab.hostname));
        return request.tabs.map((tab) => ({
          tabRef: tab.ref, kind: 'no_change' as const, targetRef: null, suggestedName: null,
          suggestedDescription: null, confidence: 0.5, reason: 'No change',
        }));
      },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const build = (sendPath: boolean) => new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'paths',
      session, undefined, () => 'balanced', () => sendPath,
    );

    await build(false).review('all');
    await build(true).review('all');

    expect(seen).toEqual([
      'jira.example.test',
      'jira.example.test/browse/ATLAS-431',
    ]);
    // Opting into the path must never drag the query along.
    expect(seen.join(' ')).not.toContain('token=abc123');
  });

  it('assigns a tab by preset cue without sending its URL anywhere', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = [
      { tabId: 2001, windowId: 21, title: 'Board', url: 'https://jira.example.test/browse/ATLAS-431', groupId: -1, incognito: false },
      { tabId: 2002, windowId: 21, title: 'Unrelated', url: 'https://news.example.test/story', groupId: -1, incognito: false },
    ];
    const requests: ClassificationRequest[] = [];
    const classifier: Classifier = {
      classify: async (request) => {
        requests.push(request);
        return request.tabs.map((tab) => ({
          tabRef: tab.ref, kind: 'no_change' as const, targetRef: null, suggestedName: null,
          suggestedDescription: null, confidence: 0.5, reason: 'No change',
        }));
      },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const presets = new PresetStore(local, () => 'preset-atlas');
    await presets.create({ name: 'ATLAS', description: 'ATLAS tickets', cues: ['ATLAS-'], color: 'blue' });
    const service = new SynchronizationService(
      classifier, presets, new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'cued',
    );

    const proposal = await service.review('all');

    expect(proposal.changes).toHaveLength(1);
    expect(proposal.changes[0]).toMatchObject({
      tabId: 2001,
      target: { kind: 'preset', ref: 'preset-atlas', title: 'ATLAS' },
    });
    // The cue matched locally, so the tab never entered a request and its path never left the device.
    expect(requests.flatMap((request) => request.tabs.map((tab) => tab.ref))).toEqual(['tab-2002']);
    expect(JSON.stringify(requests)).not.toContain('ATLAS-431');
    expect(JSON.stringify(requests)).not.toContain('/browse/');
  });

  it('matches a cue case-insensitively and prefers the most specific one', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = [
      { tabId: 2101, windowId: 22, title: 'Ticket', url: 'https://jira.example.test/browse/atlas-9', groupId: -1, incognito: false },
    ];
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab) => ({
        tabRef: tab.ref, kind: 'no_change' as const, targetRef: null, suggestedName: null,
        suggestedDescription: null, confidence: 0.5, reason: 'No change',
      })),
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    let nextId = 0;
    const presets = new PresetStore(local, () => `preset-${nextId += 1}`);
    await presets.create({ name: 'Jira', description: 'All Jira', cues: ['jira'], color: 'grey' });
    await presets.create({ name: 'ATLAS', description: 'ATLAS only', cues: ['ATLAS-'], color: 'blue' });
    const service = new SynchronizationService(
      classifier, presets, new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'specific',
    );

    const proposal = await service.review('all');

    // Both cues match; the longer one is the more deliberate signal.
    expect(proposal.changes[0]?.target).toMatchObject({ ref: 'preset-2', title: 'ATLAS' });
  });

  it('leaves tabs alone when a proposed new group is too small to be worth creating', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    // balanced granularity needs four tabs before a brand new group is worth creating.
    const names = ['Reading', 'Reading', 'Reading', 'Reading', 'Odds', 'Odds'];
    const windowTabs: BrowserTab[] = names.map((_, index) => ({
      tabId: index + 1100,
      windowId: 14,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab) => ({
        tabRef: tab.ref,
        kind: 'new_group' as const,
        targetRef: null,
        suggestedName: names[Number(tab.ref.replace('tab-', '')) - 1100] ?? 'Reading',
        suggestedDescription: null,
        confidence: 0.9,
        reason: 'Proposed',
      })),
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'sized',
    );

    const proposal = await service.review('all');

    expect(proposal.changes).toHaveLength(4);
    expect(new Set(proposal.changes.map((change) => change.target.title))).toEqual(new Set(['Reading']));
    expect(proposal.unchangedCount).toBe(2);
  });

  it('still moves a single tab into a group that already exists', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = [
      { tabId: 1200, windowId: 15, title: 'A', url: 'https://a.test/p', groupId: -1, incognito: false },
    ];
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab) => ({
        tabRef: tab.ref, kind: 'existing_group' as const, targetRef: 'group-5',
        suggestedName: null, suggestedDescription: null, confidence: 0.9, reason: 'Fits Dev',
      })),
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [
        { groupId: 5, windowId: 15, ref: 'group-5', title: 'Dev', color: 'blue' },
      ],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'existing',
    );

    const proposal = await service.review('all');

    // The floor guards group creation, not membership: joining an existing group is always fine.
    expect(proposal.changes).toHaveLength(1);
    expect(proposal.changes[0]?.target).toMatchObject({ kind: 'existing_group', groupId: 5 });
  });

  it('merges new group proposals that differ only by case or surrounding space', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const casings = ['Shopping', ' shopping ', 'SHOPPING', 'Shopping', 'shopping ', ' Shopping'];
    const windowTabs: BrowserTab[] = casings.map((_, index) => ({
      tabId: index + 500,
      windowId: 7,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab) => ({
        tabRef: tab.ref,
        kind: 'new_group' as const,
        targetRef: null,
        suggestedName: casings[Number(tab.ref.replace('tab-', '')) - 500] ?? 'Shopping',
        suggestedDescription: null,
        confidence: 0.9,
        reason: 'Retail',
      })),
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'merged',
    );

    const proposal = await service.review('all');

    expect(proposal.changes).toHaveLength(6);
    expect(new Set(proposal.changes.map((change) => change.target.title)).size).toBe(1);
  });

  it('assigns a new group proposal to an existing group or preset with the same title', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = [
      { tabId: 601, windowId: 8, title: 'A', url: 'https://a.test/p', groupId: -1, incognito: false },
      { tabId: 602, windowId: 8, title: 'B', url: 'https://b.test/p', groupId: -1, incognito: false },
    ];
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab) => ({
        tabRef: tab.ref,
        kind: 'new_group' as const,
        targetRef: null,
        suggestedName: tab.ref === 'tab-601' ? '  dev  ' : 'WORK',
        suggestedDescription: null,
        confidence: 0.9,
        reason: 'Matches an existing target',
      })),
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [
        { groupId: 3, windowId: 8, ref: 'group-3', title: 'Dev', color: 'blue' },
      ],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const presets = new PresetStore(local, () => 'preset-work');
    await presets.create({ name: 'Work', description: 'Company work', cues: [], color: 'green' });
    const service = new SynchronizationService(
      classifier, presets, new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'demoted',
    );

    const proposal = await service.review('all');

    expect(proposal.changes.find((change) => change.tabId === 601)?.target).toMatchObject({
      kind: 'existing_group', groupId: 3, title: 'Dev',
    });
    expect(proposal.changes.find((change) => change.tabId === 602)?.target).toMatchObject({
      kind: 'preset', ref: 'preset-work', title: 'Work',
    });
  });

  it('leaves a tab unchanged when a new group title is outside the approved list', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    // Eight tabs so the size floor is satisfied and only the approved-list guard is under test.
    const windowTabs: BrowserTab[] = Array.from({ length: 8 }, (_, index) => ({
      tabId: index + 700,
      windowId: 9,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab) => ({
        tabRef: tab.ref,
        kind: 'new_group' as const,
        targetRef: null,
        suggestedName: Number(tab.ref.replace('tab-', '')) < 704 ? 'Reading' : 'Unapproved',
        suggestedDescription: null,
        confidence: 0.9,
        reason: 'Proposed',
      })),
    };
    const planner: TaxonomyPlanner = {
      plan: async () => [{ title: 'Reading', kind: 'new_group', ref: null }],
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'guarded',
      session, planner,
    );

    const proposal = await service.review('all');

    expect(proposal.changes).toHaveLength(4);
    expect(new Set(proposal.changes.map((change) => change.target.title))).toEqual(new Set(['Reading']));
    expect(proposal.unchangedCount).toBe(4);
  });

  it('plans a taxonomy once per window and gives every chunk the same approved titles', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = Array.from({ length: 12 }, (_, index) => ({
      tabId: index + 300,
      windowId: 5,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    const requests: ClassificationRequest[] = [];
    const classifier: Classifier = {
      classify: async (request) => {
        requests.push(request);
        return request.tabs.map((tab) => ({
          tabRef: tab.ref, kind: 'no_change' as const, targetRef: null, suggestedName: null,
          suggestedDescription: null, confidence: 0.5, reason: 'No change',
        }));
      },
    };
    const planRequests: TaxonomyRequest[] = [];
    const planner: TaxonomyPlanner = {
      plan: async (planRequest) => {
        planRequests.push(planRequest);
        return [
          { title: 'Dev', kind: 'existing_group', ref: 'group-9' },
          { title: 'Reading', kind: 'new_group', ref: null },
        ];
      },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [
        { groupId: 9, windowId: 5, ref: 'group-9', title: 'Dev', color: 'blue' },
      ],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'planned',
      session, planner,
    );

    await service.review('all');

    expect(planRequests).toHaveLength(1);
    expect(planRequests[0]?.tabs).toHaveLength(12);
    // Twelve tabs at the balanced floor of four leaves room for three groups, not ten.
    expect(planRequests[0]?.maxTitles).toBe(3);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.approvedGroupTitles).toEqual(['Dev', 'Reading']);
    }
  });

  it('retries the taxonomy pass once before giving up on approved titles', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = Array.from({ length: 7 }, (_, index) => ({
      tabId: index + 1000,
      windowId: 13,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    const requests: ClassificationRequest[] = [];
    const classifier: Classifier = {
      classify: async (request) => {
        requests.push(request);
        return request.tabs.map((tab) => ({
          tabRef: tab.ref, kind: 'no_change' as const, targetRef: null, suggestedName: null,
          suggestedDescription: null, confidence: 0.5, reason: 'No change',
        }));
      },
    };
    let planAttempts = 0;
    const planner: TaxonomyPlanner = {
      plan: async () => {
        planAttempts += 1;
        if (planAttempts === 1) throw new Error('taxonomy_invalid_response');
        return [{ title: 'Reading', kind: 'new_group', ref: null }];
      },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'replanned',
      session, planner,
    );

    await service.review('all');

    expect(planAttempts).toBe(2);
    expect(requests.every((request) => request.approvedGroupTitles?.[0] === 'Reading')).toBe(true);
  });

  it('falls back to unplanned chunks when the taxonomy pass fails', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = Array.from({ length: 7 }, (_, index) => ({
      tabId: index + 400,
      windowId: 6,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    const requests: ClassificationRequest[] = [];
    const classifier: Classifier = {
      classify: async (request) => {
        requests.push(request);
        return request.tabs.map((tab) => ({
          tabRef: tab.ref, kind: 'no_change' as const, targetRef: null, suggestedName: null,
          suggestedDescription: null, confidence: 0.5, reason: 'No change',
        }));
      },
    };
    const planner: TaxonomyPlanner = {
      plan: async () => { throw new Error('taxonomy_invalid_response'); },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'fallback',
      session, planner,
    );

    const proposal = await service.review('all');

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.approvedGroupTitles === undefined)).toBe(true);
    expect(proposal.unchangedCount).toBe(7);
  });

  it('bounds concurrent chunk requests and gives every chunk the same groups and presets', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = Array.from({ length: 40 }, (_, index) => ({
      tabId: index + 200,
      windowId: 5,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    let active = 0;
    let maxActive = 0;
    const requests: ClassificationRequest[] = [];
    const classifier: Classifier = {
      classify: async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        requests.push(request);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return request.tabs.map((tab) => ({
          tabRef: tab.ref, kind: 'no_change' as const, targetRef: null, suggestedName: null,
          suggestedDescription: null, confidence: 0.5, reason: 'No change',
        }));
      },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [
        { groupId: 9, windowId: 5, ref: 'group-9', title: 'Dev', color: 'blue' },
      ],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const presets = new PresetStore(local, () => 'preset-a');
    await presets.create({ name: 'Work', description: 'Company work', cues: [], color: 'green' });
    const service = new SynchronizationService(
      classifier, presets, new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'chunked',
    );

    const proposal = await service.review('all');

    expect(requests).toHaveLength(8);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(SYNCHRONIZATION_MAX_CONCURRENT_CHUNKS);
    for (const request of requests) {
      expect(request.groups).toEqual([{ ref: 'group-9', title: 'Dev', color: 'blue' }]);
      expect(request.presets.map((preset) => preset.name)).toEqual(['Work']);
    }
    expect(proposal.unchangedCount).toBe(40);
  });

  it('analyzes windows with bounded concurrency and merges results in window order', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const tabs: BrowserTab[] = [1, 2, 3].map((windowId) => ({
      tabId: windowId,
      windowId,
      title: `Window ${windowId}`,
      url: `https://window-${windowId}.test`,
      groupId: -1,
      incognito: false,
    }));
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const classifier: Classifier = {
      classify: async (request) => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        const windowId = Number(request.tabs[0]?.ref.replace('tab-', '') ?? '0');
        await new Promise<void>((resolve) => setTimeout(resolve, (4 - windowId) * 5));
        activeRequests -= 1;
        return request.tabs.map((tab) => ({
          tabRef: tab.ref,
          kind: 'new_group',
          targetRef: null,
          suggestedName: `Group ${windowId}`,
          suggestedDescription: null,
          confidence: 0.9,
          reason: 'Related',
        }));
      },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => tabs,
      listGroups: async () => [],
      getTab: async (tabId) => tabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history', () => 1), platform, () => 'en', () => 'ordered',
    );

    const proposal = await service.review('all');

    expect(maxActiveRequests).toBe(2);
    expect(proposal.changes.map((change) => change.windowId)).toEqual([1, 2, 3]);
  });

  it('skips a tab that the user locks after review and before apply', async () => {
    const { service, platform, locks, history } = createHarness();
    const proposal = await service.review('current');
    await locks.lock(4);

    const result = await service.apply(proposal.id, [4]);

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(platform.actions).toEqual([]);
    expect(await history.list()).toEqual([]);
  });

  it.each([
    { name: 'URL', patch: { url: 'https://a.test/other' } },
    { name: 'title', patch: { title: 'Different topic' } },
    { name: 'window', patch: { windowId: 11 } },
    { name: 'group', patch: { groupId: 9 } },
    { name: 'Split View', patch: { splitViewId: 4 } },
  ])('skips a tab whose $name changed after review', async ({ patch }) => {
    const { service, platform, history } = createHarness();
    const proposal = await service.review('current');
    platform.currentTabs = platform.currentTabs.map((tab) => tab.tabId === 4
      ? { ...tab, ...patch }
      : tab);

    const result = await service.apply(proposal.id, [4]);

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(platform.actions).toEqual([]);
    expect(await history.list()).toEqual([]);
  });

  it('batches existing-group and preset targets into one same-window group move', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const largeTabs: BrowserTab[] = Array.from({ length: 100 }, (_, index) => ({
      tabId: index + 1,
      windowId: 10,
      title: `Work ${index}`,
      url: `https://work.test/${index}`,
      groupId: -1,
      incognito: false,
    }));
    const group = {
      ref: 'group-7', groupId: 7, windowId: 10, title: 'Work', color: 'blue' as const,
    };
    const moveCalls: number[][] = [];
    let groupQueries = 0;
    const platform: SynchronizationPlatform = {
      listTabs: async () => largeTabs,
      listGroups: async () => { groupQueries += 1; return [group]; },
      getTab: async (tabId) => largeTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async (tabIds) => { moveCalls.push(tabIds); },
      moveToNewGroup: async () => { throw new Error('unexpected_new_group'); },
    };
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab, index) => ({
        tabRef: tab.ref,
        kind: index % 2 === 0 ? 'existing_group' as const : 'preset' as const,
        targetRef: index % 2 === 0 ? 'group-7' : 'preset-1',
        suggestedName: null,
        suggestedDescription: null,
        confidence: 0.95,
        reason: 'Work context',
      })),
    };
    const presets = new PresetStore(local, () => 'preset-1');
    await presets.create({ name: 'Work', description: 'Work tabs', cues: [], color: 'blue' });
    const service = new SynchronizationService(
      classifier,
      presets,
      new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history-1', () => 1),
      platform,
      () => 'en',
      () => 'proposal-1',
    );

    const proposal = await service.review('current');
    const result = await service.apply(proposal.id, largeTabs.map((tab) => tab.tabId));

    expect(result).toEqual({ applied: 100, skipped: 0 });
    expect(groupQueries).toBe(3);
    expect(moveCalls).toHaveLength(1);
    expect(moveCalls[0]).toHaveLength(100);
  });

  it('expires an unapplied proposal when a newer review replaces it', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    let nextId = 0;
    const service = new SynchronizationService(
      new RecordingClassifier(),
      new PresetStore(local, () => 'preset-1'),
      new TabLockStore(session, () => 1),
      new HistoryStore(local, () => 'history-1', () => 1),
      new RecordingPlatform(),
      () => 'en',
      () => `proposal-${nextId += 1}`,
    );

    const first = await service.review('current');
    await service.review('current');

    await expect(service.apply(first.id, [4])).rejects.toThrow('proposal_not_found');
  });

  it('rehydrates the latest proposal after service reconstruction', async () => {
    const { service, classifier, platform, locks, history, presets, session } = createHarness();
    const proposal = await service.review('current');
    const restarted = new SynchronizationService(
      classifier, presets, locks, history, platform, () => 'en', () => 'unused', session,
    );

    await expect(restarted.apply(proposal.id, [4])).resolves.toEqual({ applied: 1, skipped: 0 });
    expect(platform.actions).toEqual(['new:4:10:Suggested']);
  });

  it('coalesces duplicate apply requests for the same proposal', async () => {
    const { service, platform, history } = createHarness();
    const proposal = await service.review('current');
    const originalMove = platform.moveToNewGroup.bind(platform);
    let releaseMove: (() => void) | undefined;
    const moveGate = new Promise<void>((resolve) => { releaseMove = resolve; });
    let moveCalls = 0;
    platform.moveToNewGroup = async (...args) => {
      moveCalls += 1;
      await moveGate;
      return originalMove(...args);
    };

    const first = service.apply(proposal.id, [4]);
    await vi.waitFor(() => expect(moveCalls).toBe(1));
    const second = service.apply(proposal.id, [4]);
    releaseMove?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { applied: 1, skipped: 0 },
      { applied: 1, skipped: 0 },
    ]);
    expect(moveCalls).toBe(1);
    expect(await history.list()).toHaveLength(1);
  });

  it('continues independent group mutations and records a partial operation after one fails', async () => {
    const { service, platform, history } = createHarness();
    const proposal = await service.review('all');
    const move = platform.moveToNewGroup.bind(platform);
    platform.moveToNewGroup = async (tabIds, windowId, title) => {
      if (windowId === 20) throw new Error('group_move_failed');
      return move(tabIds, windowId, title);
    };

    const result = await service.apply(proposal.id, [4, 5]);

    expect(result).toEqual({ applied: 1, skipped: 1 });
    expect(platform.actions).toEqual(['new:4:10:Suggested']);
    expect(await history.list()).toMatchObject([{
      status: 'partial',
      tabs: [
        { tabId: 4, expectedGroup: { title: 'Suggested', color: 'grey' } },
        { tabId: 5, expectedGroup: { title: 'Suggested', color: 'grey' } },
      ],
    }]);
  });

  it('revalidates locks immediately before each group mutation bucket', async () => {
    const { service, platform, locks, history } = createHarness();
    const proposal = await service.review('all');
    const move = platform.moveToNewGroup.bind(platform);
    platform.moveToNewGroup = async (tabIds, windowId, title) => {
      const groupId = await move(tabIds, windowId, title);
      if (windowId === 10) await locks.lock(5);
      return groupId;
    };

    const result = await service.apply(proposal.id, [4, 5]);

    expect(result).toEqual({ applied: 1, skipped: 1 });
    expect(platform.actions).toEqual(['new:4:10:Suggested']);
    expect(await history.list()).toMatchObject([{ status: 'partial' }]);
  });

  it('serializes review behind an in-progress apply', async () => {
    const { service, classifier, platform } = createHarness();
    const proposal = await service.review('current');
    let releaseMove: (() => void) | undefined;
    let notifyMoveStarted: (() => void) | undefined;
    const moveStarted = new Promise<void>((resolve) => { notifyMoveStarted = resolve; });
    const moveGate = new Promise<void>((resolve) => { releaseMove = resolve; });
    const originalMove = platform.moveToNewGroup.bind(platform);
    platform.moveToNewGroup = async (...args) => {
      notifyMoveStarted?.();
      await moveGate;
      return originalMove(...args);
    };

    const apply = service.apply(proposal.id, [4]);
    await moveStarted;
    const review = service.review('current');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(classifier.requests).toHaveLength(1);

    releaseMove?.();
    await apply;
    await review;
    expect(classifier.requests).toHaveLength(2);
  });

  it('persists the actual new Chrome group ID before completing history', async () => {
    const { service, history } = createHarness();
    const proposal = await service.review('current');

    await service.apply(proposal.id, [4]);

    expect(await history.list()).toMatchObject([{
      status: 'completed',
      tabs: [{ expectedGroup: { groupId: 77, title: 'Suggested', color: 'grey' } }],
    }]);
  });

  it('reports a successful move as applied when exact history group ID enrichment fails', async () => {
    const { service, history, platform } = createHarness();
    const proposal = await service.review('current');
    history.setExpectedGroupId = async () => {
      throw new Error('storage_unavailable');
    };

    await expect(service.apply(proposal.id, [4])).resolves.toEqual({
      applied: 1,
      skipped: 0,
    });

    expect(platform.actions).toEqual(['new:4:10:Suggested']);
    expect(await history.list()).toMatchObject([{
      status: 'completed',
      tabs: [{ expectedGroup: { title: 'Suggested', color: 'grey' } }],
    }]);
  });

  it('does not create a proposal, history, or tab mutation when classification fails', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const platform = new RecordingPlatform();
    const history = new HistoryStore(local, () => 'history-1', () => 1);
    const service = new SynchronizationService(
      { classify: async () => { throw new Error('classification_failed'); } },
      new PresetStore(local, () => 'preset-1'),
      new TabLockStore(session, () => 1),
      history,
      platform,
      () => 'en',
      () => 'proposal-1',
      session,
    );

    await expect(service.review('all')).rejects.toThrow('classification_failed');

    expect(platform.actions).toEqual([]);
    expect(await history.list()).toEqual([]);
    expect(session.values.synchronizationProposal).toBeUndefined();
  });
});
