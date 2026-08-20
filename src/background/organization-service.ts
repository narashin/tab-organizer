import type { FirstPageOrganizer, OrganizableTab } from './first-page-organizer';
import type { Preset, PresetDraft, PresetStore } from './preset-store';
import type { ReviewScope, SynchronizationProposal, SynchronizationService } from './synchronization-service';
import type { TabLock, TabLockStore } from './tab-lock-store';

export interface OrganizationState {
  presets: Preset[];
  locks: TabLock[];
  failedTabIds: number[];
  tabSummaries: OrganizationTabSummary[];
}

export interface OrganizationTabSummary {
  tabId: number;
  title: string;
  hostname: string;
}

export interface ActiveTabPlatform {
  getActiveTab(): Promise<OrganizableTab | null>;
  getOrganizableTab(tabId: number): Promise<OrganizableTab | null>;
}

export class OrganizationService {
  constructor(
    private readonly presets: PresetStore,
    private readonly locks: TabLockStore,
    private readonly firstPage: FirstPageOrganizer,
    private readonly synchronization: SynchronizationService,
    private readonly tabs: ActiveTabPlatform,
  ) {}

  async getState(): Promise<OrganizationState> {
    const [presets, locks, recordedFailures] = await Promise.all([
      this.presets.list(),
      this.locks.list(),
      this.firstPage.listFailedTabIds(),
    ]);
    const tabIds = [...new Set([...locks.map((lock) => lock.tabId), ...recordedFailures])];
    const summaries = await Promise.all(tabIds.map(async (tabId) => {
      const tab = await this.tabs.getOrganizableTab(tabId);
      return tab === null ? null : {
        tabId,
        title: tab.title,
        hostname: getHostname(tab.url),
      };
    }));
    const present = new Set(summaries.filter(isDefined).map((summary) => summary.tabId));
    // A failure whose tab is gone is not a failure anyone can act on: there is nothing left to
    // classify, and Chrome never reuses the ID, so the row would sit there for good showing a bare
    // number and a retry that can only fail. The lookup that builds the summaries already answers
    // whether the tab exists, so clearing these costs no extra call.
    const closed = recordedFailures.filter((tabId) => !present.has(tabId));
    if (closed.length > 0) await this.firstPage.removeAll(closed);
    return {
      presets,
      locks,
      failedTabIds: recordedFailures.filter((tabId) => present.has(tabId)),
      tabSummaries: summaries.filter(isDefined),
    };
  }

  async createPreset(draft: PresetDraft): Promise<OrganizationState> {
    await this.presets.create(draft);
    return this.getState();
  }

  async updatePreset(id: string, draft: PresetDraft): Promise<OrganizationState> {
    await this.presets.update(id, draft);
    return this.getState();
  }

  async reorderPresets(orderedIds: readonly string[]): Promise<OrganizationState> {
    await this.presets.reorder(orderedIds);
    return this.getState();
  }

  async deletePreset(id: string): Promise<OrganizationState> {
    await this.presets.delete(id);
    return this.getState();
  }

  async lockActiveTab(): Promise<OrganizationState> {
    const tab = await this.tabs.getActiveTab();
    if (tab === null) throw new Error('active_tab_missing');
    await this.locks.lock(tab.tabId);
    return this.getState();
  }

  async lockTab(tabId: number): Promise<OrganizationState> {
    const tab = await this.tabs.getOrganizableTab(tabId);
    if (tab === null) throw new Error('tab_missing');
    await this.locks.lock(tabId);
    return this.getState();
  }

  async unlockTab(tabId: number): Promise<OrganizationState> {
    await this.locks.unlock(tabId);
    return this.getState();
  }

  async unlockAndAnalyze(tabId: number): Promise<OrganizationState> {
    await this.locks.unlock(tabId);
    const tab = await this.tabs.getOrganizableTab(tabId);
    if (tab !== null) {
      await this.firstPage.registerCreated(tab);
      await this.firstPage.retry(tab);
    }
    return this.getState();
  }

  /**
   * Tries the automatic classification again, or forgets the tab if it is no longer there.
   *
   * A missing tab used to be reported as a failed operation, which put an error in front of the user
   * for a tab they had closed themselves and left the row in place to be clicked again.
   */
  async retryFirstPage(tabId: number): Promise<OrganizationState> {
    const tab = await this.tabs.getOrganizableTab(tabId);
    if (tab === null) {
      await this.firstPage.removeAll([tabId]);
      return this.getState();
    }
    await this.firstPage.retry(tab);
    return this.getState();
  }

  review(scope: ReviewScope): Promise<SynchronizationProposal> {
    return this.synchronization.review(scope);
  }

  latestProposal(): Promise<SynchronizationProposal | null> {
    return this.synchronization.latestProposal();
  }

  isReviewing(): boolean {
    return this.synchronization.isReviewing();
  }

  async apply(proposalId: string, selectedTabIds: number[]) {
    return this.synchronization.apply(proposalId, selectedTabIds);
  }

}

function getHostname(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : '';
  } catch {
    return '';
  }
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
