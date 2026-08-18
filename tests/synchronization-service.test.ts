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
  preferredGroupColor,
  SYNCHRONIZATION_CHUNK_SIZE,
  SYNCHRONIZATION_MAX_CONCURRENT_CHUNKS,
  SynchronizationService,
  type BrowserTab,
  type SynchronizationPlatform,
} from '../src/background/synchronization-service';
import { TabLockStore } from '../src/background/tab-lock-store';
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

  /** Which tab Chrome would report as active, when a review asks for that scope only. */
  activeTabId = 4;

  async listTabs(scope: 'all' | 'current' | 'active') {
    const openTabs = this.currentTabs.filter((tab) => !this.closedTabs.has(tab.tabId));
    if (scope === 'active') return openTabs.filter((tab) => tab.tabId === this.activeTabId);
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
  const placements = new TabPlacementStore(session);
  const service = new SynchronizationService(
    classifier, presets, locks, platform, () => 'en', () => 'proposal-1', session,
    undefined, undefined, undefined, () => false, undefined, placements,
  );
  return { service, classifier, platform, locks, presets, session, placements };
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
    const { service, classifier, platform } = createHarness();
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
    expect(result).toEqual({ applied: 1, skipped: 1, sortOutcome: null });
    expect(platform.actions).toEqual(['new:4:10:Suggested']);
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

  it('gives each new group its own color and keeps it across runs', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = [
      { tabId: 31, windowId: 10, title: 'Docs one', url: 'https://docs.test/1', groupId: -1, incognito: false },
      { tabId: 32, windowId: 10, title: 'Api one', url: 'https://api.test/1', groupId: -1, incognito: false },
      { tabId: 33, windowId: 10, title: 'News one', url: 'https://news.test/1', groupId: -1, incognito: false },
    ];
    const names: Record<number, string> = { 31: 'Docs', 32: 'API', 33: 'Reading' };
    const classifier: Classifier = {
      classify: async (request) => request.tabs.map((tab) => ({
        tabRef: tab.ref,
        kind: 'new_group' as const,
        targetRef: null,
        suggestedName: names[parseInt(tab.ref.replace('tab-', ''), 10)] ?? 'Other',
        suggestedDescription: 'Related',
        confidence: 0.9,
        reason: 'Same topic',
      })),
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      // One group already occupies the color 'Docs' would prefer.
      listGroups: async () => [{
        groupId: 700, windowId: 10, ref: 'group-700', title: 'Existing',
        color: preferredGroupColor('Docs'),
      }],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const build = () => new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      platform, () => 'en', () => 'colors',
    );

    const proposal = await build().review('current');
    const colors = proposal.changes.map((change) => change.target.color);

    // Distinct from each other, and none of them grey, which is what an untouched group looks like.
    expect(new Set(colors).size).toBe(colors.length);
    expect(colors).not.toContain('grey');
    // The color already on screen is left to the group that has it.
    expect(colors).not.toContain(preferredGroupColor('Docs'));

    // The same titles reviewed again produce the same colors, so a group does not change color
    // every time the user runs a review.
    const second = await build().review('current');
    expect(second.changes.map((change) => change.target.color)).toEqual(colors);
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
      platform, () => 'en', () => 'dedup',
      session,
    );

    const proposal = await service.review('current');
    const result = await service.apply(proposal.id, [21, 22]);

    expect(result).toEqual({ applied: 2, skipped: 0, sortOutcome: null });
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
      platform, () => 'en', () => 'chunked',
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
      platform, () => 'en', () => 'large',
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
      platform, () => 'en', () => 'isolated',
    );

    const proposal = await service.review('all');

    // 3 chunks: the failing one is attempted twice, the other two once each.
    expect(attempts).toBe(4);
    expect(proposal.changes).toHaveLength(7);
    // Naming them is what lets a user see which tabs went unreviewed.
    expect(proposal.failedTabs).toHaveLength(5);
    expect(proposal.failedTabs.some((failed) => failed.tabId === 800)).toBe(true);
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
      platform, () => 'en', () => 'retried',
    );

    const proposal = await service.review('all');

    expect(proposal.changes).toHaveLength(6);
    expect(proposal.failedTabs).toEqual([]);
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
      platform, () => 'en', () => 'paths',
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
      platform, () => 'en', () => 'cued',
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
      platform, () => 'en', () => 'specific',
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
      platform, () => 'en', () => 'sized',
    );

    const proposal = await service.review('all');

    expect(proposal.changes).toHaveLength(4);
    expect(new Set(proposal.changes.map((change) => change.target.title))).toEqual(new Set(['Reading']));
    expect(proposal.unchangedCount).toBe(2);
    // Two tabs staying put is indistinguishable from two tabs nothing matched, unless the run says
    // which group it refused to create and what the floor was.
    expect(proposal.skippedGroups).toEqual([
      { title: 'Odds', tabCount: 2, reason: 'too_few_tabs', minimumTabs: 3 },
    ]);
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
      platform, () => 'en', () => 'existing',
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
      platform, () => 'en', () => 'merged',
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
      platform, () => 'en', () => 'demoted',
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
      platform, () => 'en', () => 'guarded',
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
      platform, () => 'en', () => 'planned',
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
      platform, () => 'en', () => 'replanned',
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
      platform, () => 'en', () => 'fallback',
      session, planner,
    );

    const proposal = await service.review('all');

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.approvedGroupTitles === undefined)).toBe(true);
    expect(proposal.unchangedCount).toBe(7);
  });

  /**
   * Reviews eight tabs in one window against a fixed plan, with each tab's proposed group name
   * supplied by the caller. Eight tabs keeps the taxonomy pass on and the balanced floor at four.
   */
  const reviewAgainstPlan = async (
    plannedTitles: string[],
    proposedNames: string[],
  ) => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = proposedNames.map((_, index) => ({
      tabId: index + 1500,
      windowId: 21,
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
        suggestedName: proposedNames[Number(tab.ref.replace('tab-', '')) - 1500] ?? 'Unnamed',
        suggestedDescription: null,
        confidence: 0.9,
        reason: 'Proposed',
      })),
    };
    const planner: TaxonomyPlanner = {
      plan: async () => plannedTitles.map((title) => ({
        title, kind: 'new_group' as const, ref: null,
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
      platform, () => 'en', () => 'planned',
      session, planner,
    );
    return service.review('all');
  };

  it('takes a grouped tab back into the review once it has navigated elsewhere', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = [
      { tabId: 1, windowId: 8, title: 'Still here', url: 'https://a.test/x', groupId: 5, incognito: false },
      { tabId: 2, windowId: 8, title: 'Moved on', url: 'https://sandy.test/x', groupId: 5, incognito: false },
    ];
    const classifier = new RecordingClassifier();
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [
        { groupId: 5, windowId: 8, ref: 'group-5', title: 'Settled', color: 'blue' },
      ],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const placements = new TabPlacementStore(session);
    // Both were grouped as a.test pages; only one still is.
    await placements.record([
      { tabId: 1, hostname: 'a.test' },
      { tabId: 2, hostname: 'a.test' },
    ]);
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      platform, () => 'en', () => 'drift', session, undefined, undefined, undefined,
      () => false, undefined, placements,
    );

    await service.review('ungrouped');

    expect(classifier.requests[0]?.tabs.map((tab) => tab.title)).toEqual(['Moved on']);
  });

  it('records where each tab was pointed when it was grouped', async () => {
    const { service, placements } = createHarness();
    const proposal = await service.review('current');

    await service.apply(proposal.id, [4]);

    // Without this the next everyday review has no way to tell that a grouped tab moved on.
    expect(await placements.list()).toEqual([{ tabId: 4, hostname: 'a.test' }]);
  });

  it('leaves settled groups out of a review, sending only the tabs with no group', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = [
      { tabId: 1, windowId: 8, title: 'Grouped A', url: 'https://a.test/x', groupId: 5, incognito: false },
      { tabId: 2, windowId: 8, title: 'Grouped B', url: 'https://b.test/x', groupId: 5, incognito: false },
      { tabId: 3, windowId: 8, title: 'Loose C', url: 'https://c.test/x', groupId: -1, incognito: false },
      { tabId: 4, windowId: 8, title: 'Loose D', url: 'https://d.test/x', groupId: -1, incognito: false },
    ];
    const classifier = new RecordingClassifier();
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [
        { groupId: 5, windowId: 8, ref: 'group-5', title: 'Settled', color: 'blue' },
      ],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      classifier, new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      platform, () => 'en', () => 'ungrouped', session,
    );

    const proposal = await service.review('ungrouped');

    // Grouped tabs are the settled part of a window: sending them costs requests and invites the
    // model to undo a grouping the user is happy with.
    expect(classifier.requests[0]?.tabs.map((tab) => tab.title)).toEqual(['Loose C', 'Loose D']);
    // The groups themselves are still offered as targets.
    expect(classifier.requests[0]?.groups.map((group) => group.title)).toEqual(['Settled']);
    expect(proposal.scope).toBe('ungrouped');
  });

  it('reviews the active tab alone, and creates its group despite the size floor', async () => {
    const { service, classifier } = createHarness();

    const proposal = await service.review('active');

    // One request for one tab, instead of a request per five tabs across the window.
    expect(classifier.requests).toHaveLength(1);
    expect(classifier.requests[0]?.tabs.map((tab) => tab.ref)).toEqual(['tab-4']);
    expect(proposal.scope).toBe('active');
    // The floor exists to stop a bulk run fragmenting a window, not to veto an explicit request.
    expect(proposal.changes.map((change) => change.tabId)).toEqual([4]);
    expect(proposal.skippedGroups).toEqual([]);
  });

  it('sorts the windows it touched, but only when the setting asks for it', async () => {
    const createSortingHarness = (sortEnabled: boolean) => {
      const local = new MemoryStorage();
      const session = new MemoryStorage();
      const platform = new RecordingPlatform();
      const moves: string[] = [];
      const tabOrder = {
        listWindowTabs: async (windowId: number) => platform.currentTabs
          .filter((tab) => tab.windowId === windowId)
          .map((tab, index) => ({
            tabId: tab.tabId, index, pinned: false, groupId: -1, title: tab.title,
          })),
        moveTabs: async (tabIds: number[], index: number) => { moves.push(`tab:${tabIds.join(',')}:${index}`); },
        moveGroup: async (groupId: number, index: number) => { moves.push(`group:${groupId}:${index}`); },
      };
      const service = new SynchronizationService(
        new RecordingClassifier(), new PresetStore(local, () => 'preset'),
        new TabLockStore(session, () => 1),
        platform, () => 'en', () => 'sorted', session, undefined, undefined, undefined,
        () => sortEnabled, tabOrder,
      );
      return { service, moves };
    };

    const off = createSortingHarness(false);
    const offProposal = await off.service.review('current');
    await off.service.apply(offProposal.id, [3, 4]);

    // Default is off, and an extension that rearranges a window nobody asked it to is a bad guest.
    expect(off.moves).toEqual([]);

    const on = createSortingHarness(true);
    const onProposal = await on.service.review('current');
    await on.service.apply(onProposal.id, [3, 4]);

    expect(on.moves.length).toBeGreaterThan(0);
  });

  it('sorts a window whose changes all fell away, since the request was to sort it', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const platform = new RecordingPlatform();
    const moves: string[] = [];
    const tabOrder = {
      listWindowTabs: async (windowId: number) => platform.currentTabs
        .filter((tab) => tab.windowId === windowId)
        .map((tab, index) => ({
          tabId: tab.tabId, index, pinned: false, groupId: -1, title: tab.title,
        })),
      moveTabs: async (tabIds: number[], index: number) => { moves.push(`tab:${tabIds.join(',')}:${index}`); },
      moveGroup: async () => undefined,
    };
    const service = new SynchronizationService(
      new RecordingClassifier(), new PresetStore(local, () => 'preset'),
      new TabLockStore(session, () => 1),
      platform, () => 'en', () => 'stale', session, undefined, undefined, undefined,
      () => true, tabOrder,
    );
    const proposal = await service.review('current');
    // Everything the user selected moved elsewhere before Apply landed.
    platform.closedTabs.add(3);
    platform.closedTabs.add(4);

    const result = await service.apply(proposal.id, [3, 4]);

    expect(result).toMatchObject({ applied: 0 });
    expect(moves.length).toBeGreaterThan(0);
  });

  it('sorts a window that holds a Split View pair, moving the pair as one block', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const platform = new RecordingPlatform();
    const moves: string[] = [];
    const tabOrder = {
      listWindowTabs: async (windowId: number) => platform.currentTabs
        .filter((tab) => tab.windowId === windowId)
        .map((tab, index) => ({
          tabId: tab.tabId,
          index,
          pinned: false,
          groupId: -1,
          title: tab.title,
          // Tab 3 of the fixture window sits in Split View.
          ...(tab.tabId === 3 ? { splitViewId: 7 } : {}),
        })),
      moveTabs: async (tabIds: number[], index: number) => { moves.push(`tab:${tabIds.join(',')}:${index}`); },
      moveGroup: async () => undefined,
    };
    const service = new SynchronizationService(
      new RecordingClassifier(), new PresetStore(local, () => 'preset'),
      new TabLockStore(session, () => 1),
      platform, () => 'en', () => 'split', session, undefined, undefined, undefined,
      () => true, tabOrder,
    );
    const proposal = await service.review('current');

    const result = await service.apply(proposal.id, [4]);

    // Skipping the window was the old answer, and it left everything else unsorted too.
    expect(result.sortOutcome).toBeNull();
    expect(moves.some((move) => move.startsWith('tab:3:'))).toBe(true);
  });

  it('keeps sorting the rest of a window after Chrome refuses one move', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const platform = new RecordingPlatform();
    const moves: string[] = [];
    const tabOrder = {
      listWindowTabs: async (windowId: number) => platform.currentTabs
        .filter((tab) => tab.windowId === windowId)
        .map((tab, index) => ({
          tabId: tab.tabId, index, pinned: false, groupId: -1, title: tab.title,
        })),
      moveTabs: async (tabIds: number[], index: number) => {
        // One refusal used to abandon the window, leaving a half-sorted strip and no explanation.
        if (tabIds.includes(3)) throw new Error('Tabs cannot be edited right now');
        moves.push(`tab:${tabIds.join(',')}:${index}`);
      },
      moveGroup: async () => undefined,
    };
    const service = new SynchronizationService(
      new RecordingClassifier(), new PresetStore(local, () => 'preset'),
      new TabLockStore(session, () => 1),
      platform, () => 'en', () => 'refused', session, undefined, undefined, undefined,
      () => true, tabOrder,
    );
    const proposal = await service.review('current');

    const result = await service.apply(proposal.id, [4]);

    expect(result.sortOutcome).toBe('move_refused');
    expect(moves.length).toBeGreaterThan(0);
  });

  it('reports a run as in flight only while it is actually running', async () => {
    const { service } = createHarness();

    expect(service.isReviewing()).toBe(false);

    const pending = service.review('current');
    // A popup that opens here has no proposal to show yet, and needs to know why.
    expect(service.isReviewing()).toBe(true);

    await pending;

    expect(service.isReviewing()).toBe(false);
  });

  it('stops reporting a run as in flight once it has failed', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const service = new SynchronizationService(
      { classify: async () => { throw new Error('classification_failed'); } },
      new PresetStore(local, () => 'preset'), new TabLockStore(session, () => 1),
      new RecordingPlatform(),
      () => 'en', () => 'failed', session,
    );

    await expect(service.review('all')).rejects.toThrow('classification_failed');

    // A stuck flag would leave the popup spinning on a run that ended.
    expect(service.isReviewing()).toBe(false);
  });

  it('keeps a review that finished after its caller stopped waiting', async () => {
    // The interface tells the user the popup can be closed mid-run. That only holds if the result
    // is retrievable afterwards rather than delivered to whoever asked.
    const { service, session } = createHarness();

    const pending = service.review('current');
    const proposal = await pending;

    expect(session.values.synchronizationProposal).toBeDefined();
    expect(await service.latestProposal()).toMatchObject({ id: proposal.id });
  });

  it('reports why a run had no plan, because chunk-by-chunk naming fragments the window', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = Array.from({ length: 8 }, (_, index) => ({
      tabId: index + 1700,
      windowId: 22,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
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
      new RecordingClassifier(), new PresetStore(local, () => 'preset'),
      new TabLockStore(session, () => 1),
      platform, () => 'en', () => 'unplanned', session, planner,
    );

    const proposal = await service.review('all');

    expect(proposal.planFailureReason).toBe('taxonomy_invalid_response');
  });

  it('does not spend a second plan attempt on a request that ran out of time', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = Array.from({ length: 8 }, (_, index) => ({
      tabId: index + 1900,
      windowId: 24,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    let planCalls = 0;
    const planner: TaxonomyPlanner = {
      plan: async () => {
        planCalls += 1;
        // What Chrome reports once the request controller aborts.
        throw new Error('signal is aborted without reason');
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
      new RecordingClassifier(), new PresetStore(local, () => 'preset'),
      new TabLockStore(session, () => 1),
      platform, () => 'en', () => 'timed-out', session, planner,
    );

    const proposal = await service.review('all');

    // Retrying doubles the wait for a plan the same request will not deliver.
    expect(planCalls).toBe(1);
    expect(proposal.planFailureReason).toBe('signal is aborted without reason');
  });

  it('reports a plan that came back empty separately from one that threw', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const windowTabs: BrowserTab[] = Array.from({ length: 8 }, (_, index) => ({
      tabId: index + 1800,
      windowId: 23,
      title: `Tab ${index}`,
      url: `https://host-${index}.test/page`,
      groupId: -1,
      incognito: false,
    }));
    let planCalls = 0;
    const planner: TaxonomyPlanner = {
      plan: async () => { planCalls += 1; return []; },
    };
    const platform: SynchronizationPlatform = {
      listTabs: async () => windowTabs,
      listGroups: async () => [],
      getTab: async (tabId) => windowTabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToNewGroup: async () => 1,
    };
    const service = new SynchronizationService(
      new RecordingClassifier(), new PresetStore(local, () => 'preset'),
      new TabLockStore(session, () => 1),
      platform, () => 'en', () => 'empty-plan', session, planner,
    );

    const proposal = await service.review('all');

    expect(proposal.planFailureReason).toBe('taxonomy_empty_plan');
    // An empty plan is an answer, not a transport failure, so it is not retried.
    expect(planCalls).toBe(1);
  });

  it('folds a variant of a planned title onto the planned one instead of dropping the tabs', async () => {
    const proposal = await reviewAgainstPlan(
      ['ForgeHub'],
      Array.from({ length: 8 }, () => 'ForgeHub Iter 1'),
    );

    expect(proposal.changes).toHaveLength(8);
    expect(new Set(proposal.changes.map((change) => change.target.title))).toEqual(new Set(['ForgeHub']));
    expect(proposal.skippedGroups).toEqual([]);
    expect(proposal.planFailureReason).toBeNull();
  });

  it('counts variants of one planned title together when deciding the group is worth creating', async () => {
    // Neither variant reaches the floor of four on its own; the concept they share does.
    const proposal = await reviewAgainstPlan(
      ['ForgeHub'],
      ['ForgeHub Iter 1', 'ForgeHub Iter 1', 'ForgeHub docs', 'ForgeHub docs',
        'Weekly digest', 'Weekly digest', 'Weekly digest', 'Weekly digest'],
    );

    expect(proposal.changes.map((change) => change.target.title)).toEqual([
      'ForgeHub', 'ForgeHub', 'ForgeHub', 'ForgeHub',
    ]);
    expect(proposal.skippedGroups).toEqual([
      { title: 'Weekly digest', tabCount: 4, reason: 'not_in_plan', minimumTabs: null },
    ]);
    expect(proposal.unchangedCount).toBe(4);
  });

  it('refuses a title that only shares part of a word with a planned one', async () => {
    const proposal = await reviewAgainstPlan(['ForgeHub'], Array.from({ length: 8 }, () => 'Hub'));

    expect(proposal.changes).toEqual([]);
    expect(proposal.skippedGroups).toEqual([
      { title: 'Hub', tabCount: 8, reason: 'not_in_plan', minimumTabs: null },
    ]);
  });

  it('leaves tabs alone when two planned titles match a proposal equally well', async () => {
    const proposal = await reviewAgainstPlan(
      ['Docs', 'News'],
      Array.from({ length: 8 }, () => 'Docs News'),
    );

    expect(proposal.changes).toEqual([]);
    expect(proposal.skippedGroups).toEqual([
      { title: 'Docs News', tabCount: 8, reason: 'not_in_plan', minimumTabs: null },
    ]);
  });

  it('reads a proposal stored before skipped groups existed', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const stored = {
      proposal: {
        id: 'legacy', scope: 'current', unchangedCount: 1, failedTabCount: 0,
        changes: [{
          tabId: 4, windowId: 10, title: 'Normal A', hostname: 'a.test', currentGroup: null,
          currentGroupId: -1, confidence: 0.8, reason: 'Similar titles', selected: true,
          blockedReason: null, splitViewId: null,
          target: {
            kind: 'new_group', ref: null, groupId: null, title: 'Reading', color: 'blue',
            description: null,
          },
        }],
      },
      reviewedUrls: { '4': 'https://a.test/page' },
    };
    session.values.synchronizationProposal = stored;
    const service = new SynchronizationService(
      new RecordingClassifier(), new PresetStore(local, () => 'preset'),
      new TabLockStore(session, () => 1),
      new RecordingPlatform(), () => 'en', () => 'proposal-1', session,
    );

    // An update must not throw away a review the user is in the middle of.
    expect(await service.latestProposal()).toMatchObject({ id: 'legacy', skippedGroups: [] });
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
      platform, () => 'en', () => 'chunked',
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
      platform, () => 'en', () => 'ordered',
    );

    const proposal = await service.review('all');

    expect(maxActiveRequests).toBe(2);
    expect(proposal.changes.map((change) => change.windowId)).toEqual([1, 2, 3]);
  });

  it('skips a tab that the user locks after review and before apply', async () => {
    const { service, platform, locks } = createHarness();
    const proposal = await service.review('current');
    await locks.lock(4);

    const result = await service.apply(proposal.id, [4]);

    expect(result).toEqual({ applied: 0, skipped: 1, sortOutcome: null });
    expect(platform.actions).toEqual([]);
  });

  it.each([
    { name: 'URL', patch: { url: 'https://a.test/other' } },
    { name: 'title', patch: { title: 'Different topic' } },
    { name: 'window', patch: { windowId: 11 } },
    { name: 'group', patch: { groupId: 9 } },
    { name: 'Split View', patch: { splitViewId: 4 } },
  ])('skips a tab whose $name changed after review', async ({ patch }) => {
    const { service, platform } = createHarness();
    const proposal = await service.review('current');
    platform.currentTabs = platform.currentTabs.map((tab) => tab.tabId === 4
      ? { ...tab, ...patch }
      : tab);

    const result = await service.apply(proposal.id, [4]);

    expect(result).toEqual({ applied: 0, skipped: 1, sortOutcome: null });
    expect(platform.actions).toEqual([]);
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
      platform,
      () => 'en',
      () => 'proposal-1',
    );

    const proposal = await service.review('current');
    const result = await service.apply(proposal.id, largeTabs.map((tab) => tab.tabId));

    expect(result).toEqual({ applied: 100, skipped: 0, sortOutcome: null });
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
      new RecordingPlatform(),
      () => 'en',
      () => `proposal-${nextId += 1}`,
    );

    const first = await service.review('current');
    await service.review('current');

    await expect(service.apply(first.id, [4])).rejects.toThrow('proposal_not_found');
  });

  it('rehydrates the latest proposal after service reconstruction', async () => {
    const { service, classifier, platform, locks, presets, session } = createHarness();
    const proposal = await service.review('current');
    const restarted = new SynchronizationService(
      classifier, presets, locks, platform, () => 'en', () => 'unused', session,
    );

    await expect(restarted.apply(proposal.id, [4])).resolves.toEqual({ applied: 1, skipped: 0, sortOutcome: null });
    expect(platform.actions).toEqual(['new:4:10:Suggested']);
  });

  it('coalesces duplicate apply requests for the same proposal', async () => {
    const { service, platform } = createHarness();
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
      { applied: 1, skipped: 0, sortOutcome: null },
      { applied: 1, skipped: 0, sortOutcome: null },
    ]);
    expect(moveCalls).toBe(1);
  });

  it('continues independent group mutations and records a partial operation after one fails', async () => {
    const { service, platform } = createHarness();
    const proposal = await service.review('all');
    const move = platform.moveToNewGroup.bind(platform);
    platform.moveToNewGroup = async (tabIds, windowId, title) => {
      if (windowId === 20) throw new Error('group_move_failed');
      return move(tabIds, windowId, title);
    };

    const result = await service.apply(proposal.id, [4, 5]);

    expect(result).toEqual({ applied: 1, skipped: 1, sortOutcome: null });
    expect(platform.actions).toEqual(['new:4:10:Suggested']);
  });

  it('revalidates locks immediately before each group mutation bucket', async () => {
    const { service, platform, locks } = createHarness();
    const proposal = await service.review('all');
    const move = platform.moveToNewGroup.bind(platform);
    platform.moveToNewGroup = async (tabIds, windowId, title) => {
      const groupId = await move(tabIds, windowId, title);
      if (windowId === 10) await locks.lock(5);
      return groupId;
    };

    const result = await service.apply(proposal.id, [4, 5]);

    expect(result).toEqual({ applied: 1, skipped: 1, sortOutcome: null });
    expect(platform.actions).toEqual(['new:4:10:Suggested']);
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


  it('does not create a proposal, history, or tab mutation when classification fails', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const platform = new RecordingPlatform();
    const service = new SynchronizationService(
      { classify: async () => { throw new Error('classification_failed'); } },
      new PresetStore(local, () => 'preset-1'),
      new TabLockStore(session, () => 1),
      platform,
      () => 'en',
      () => 'proposal-1',
      session,
    );

    await expect(service.review('all')).rejects.toThrow('classification_failed');

    expect(platform.actions).toEqual([]);
    expect(session.values.synchronizationProposal).toBeUndefined();
  });
});
