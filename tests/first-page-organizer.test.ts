import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FirstPageOrganizer,
  type OrganizableTab,
  type TabGroupingPlatform,
} from '../src/background/first-page-organizer';
import type {
  ClassificationDecision,
  ClassificationRequest,
  Classifier,
} from '../src/background/classifier';
import { PresetStore } from '../src/background/preset-store';
import { TabLockStore } from '../src/background/tab-lock-store';
import { TabPlacementStore } from '../src/background/tab-placement-store';
import type { LocalStorageArea, StoredValues } from '../src/background/settings-service';
import { SettingsService } from '../src/background/settings-service';
import {
  ChromeSynchronizationPlatform,
  ChromeFirstPagePlatform,
  registerTabLifecycle,
} from '../src/background/chrome-platform';

class MemoryStorage implements LocalStorageArea {
  readonly values: StoredValues = {};

  async get(keys: readonly string[]): Promise<StoredValues> {
    return Object.fromEntries(
      keys.filter((key) => key in this.values).map((key) => [key, this.values[key]]),
    );
  }

  async set(items: StoredValues): Promise<void> {
    Object.assign(this.values, items);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      delete this.values[key];
    }
  }
}

class RecordingClassifier implements Classifier {
  readonly requests: ClassificationRequest[] = [];

  constructor(private decision: ClassificationDecision | Error) {}

  setDecision(decision: ClassificationDecision) {
    this.decision = decision;
  }

  async classify(request: ClassificationRequest): Promise<ClassificationDecision[]> {
    this.requests.push(request);
    if (this.decision instanceof Error) {
      throw this.decision;
    }
    return [{ ...this.decision, tabRef: request.tabs[0]?.ref ?? '' }];
  }
}

class RecordingPlatform implements TabGroupingPlatform {
  readonly moves: Array<{ tabId: number; target: string }> = [];
  currentTab: OrganizableTab | null = eligibleTab;

  async listGroups() {
    return [{ ref: 'group-7', groupId: 7, windowId: 3, title: 'Apollo', color: 'blue' as const }];
  }

  async getTab(): Promise<OrganizableTab | null> {
    return this.currentTab === null ? null : { ...this.currentTab };
  }

  async moveToExistingGroup(tabId: number, groupId: number): Promise<void> {
    this.moves.push({ tabId, target: `group-${groupId}` });
  }

  async moveToPreset(tabId: number, windowId: number, presetId: string): Promise<void> {
    this.moves.push({ tabId, target: `${windowId}:${presetId}` });
  }
}

const eligibleTab: OrganizableTab = {
  tabId: 42,
  windowId: 3,
  title: 'Apollo billing dashboard',
  url: 'https://billing.example.test/dashboard?secret=one',
  groupId: -1,
  incognito: false,
  status: 'complete',
  restored: false,
};

function createHarness(decision: ClassificationDecision | Error) {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const classifier = new RecordingClassifier(decision);
  const platform = new RecordingPlatform();
  const presets = new PresetStore(local, () => 'preset-1');
  const locks = new TabLockStore(session, () => 100);
  const organizer = new FirstPageOrganizer(
    session,
    async () => classifier,
    presets,
    locks,
    platform,
    () => 'en',
  );
  return { organizer, classifier, platform, presets, locks, session };
}

const existingDecision: ClassificationDecision = {
  tabRef: 'unused',
  kind: 'existing_group',
  targetRef: 'group-7',
  suggestedName: null,
  suggestedDescription: null,
  confidence: 0.96,
  reason: 'Matches Apollo',
};

describe('FirstPageOrganizer', () => {
  it('waits through blank, organizes the first eligible page once, and ignores later navigation', async () => {
    const { organizer, classifier, platform } = createHarness(existingDecision);
    await organizer.registerCreated({ ...eligibleTab, title: '', url: 'about:blank' });

    await expect(
      organizer.handleStable({ ...eligibleTab, title: '', url: 'about:blank' }),
    ).resolves.toMatchObject({ status: 'pending' });
    await expect(organizer.handleStable(eligibleTab)).resolves.toMatchObject({
      status: 'completed',
      result: 'moved',
    });
    await organizer.handleStable({
      ...eligibleTab,
      title: 'Unrelated page',
      url: 'https://unrelated.example.test',
    });

    expect(classifier.requests).toHaveLength(1);
    expect(platform.moves).toEqual([{ tabId: 42, target: 'group-7' }]);
    expect(classifier.requests[0]?.tabs).toEqual([
      {
        ref: 'tab-42',
        title: 'Apollo billing dashboard',
        hostname: 'billing.example.test',
        currentGroup: null,
      },
    ]);
    expect(JSON.stringify(classifier.requests[0])).not.toContain('/dashboard');
    expect(JSON.stringify(classifier.requests[0])).not.toContain('secret=one');
  });

  it('organizes a direct URL tab without requiring a blank transition', async () => {
    const { organizer, classifier } = createHarness(existingDecision);

    await organizer.registerCreated(eligibleTab);
    await organizer.handleStable(eligibleTab);

    expect(classifier.requests).toHaveLength(1);
  });

  it('coalesces concurrent stable events for the same tab', async () => {
    const { organizer, classifier, platform } = createHarness(existingDecision);
    await organizer.registerCreated(eligibleTab);

    const outcomes = await Promise.all([
      organizer.handleStable(eligibleTab),
      organizer.handleStable(eligibleTab),
    ]);

    expect(outcomes).toEqual([
      { status: 'completed', result: 'moved' },
      { status: 'completed', result: 'moved' },
    ]);
    expect(classifier.requests).toHaveLength(1);
    expect(platform.moves).toHaveLength(1);
  });

  it('batches one hundred near-simultaneous tabs by window and bounds classifier concurrency', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const tabs: OrganizableTab[] = Array.from({ length: 100 }, (_, index) => ({
      ...eligibleTab,
      tabId: index + 1,
      windowId: (index % 4) + 1,
      title: `Tab ${index + 1}`,
      url: `https://host-${index + 1}.test/page`,
    }));
    const requests: ClassificationRequest[] = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const classifier: Classifier = {
      classify: async (request) => {
        requests.push(request);
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        activeRequests -= 1;
        return request.tabs.map((tab) => ({
          tabRef: tab.ref,
          kind: 'no_change',
          targetRef: null,
          suggestedName: null,
          suggestedDescription: null,
          confidence: 0.5,
          reason: 'No change',
        }));
      },
    };
    const platform: TabGroupingPlatform = {
      listGroups: async () => [],
      getTab: async (tabId) => tabs.find((tab) => tab.tabId === tabId) ?? null,
      moveToExistingGroup: async () => undefined,
      moveToPreset: async () => undefined,
    };
    const organizer = new FirstPageOrganizer(
      session,
      async () => classifier,
      new PresetStore(local, () => 'preset-1'),
      new TabLockStore(session, () => 100),
      platform,
      () => 'en',
    );
    await Promise.all(tabs.map((tab) => organizer.registerCreated(tab)));

    await expect(Promise.all(tabs.map((tab) => organizer.handleStable(tab)))).resolves.toHaveLength(100);
    expect(requests).toHaveLength(4);
    expect(requests.flatMap((request) => request.tabs)).toHaveLength(100);
    expect(requests.every((request) => new Set(request.tabs.map((tab) => {
      const id = Number(tab.ref.replace('tab-', ''));
      return tabs.find((candidate) => candidate.tabId === id)?.windowId;
    })).size === 1)).toBe(true);
    expect(maxActiveRequests).toBeLessThanOrEqual(2);
  });

  it('serializes separate automatic batches for the same window', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const firstTab = { ...eligibleTab, tabId: 1 };
    const secondTab = { ...eligibleTab, tabId: 2 };
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let requestCount = 0;
    const classifier: Classifier = {
      classify: async (request) => {
        requestCount += 1;
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        if (requestCount === 1) await firstGate;
        activeRequests -= 1;
        return request.tabs.map((tab) => ({
          tabRef: tab.ref, kind: 'no_change', targetRef: null, suggestedName: null,
          suggestedDescription: null, confidence: 0.5, reason: 'No change',
        }));
      },
    };
    const platform: TabGroupingPlatform = {
      listGroups: async () => [],
      getTab: async (tabId) => tabId === 1 ? firstTab : secondTab,
      moveToExistingGroup: async () => undefined,
      moveToPreset: async () => undefined,
    };
    const organizer = new FirstPageOrganizer(
      session, async () => classifier, new PresetStore(local, () => 'preset-1'),
      new TabLockStore(session, () => 100), platform, () => 'en',
    );
    await organizer.registerCreated(firstTab);
    await organizer.registerCreated(secondTab);

    const first = organizer.handleStable(firstTab);
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    const second = organizer.handleStable(secondTab);
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    expect(requestCount).toBe(1);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(requestCount).toBe(2);
    expect(maxActiveRequests).toBe(1);
  });

  it('fails an automatic batch when the rolling request budget is exhausted', async () => {
    const { organizer, classifier, platform, session } = createHarness(existingDecision);
    session.values.automaticClassificationBudget = {
      requestTimestamps: Array.from({ length: 30 }, () => Date.now()),
    };
    await organizer.registerCreated(eligibleTab);

    await expect(organizer.handleStable(eligibleTab)).resolves.toEqual({
      status: 'failed',
      error: 'classification_failed',
    });

    expect(classifier.requests).toHaveLength(0);
    expect(platform.moves).toHaveLength(0);
  });

  it('prunes expired automatic requests before consuming the budget', async () => {
    const { organizer, classifier, session } = createHarness(existingDecision);
    session.values.automaticClassificationBudget = {
      requestTimestamps: Array.from({ length: 30 }, () => Date.now() - 60_001),
    };
    await organizer.registerCreated(eligibleTab);

    await organizer.handleStable(eligibleTab);

    expect(classifier.requests).toHaveLength(1);
    const budget = session.values.automaticClassificationBudget as {
      requestTimestamps: number[];
    };
    expect(budget.requestTimestamps).toHaveLength(1);
    expect(Number.isFinite(budget.requestTimestamps[0])).toBe(true);
  });

  it('rejects and clears in-flight work when completion persistence fails', async () => {
    const { organizer, session } = createHarness(existingDecision);
    await organizer.registerCreated(eligibleTab);
    const set = session.set.bind(session);
    session.set = async (items) => {
      const records = items.firstPageStates as Record<string, { status?: string }> | undefined;
      if (records?.['42']?.status === 'completed') throw new Error('storage_unavailable');
      await set(items);
    };

    await expect(organizer.handleStable(eligibleTab)).rejects.toThrow('storage_unavailable');
    await expect(organizer.handleStable(eligibleTab)).resolves.toEqual({
      status: 'failed', error: 'classification_failed',
    });
  });

  it('does not organize an existing tab that was never observed as newly created', async () => {
    const { organizer, classifier, platform } = createHarness(existingDecision);

    await expect(organizer.handleStable(eligibleTab)).resolves.toEqual({ status: 'pending' });

    expect(classifier.requests).toHaveLength(0);
    expect(platform.moves).toHaveLength(0);
  });

  it('treats the Chrome SPLIT_VIEW_ID_NONE sentinel as an ordinary tab', async () => {
    const { organizer, classifier } = createHarness(existingDecision);
    const tab = { ...eligibleTab, splitViewId: -1 };
    await organizer.registerCreated(tab);

    await organizer.handleStable(tab);

    expect(classifier.requests).toHaveLength(1);
  });

  it.each([
    { name: 'grouped', patch: { groupId: 9 } },
    { name: 'restored', patch: { restored: true } },
    { name: 'incognito', patch: { incognito: true } },
    { name: 'internal', patch: { url: 'chrome://settings' } },
    { name: 'split view', patch: { splitViewId: 4 } },
  ])('skips $name tabs before classification', async ({ patch }) => {
    const { organizer, classifier, platform } = createHarness(existingDecision);
    const tab = { ...eligibleTab, ...patch };

    await organizer.registerCreated(tab);
    const outcome = await organizer.handleStable(tab);

    expect(outcome).toMatchObject({ status: 'completed', result: 'skipped' });
    expect(classifier.requests).toHaveLength(0);
    expect(platform.moves).toHaveLength(0);
  });

  it('skips locked tabs before title and hostname enter a request', async () => {
    const { organizer, locks, classifier } = createHarness(existingDecision);
    await locks.lock(42);

    await organizer.registerCreated(eligibleTab);
    await organizer.handleStable(eligibleTab);

    expect(classifier.requests).toHaveLength(0);
  });

  it.each([
    { kind: 'new_group' as const, targetRef: null, confidence: 0.99 },
    { kind: 'existing_group' as const, targetRef: 'group-7', confidence: 0.89 },
  ])('does not automatically apply $kind at confidence $confidence', async (decision) => {
    const { organizer, platform } = createHarness({
      ...existingDecision,
      ...decision,
      suggestedName: decision.kind === 'new_group' ? 'New' : null,
      suggestedDescription: decision.kind === 'new_group' ? 'New group' : null,
    });
    await organizer.registerCreated(eligibleTab);

    await expect(organizer.handleStable(eligibleTab)).resolves.toMatchObject({
      status: 'completed',
      result: 'no_change',
    });
    expect(platform.moves).toHaveLength(0);
  });

  it('records failure without automatic retry and allows an explicit retry', async () => {
    const { organizer, classifier, platform } = createHarness(
      new Error('classification_request_failed'),
    );
    await organizer.registerCreated(eligibleTab);

    await expect(organizer.handleStable(eligibleTab)).resolves.toMatchObject({
      status: 'failed',
      error: 'classification_failed',
    });
    await organizer.handleStable(eligibleTab);
    expect(classifier.requests).toHaveLength(1);

    classifier.setDecision(existingDecision);
    await organizer.retry(eligibleTab);
    expect(classifier.requests).toHaveLength(2);
    expect(platform.moves).toHaveLength(1);
  });

  it('retries a processing record once after service reconstruction', async () => {
    const { organizer, classifier, session } = createHarness(existingDecision);
    session.values.firstPageStates = { '42': { status: 'processing' } };

    await organizer.retry(eligibleTab);

    expect(classifier.requests).toHaveLength(1);
  });

  it('applies a preset at the exact automatic confidence threshold', async () => {
    const { organizer, presets, platform } = createHarness({
      ...existingDecision,
      kind: 'preset',
      targetRef: 'preset-1',
      confidence: 0.9,
    });
    await presets.create({
      name: 'Apollo',
      description: 'Apollo work',
      cues: ['billing'],
      color: 'blue',
    });
    await organizer.registerCreated(eligibleTab);

    await organizer.handleStable(eligibleTab);

    expect(platform.moves).toEqual([{ tabId: 42, target: '3:preset-1' }]);
  });

  it('skips a stale automatic decision after navigation during classification', async () => {
    const { organizer, platform } = createHarness(existingDecision);
    await organizer.registerCreated(eligibleTab);
    platform.currentTab = { ...eligibleTab, url: 'https://billing.example.test/other' };

    await expect(organizer.handleStable(eligibleTab)).resolves.toEqual({
      status: 'completed',
      result: 'skipped',
    });
    expect(platform.moves).toEqual([]);
  });

  it('connects Chrome lifecycle events to first-page registration and stable handling', async () => {
    vi.useFakeTimers();
    let createdListener: ((tab: chrome.tabs.Tab) => void) | undefined;
    let updatedListener: ((
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => void) | undefined;
    vi.stubGlobal('chrome', {
      tabs: {
        onCreated: { addListener: (listener: typeof createdListener) => { createdListener = listener; } },
        onUpdated: { addListener: (listener: typeof updatedListener) => { updatedListener = listener; } },
        onRemoved: { addListener: () => undefined },
      },
    } as unknown as typeof chrome);
    const organizer = {
      registerCreated: vi.fn(async () => undefined),
      handleStable: vi.fn(async () => ({ status: 'completed', result: 'no_change' as const })),
    } as unknown as FirstPageOrganizer;
    const locks = {
      recordNavigation: vi.fn(async () => undefined),
    } as unknown as TabLockStore;
    const settings = new SettingsService(new MemoryStorage(), async () => ({ status: 'valid' }));
    await settings.saveAndTestApiKey('sk-project-valid', 'en-US');
    registerTabLifecycle(organizer, locks, new TabPlacementStore(new MemoryStorage()), settings, () => 'en-US', () => undefined);
    const chromeTab = {
      id: 42,
      windowId: 3,
      title: eligibleTab.title,
      url: eligibleTab.url,
      groupId: -1,
      incognito: false,
      status: 'complete',
    } as chrome.tabs.Tab;

    createdListener?.(chromeTab);
    await vi.waitFor(() => expect(organizer.registerCreated).toHaveBeenCalledOnce());
    updatedListener?.(42, { status: 'complete' }, chromeTab);
    await vi.advanceTimersByTimeAsync(350);

    expect(organizer.handleStable).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('waits for created registration before handling a stable tab', async () => {
    vi.useFakeTimers();
    let createdListener: ((tab: chrome.tabs.Tab) => void) | undefined;
    let updatedListener: ((
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => void) | undefined;
    vi.stubGlobal('chrome', {
      tabs: {
        onCreated: { addListener: (listener: typeof createdListener) => { createdListener = listener; } },
        onUpdated: { addListener: (listener: typeof updatedListener) => { updatedListener = listener; } },
        onRemoved: { addListener: () => undefined },
      },
    } as unknown as typeof chrome);
    let resolveCreatedConfig: ((config: {
      apiKey: string;
      model: string;
      firstPageEnabled: boolean;
      locale: 'en';
      enabled: boolean;
    }) => void) | undefined;
    const createdConfig = new Promise<{
      apiKey: string;
      model: string;
      firstPageEnabled: boolean;
      locale: 'en';
      enabled: boolean;
    }>((resolve) => {
      resolveCreatedConfig = resolve;
    });
    let configCalls = 0;
    const settings = {
      getOrganizationRuntimeConfig: async () => {
        configCalls += 1;
        return configCalls === 1
          ? createdConfig
          : { apiKey: 'configured', model: 'gpt-5.6', firstPageEnabled: true, locale: 'en' as const, enabled: true };
      },
    } as unknown as SettingsService;
    const order: string[] = [];
    const organizer = {
      registerCreated: vi.fn(async () => { order.push('created'); }),
      handleStable: vi.fn(async () => {
        order.push('stable');
        return { status: 'completed', result: 'no_change' as const };
      }),
    } as unknown as FirstPageOrganizer;
    const locks = { recordNavigation: vi.fn(async () => undefined) } as unknown as TabLockStore;
    registerTabLifecycle(organizer, locks, new TabPlacementStore(new MemoryStorage()), settings, () => 'en-US', () => undefined);
    const chromeTab = {
      id: 42,
      windowId: 3,
      title: eligibleTab.title,
      url: eligibleTab.url,
      groupId: -1,
      incognito: false,
      status: 'complete',
    } as chrome.tabs.Tab;

    createdListener?.(chromeTab);
    updatedListener?.(42, { status: 'complete' }, chromeTab);
    await vi.advanceTimersByTimeAsync(350);
    resolveCreatedConfig?.({
      apiKey: 'configured',
      model: 'gpt-5.6',
      firstPageEnabled: true,
      locale: 'en',
      enabled: true,
    });
    await vi.waitFor(() => expect(organizer.handleStable).toHaveBeenCalledOnce());

    expect(order).toEqual(['created', 'stable']);
  });

  it('does not start lifecycle organization when first-page automation is disabled', async () => {
    vi.useFakeTimers();
    let createdListener: ((tab: chrome.tabs.Tab) => void) | undefined;
    let updatedListener: ((
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => void) | undefined;
    vi.stubGlobal('chrome', {
      tabs: {
        onCreated: { addListener: (listener: typeof createdListener) => { createdListener = listener; } },
        onUpdated: { addListener: (listener: typeof updatedListener) => { updatedListener = listener; } },
        onRemoved: { addListener: () => undefined },
      },
    } as unknown as typeof chrome);
    const organizer = {
      registerCreated: vi.fn(async () => undefined),
      handleStable: vi.fn(async () => ({ status: 'completed', result: 'no_change' as const })),
    } as unknown as FirstPageOrganizer;
    const locks = { recordNavigation: vi.fn(async () => undefined) } as unknown as TabLockStore;
    const settings = {
      getOrganizationRuntimeConfig: async () => ({
        apiKey: 'configured',
        model: 'gpt-5.6',
        firstPageEnabled: false,
        locale: 'en' as const,
        enabled: true,
      }),
    } as unknown as SettingsService;
    registerTabLifecycle(organizer, locks, new TabPlacementStore(new MemoryStorage()), settings, () => 'en-US', () => undefined);
    const chromeTab = {
      id: 42,
      windowId: 3,
      title: eligibleTab.title,
      url: eligibleTab.url,
      groupId: -1,
      incognito: false,
      status: 'complete',
    } as chrome.tabs.Tab;

    createdListener?.(chromeTab);
    updatedListener?.(42, { status: 'complete' }, chromeTab);
    await vi.advanceTimersByTimeAsync(350);

    expect(organizer.registerCreated).not.toHaveBeenCalled();
    expect(organizer.handleStable).not.toHaveBeenCalled();
  });

  it('registers before stable handling when automation becomes enabled', async () => {
    vi.useFakeTimers();
    let createdListener: ((tab: chrome.tabs.Tab) => void) | undefined;
    let updatedListener: ((
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => void) | undefined;
    vi.stubGlobal('chrome', {
      tabs: {
        onCreated: { addListener: (listener: typeof createdListener) => { createdListener = listener; } },
        onUpdated: { addListener: (listener: typeof updatedListener) => { updatedListener = listener; } },
        onRemoved: { addListener: () => undefined },
      },
    } as unknown as typeof chrome);
    let configCalls = 0;
    const settings = {
      getOrganizationRuntimeConfig: async () => {
        configCalls += 1;
        return {
          apiKey: configCalls === 1 ? null : 'configured',
          model: 'gpt-5.6',
          firstPageEnabled: configCalls !== 1,
          locale: 'en' as const,
          enabled: configCalls !== 1,
        };
      },
    } as unknown as SettingsService;
    const order: string[] = [];
    const organizer = {
      registerCreated: vi.fn(async () => { order.push('created'); }),
      handleStable: vi.fn(async () => {
        order.push('stable');
        return { status: 'completed', result: 'no_change' as const };
      }),
    } as unknown as FirstPageOrganizer;
    const locks = { recordNavigation: vi.fn(async () => undefined) } as unknown as TabLockStore;
    registerTabLifecycle(organizer, locks, new TabPlacementStore(new MemoryStorage()), settings, () => 'en-US', () => undefined);
    const chromeTab = {
      id: 42, windowId: 3, title: eligibleTab.title, url: eligibleTab.url,
      groupId: -1, incognito: false, status: 'complete',
    } as chrome.tabs.Tab;

    createdListener?.(chromeTab);
    await vi.waitFor(() => expect(configCalls).toBe(1));
    updatedListener?.(42, { status: 'complete' }, chromeTab);
    await vi.advanceTimersByTimeAsync(350);

    expect(order).toEqual(['created', 'stable']);
  });

  it('does not register a tab after its close cleanup has started', async () => {
    let createdListener: ((tab: chrome.tabs.Tab) => void) | undefined;
    let removedListener: ((tabId: number) => void) | undefined;
    vi.stubGlobal('chrome', {
      tabs: {
        onCreated: { addListener: (listener: typeof createdListener) => { createdListener = listener; } },
        onUpdated: { addListener: () => undefined },
        onRemoved: { addListener: (listener: typeof removedListener) => { removedListener = listener; } },
      },
    } as unknown as typeof chrome);
    let resolveConfig: ((config: {
      apiKey: string;
      model: string;
      firstPageEnabled: boolean;
      locale: 'en';
      enabled: boolean;
    }) => void) | undefined;
    const config = new Promise<{
      apiKey: string;
      model: string;
      firstPageEnabled: boolean;
      locale: 'en';
      enabled: boolean;
    }>((resolve) => { resolveConfig = resolve; });
    const settings = {
      getOrganizationRuntimeConfig: vi.fn(async () => config),
    } as unknown as SettingsService;
    const organizer = {
      registerCreated: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    } as unknown as FirstPageOrganizer;
    const locks = {
      removeClosedTab: vi.fn(async () => undefined),
    } as unknown as TabLockStore;
    registerTabLifecycle(organizer, locks, new TabPlacementStore(new MemoryStorage()), settings, () => 'en-US', () => undefined);

    createdListener?.({ id: 42, windowId: 3, groupId: -1, incognito: false } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(settings.getOrganizationRuntimeConfig).toHaveBeenCalledOnce());
    removedListener?.(42);
    await vi.waitFor(() => expect(organizer.remove).toHaveBeenCalledOnce());
    resolveConfig?.({
      apiKey: 'configured', model: 'gpt-5.6', firstPageEnabled: true, locale: 'en', enabled: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(organizer.registerCreated).not.toHaveBeenCalled();
  });

  it('rolls back Chrome group membership when new-group metadata update fails', async () => {
    const groupCalls: chrome.tabs.GroupOptions[] = [];
    const ungroupCalls: number[][] = [];
    vi.stubGlobal('chrome', {
      tabs: {
        get: async (tabId: number) => ({
          id: tabId, windowId: 3, groupId: tabId === 1 ? -1 : 5,
        }),
        group: async (options: chrome.tabs.GroupOptions) => {
          groupCalls.push(options);
          return options.groupId ?? 9;
        },
        ungroup: async (tabIds: number[]) => { ungroupCalls.push(tabIds); },
      },
      tabGroups: {
        get: async () => ({ id: 5, windowId: 3, title: 'Original', color: 'blue' }),
        update: async (groupId: number) => {
          if (groupId === 9) throw new Error('metadata_failed');
          return { id: groupId };
        },
      },
    } as unknown as typeof chrome);
    const platform = new ChromeSynchronizationPlatform();

    await expect(platform.moveToNewGroup([1, 2], 3, 'Target', 'red'))
      .rejects.toThrow('metadata_failed');

    expect(ungroupCalls).toEqual([[1]]);
    expect(groupCalls).toContainEqual({ tabIds: [2], groupId: 5 });
  });

  it('reports rollback failure when Chrome cannot restore prior group membership', async () => {
    let createCalls = 0;
    vi.stubGlobal('chrome', {
      tabs: {
        get: async (tabId: number) => ({ id: tabId, windowId: 3, groupId: 5 }),
        group: async (options: chrome.tabs.GroupOptions) => {
          if (options.groupId === 5) throw new Error('prior_group_gone');
          createCalls += 1;
          if (createCalls > 1) throw new Error('recreate_failed');
          return 9;
        },
        ungroup: async () => undefined,
      },
      tabGroups: {
        get: async () => ({ id: 5, windowId: 3, title: 'Original', color: 'blue' }),
        update: async () => { throw new Error('metadata_failed'); },
      },
    } as unknown as typeof chrome);
    const platform = new ChromeSynchronizationPlatform();

    await expect(platform.moveToNewGroup([1], 3, 'Target', 'red'))
      .rejects.toThrow('group_metadata_update_failed_rollback_failed');
  });

  it('reports lifecycle failures with only an operation code and tab ID', async () => {
    let createdListener: ((tab: chrome.tabs.Tab) => void) | undefined;
    vi.stubGlobal('chrome', {
      tabs: {
        onCreated: { addListener: (listener: typeof createdListener) => { createdListener = listener; } },
        onUpdated: { addListener: () => undefined },
        onRemoved: { addListener: () => undefined },
      },
    } as unknown as typeof chrome);
    const settings = {
      getOrganizationRuntimeConfig: async () => {
        throw new Error('storage_failed_with_sensitive_url');
      },
    } as unknown as SettingsService;
    const reportError = vi.fn<(operation: string, tabId: number) => void>();
    registerTabLifecycle(
      {} as FirstPageOrganizer,
      {} as TabLockStore,
      {} as TabPlacementStore,
      settings,
      () => 'en-US',
      () => undefined,
      reportError,
    );

    createdListener?.({ id: 91, windowId: 3, groupId: -1, incognito: false } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());

    expect(reportError).toHaveBeenCalledWith('tab_created_processing_failed', 91);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
