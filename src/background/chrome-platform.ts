import type { FirstPageOrganizer, OrganizableTab, TabGroupingPlatform } from './first-page-organizer';
import type {
  HistoryGroupState,
  HistoryPlatform,
  HistoryStore,
  PriorTabState,
} from './history-store';
import type { ActiveTabPlatform } from './organization-service';
import type { GroupColor, PresetStore } from './preset-store';
import type { SynchronizationPlatform } from './synchronization-service';
import type { OrderedTab, TabOrderPlatform } from './tab-order';
import type { TabLockStore } from './tab-lock-store';
import type { SettingsService } from './settings-service';

export class ChromeSynchronizationPlatform implements SynchronizationPlatform, TabOrderPlatform {
  async listWindowTabs(windowId: number): Promise<OrderedTab[]> {
    return (await chrome.tabs.query({ windowId })).flatMap((tab) => tab.id === undefined ? [] : [{
      tabId: tab.id,
      index: tab.index,
      pinned: tab.pinned,
      groupId: tab.groupId,
      title: tab.title ?? '',
      ...(splitViewIdOf(tab) === undefined ? {} : { splitViewId: splitViewIdOf(tab) }),
    }]);
  }

  async moveTab(tabId: number, index: number): Promise<void> {
    await chrome.tabs.move(tabId, { index });
  }

  async moveGroup(groupId: number, index: number): Promise<void> {
    await chrome.tabGroups.move(groupId, { index });
  }

  async listTabs(scope: 'all' | 'current') {
    if (scope === 'current') {
      return (await chrome.tabs.query({ currentWindow: true })).map(toBrowserTab).filter(isDefined);
    }
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    return windows.flatMap((window) => (window.tabs ?? []).map(toBrowserTab).filter(isDefined));
  }

  async listGroups(windowId: number) {
    return (await chrome.tabGroups.query({ windowId })).map((group) => ({
      ref: `group-${group.id}`,
      groupId: group.id,
      windowId: group.windowId,
      title: group.title ?? '',
      color: toGroupColor(group.color),
    }));
  }

  async getTab(tabId: number) {
    try {
      return toBrowserTab(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  }

  async moveToExistingGroup(tabIds: number[], groupId: number): Promise<void> {
    const firstTabId = tabIds[0];
    if (firstTabId === undefined) throw new Error('group_requires_tab');
    await chrome.tabs.group({ tabIds: [firstTabId, ...tabIds.slice(1)], groupId });
  }

  async moveToNewGroup(tabIds: number[], windowId: number, title: string, color: GroupColor) {
    const firstTabId = tabIds[0];
    if (firstTabId === undefined) throw new Error('group_requires_tab');
    const priorTabs = await Promise.all(tabIds.map((tabId) => chrome.tabs.get(tabId)));
    const priorGroupIds = [...new Set(
      priorTabs.map((tab) => tab.groupId).filter((groupId) => groupId >= 0),
    )];
    const priorGroups = new Map(await Promise.all(priorGroupIds.map(async (groupId) => {
      const group = await chrome.tabGroups.get(groupId);
      return [groupId, { title: group.title ?? '', color: toGroupColor(group.color) }] as const;
    })));
    const groupId = await chrome.tabs.group({
      tabIds: [firstTabId, ...tabIds.slice(1)],
      createProperties: { windowId },
    });
    try {
      await chrome.tabGroups.update(groupId, { title, color });
    } catch (error) {
      try {
        await restoreChromeGroups(priorTabs, priorGroups);
      } catch {
        throw new Error('group_metadata_update_failed_rollback_failed');
      }
      throw error;
    }
    return groupId;
  }
}

export class ChromeHistoryPlatform implements HistoryPlatform {
  constructor(private readonly tabs: ChromeSynchronizationPlatform) {}
  async listTabs(windowIds: readonly number[]) {
    const tabs = await Promise.all(windowIds.map((windowId) => chrome.tabs.query({ windowId })));
    return tabs.flatMap((windowTabs) => windowTabs.map(toBrowserTab).filter(isDefined));
  }
  listGroups(windowId: number) { return this.tabs.listGroups(windowId); }
  moveToExistingGroup(tabIds: number[], groupId: number) { return this.tabs.moveToExistingGroup(tabIds, groupId); }
  async moveToNewGroup(tabIds: number[], windowId: number, title: string, color: GroupColor) {
    await this.tabs.moveToNewGroup(tabIds, windowId, title, color);
  }
  async ungroup(tabIds: number[]) {
    const firstTabId = tabIds[0];
    if (firstTabId === undefined) return;
    await chrome.tabs.ungroup([firstTabId, ...tabIds.slice(1)]);
  }
}

export class ChromeFirstPagePlatform implements TabGroupingPlatform {
  constructor(
    private readonly tabs: ChromeSynchronizationPlatform,
    private readonly presets: PresetStore,
    private readonly history: HistoryStore,
  ) {}

  listGroups(windowId: number) { return this.tabs.listGroups(windowId); }

  async getTab(tabId: number) {
    try {
      return toOrganizableTab(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  }

  async moveToExistingGroup(tabId: number, groupId: number) {
    const tab = await this.tabs.getTab(tabId);
    if (tab === null) throw new Error('tab_missing');
    const target = (await this.tabs.listGroups(tab.windowId)).find((group) => group.groupId === groupId);
    if (target === undefined) throw new Error('group_missing');
    const operation = await this.recordPrior(tab, {
      groupId: target.groupId,
      title: target.title,
      color: target.color,
    });
    await this.tabs.moveToExistingGroup([tabId], groupId);
    await this.history.markStatus(operation.id, 'completed');
  }

  async moveToPreset(tabId: number, windowId: number, presetId: string) {
    const preset = (await this.presets.list()).find((item) => item.id === presetId);
    if (preset === undefined) throw new Error('preset_not_found');
    const group = (await this.tabs.listGroups(windowId)).find(
      (item) => item.title === preset.name && item.color === preset.color,
    );
    const tab = await this.tabs.getTab(tabId);
    if (tab === null) throw new Error('tab_missing');
    const operation = await this.recordPrior(tab, {
      ...(group === undefined ? {} : { groupId: group.groupId }),
      title: preset.name,
      color: preset.color,
    });
    if (group === undefined) {
      const groupId = await this.tabs.moveToNewGroup([tabId], windowId, preset.name, preset.color);
      await this.history.setExpectedGroupId(operation.id, [tabId], groupId);
    } else {
      await this.tabs.moveToExistingGroup([tabId], group.groupId);
    }
    await this.history.markStatus(operation.id, 'completed');
  }

  private async recordPrior(
    tab: NonNullable<Awaited<ReturnType<ChromeSynchronizationPlatform['getTab']>>>,
    expectedGroup: HistoryGroupState,
  ) {
    const group = tab.groupId < 0
      ? null
      : (await this.tabs.listGroups(tab.windowId)).find((item) => item.groupId === tab.groupId);
    const prior: PriorTabState = {
      tabId: tab.tabId,
      windowId: tab.windowId,
      group: group === undefined || group === null ? null : {
        groupId: group.groupId,
        title: group.title,
        color: group.color,
      },
      expectedGroup,
    };
    return this.history.record('automatic', [prior]);
  }
}

async function restoreChromeGroups(
  tabs: chrome.tabs.Tab[],
  groups: ReadonlyMap<number, { title: string; color: GroupColor }>,
): Promise<void> {
  const ungrouped = tabs.flatMap((tab) => tab.id !== undefined && tab.groupId < 0 ? [tab.id] : []);
  const grouped = new Map<number, number[]>();
  for (const tab of tabs) {
    if (tab.id === undefined || tab.groupId < 0) continue;
    grouped.set(tab.groupId, [...(grouped.get(tab.groupId) ?? []), tab.id]);
  }
  for (const [priorGroupId, groupedTabIds] of grouped) {
    const firstGroupedTabId = groupedTabIds[0];
    if (firstGroupedTabId === undefined) continue;
    const chromeTabIds: [number, ...number[]] = [firstGroupedTabId, ...groupedTabIds.slice(1)];
    try {
      await chrome.tabs.group({ tabIds: chromeTabIds, groupId: priorGroupId });
    } catch {
      const firstTab = tabs.find((tab) => tab.id === firstGroupedTabId);
      const descriptor = groups.get(priorGroupId);
      if (firstTab?.windowId === undefined || descriptor === undefined) throw new Error('prior_group_missing');
      const recreatedGroupId = await chrome.tabs.group({
        tabIds: chromeTabIds,
        createProperties: { windowId: firstTab.windowId },
      });
      await chrome.tabGroups.update(recreatedGroupId, descriptor);
    }
  }
  const firstUngroupedTabId = ungrouped[0];
  if (firstUngroupedTabId !== undefined) {
    await chrome.tabs.ungroup([firstUngroupedTabId, ...ungrouped.slice(1)]);
  }
}

export class ChromeActiveTabPlatform implements ActiveTabPlatform {
  async getActiveTab() {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    return tab === undefined ? null : toOrganizableTab(tab);
  }

  async getOrganizableTab(tabId: number) {
    try {
      return toOrganizableTab(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  }
}

export function registerTabLifecycle(
  organizer: FirstPageOrganizer,
  locks: TabLockStore,
  settings: SettingsService,
  getSystemLocale: () => string,
  setLocale: (locale: 'en' | 'ko' | 'ja') => void,
  reportError: (operation: string, tabId: number) => void = (operation, tabId) => {
    console.error(operation, { tabId });
  },
): void {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const removedTabs = new Set<number>();
  const createdTasks = new Map<number, Promise<'registered' | 'inactive' | 'failed' | 'removed'>>();
  const run = (operation: string, tabId: number, task: () => Promise<void>): void => {
    void task().catch(() => reportError(operation, tabId));
  };

  chrome.tabs.onCreated.addListener((tab) => {
    const candidate = toOrganizableTab(tab);
    if (candidate === null) return;
    removedTabs.delete(candidate.tabId);
    const task = (async (): Promise<'registered' | 'inactive' | 'failed' | 'removed'> => {
      try {
        const config = await settings.getOrganizationRuntimeConfig(getSystemLocale());
        if (removedTabs.has(candidate.tabId)) return 'removed';
        setLocale(config.locale);
        if (!config.enabled || !config.firstPageEnabled) return 'inactive';
        await organizer.registerCreated(candidate);
        if (removedTabs.has(candidate.tabId)) {
          await organizer.remove(candidate.tabId);
          return 'removed';
        }
        return 'registered';
      } catch {
        reportError('tab_created_processing_failed', candidate.tabId);
        return 'failed';
      }
    })();
    createdTasks.set(candidate.tabId, task);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (typeof changeInfo.url === 'string') {
      run('tab_navigation_record_failed', tabId, () => locks.recordNavigation(tabId));
    }
    if (changeInfo.status !== 'complete' && changeInfo.title === undefined && changeInfo.url === undefined) return;
    const existing = timers.get(tabId);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(tabId, setTimeout(() => {
      timers.delete(tabId);
      const candidate = toOrganizableTab(tab);
      if (candidate === null) return;
      run('tab_stable_processing_failed', tabId, async () => {
        const createdStatus = await createdTasks.get(tabId);
        if (removedTabs.has(tabId)) return;
        const config = await settings.getOrganizationRuntimeConfig(getSystemLocale());
        if (removedTabs.has(tabId)) return;
        setLocale(config.locale);
        if (config.enabled && config.firstPageEnabled) {
          if (createdStatus === 'failed' || createdStatus === 'inactive') {
            await organizer.registerCreated(candidate);
          }
          if (removedTabs.has(tabId)) {
            await organizer.remove(tabId);
            return;
          }
          await organizer.handleStable(candidate);
          if (removedTabs.has(tabId)) await organizer.remove(tabId);
        }
        createdTasks.delete(tabId);
      });
    }, 350));
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    removedTabs.add(tabId);
    const timer = timers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(tabId);
    createdTasks.delete(tabId);
    run('tab_cleanup_failed', tabId, async () => {
      await Promise.all([locks.removeClosedTab(tabId), organizer.remove(tabId)]);
    });
  });
}

function toBrowserTab(tab: chrome.tabs.Tab) {
  const candidate = toOrganizableTab(tab);
  return candidate === null ? null : {
    tabId: candidate.tabId,
    windowId: candidate.windowId,
    title: candidate.title,
    url: candidate.url,
    groupId: candidate.groupId,
    incognito: candidate.incognito,
    ...(candidate.splitViewId === undefined ? {} : { splitViewId: candidate.splitViewId }),
  };
}

function toOrganizableTab(tab: chrome.tabs.Tab): OrganizableTab | null {
  if (tab.id === undefined || tab.windowId === undefined) return null;
  const extended = tab as chrome.tabs.Tab & { splitViewId?: number };
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
    groupId: tab.groupId,
    incognito: tab.incognito,
    status: tab.status === 'complete' ? 'complete' : 'loading',
    restored: false,
    ...(extended.splitViewId === undefined || extended.splitViewId < 0
      ? {}
      : { splitViewId: extended.splitViewId }),
  };
}

/** Split View is newer than the typings, so the field is read off the tab rather than declared. */
function splitViewIdOf(tab: chrome.tabs.Tab): number | undefined {
  const extended = tab as chrome.tabs.Tab & { splitViewId?: number };
  return extended.splitViewId === undefined || extended.splitViewId < 0
    ? undefined
    : extended.splitViewId;
}

function toGroupColor(color: GroupColor): GroupColor {
  return color;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
