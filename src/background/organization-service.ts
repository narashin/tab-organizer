import type { FirstPageOrganizer, OrganizableTab } from './first-page-organizer';
import type { HistoryOperation, HistoryRestorer, HistoryStore } from './history-store';
import type { Preset, PresetDraft, PresetStore } from './preset-store';
import type { SynchronizationProposal, SynchronizationService } from './synchronization-service';
import type { TabLock, TabLockStore } from './tab-lock-store';

export interface UndoOutcome {
  state: OrganizationState;
  restored: number;
  skipped: number;
}

export interface OrganizationState {
  presets: Preset[];
  locks: TabLock[];
  history: HistoryOperation[];
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
    private readonly history: HistoryStore,
    private readonly restorer: HistoryRestorer,
    private readonly tabs: ActiveTabPlatform,
  ) {}

  async getState(): Promise<OrganizationState> {
    const [presets, locks, history, failedTabIds] = await Promise.all([
      this.presets.list(),
      this.locks.list(),
      this.history.list(),
      this.firstPage.listFailedTabIds(),
    ]);
    const tabIds = [...new Set([...locks.map((lock) => lock.tabId), ...failedTabIds])];
    const summaries = await Promise.all(tabIds.map(async (tabId) => {
      const tab = await this.tabs.getOrganizableTab(tabId);
      return tab === null ? null : {
        tabId,
        title: tab.title,
        hostname: getHostname(tab.url),
      };
    }));
    return {
      presets,
      locks,
      history,
      failedTabIds,
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

  async retryFirstPage(tabId: number): Promise<OrganizationState> {
    const tab = await this.tabs.getOrganizableTab(tabId);
    if (tab === null) throw new Error('tab_missing');
    await this.firstPage.retry(tab);
    return this.getState();
  }

  review(scope: 'all' | 'current'): Promise<SynchronizationProposal> {
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

  /**
   * Reverts an operation and says how much of it could be reverted.
   *
   * The counts used to be discarded, so an undo that restored nothing looked exactly like one that
   * restored everything.
   */
  async undo(operationId: string): Promise<UndoOutcome> {
    const result = await this.restorer.undo(operationId);
    return { state: await this.getState(), ...result };
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
