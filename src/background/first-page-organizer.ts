import type { SupportedLocale } from '../shared/localization';
import type { Classifier, ClassificationGroup } from './classifier';
import type { PresetStore } from './preset-store';
import type { LocalStorageArea } from './settings-service';
import type { TabLockStore } from './tab-lock-store';

export interface OrganizableTab {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  groupId: number;
  incognito: boolean;
  status: 'loading' | 'complete';
  restored: boolean;
  splitViewId?: number;
}

export interface PlatformGroup extends ClassificationGroup {
  groupId: number;
  windowId: number;
}

export interface TabGroupingPlatform {
  listGroups(windowId: number): Promise<PlatformGroup[]>;
  getTab(tabId: number): Promise<OrganizableTab | null>;
  moveToExistingGroup(tabId: number, groupId: number): Promise<void>;
  moveToPreset(tabId: number, windowId: number, presetId: string): Promise<void>;
}

export type FirstPageOutcome =
  | { status: 'pending' }
  | { status: 'completed'; result: 'moved' | 'no_change' | 'skipped' }
  | { status: 'failed'; error: 'classification_failed' };

type FirstPageRecord =
  | { status: 'pending' }
  | { status: 'processing' }
  | { status: 'completed'; result: 'moved' | 'no_change' | 'skipped' }
  | { status: 'failed'; error: 'classification_failed' };

type FirstPageRecords = Record<string, FirstPageRecord>;

interface AutomaticBatchItem {
  tab: OrganizableTab;
  settled: boolean;
  resolve(outcome: FirstPageOutcome): void;
  reject(reason: unknown): void;
}

interface AutomaticBatchTask {
  windowId: number;
  run(): Promise<void>;
}

interface AutomaticClassificationBudget {
  requestTimestamps: number[];
}

const STATE_KEY = 'firstPageStates';
const AUTOMATIC_BUDGET_KEY = 'automaticClassificationBudget';
const AUTOMATIC_CONFIDENCE_THRESHOLD = 0.9;
const AUTOMATIC_BATCH_DELAY_MS = 25;
const AUTOMATIC_MAX_CONCURRENT_REQUESTS = 2;
const AUTOMATIC_BUDGET_WINDOW_MS = 60_000;
const AUTOMATIC_BUDGET_MAX_REQUESTS = 30;

export class FirstPageOrganizer {
  private readonly inFlight = new Map<number, Promise<FirstPageOutcome>>();
  private readonly pendingBatches = new Map<number, AutomaticBatchItem[]>();
  private readonly batchTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly batchTasks: AutomaticBatchTask[] = [];
  private readonly activeBatchWindows = new Set<number>();
  private activeBatchTasks = 0;
  private storageMutation: Promise<void> = Promise.resolve();
  private budgetMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: LocalStorageArea,
    private readonly createClassifier: () => Promise<Classifier>,
    private readonly presets: PresetStore,
    private readonly locks: TabLockStore,
    private readonly platform: TabGroupingPlatform,
    private readonly getLocale: () => SupportedLocale,
  ) {}

  async registerCreated(tab: OrganizableTab): Promise<void> {
    await this.mutateRecords((records) => {
      records[String(tab.tabId)] = { status: 'pending' };
    });
  }

  async handleStable(tab: OrganizableTab): Promise<FirstPageOutcome> {
    const active = this.inFlight.get(tab.tabId);
    if (active !== undefined) {
      return active;
    }

    const task = this.handleStableOnce(tab);
    this.inFlight.set(tab.tabId, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(tab.tabId) === task) {
        this.inFlight.delete(tab.tabId);
      }
    }
  }

  private async handleStableOnce(tab: OrganizableTab): Promise<FirstPageOutcome> {
    const record = await this.readRecord(tab.tabId);
    if (record === undefined) {
      return { status: 'pending' };
    }
    if (record.status === 'pending') {
      if (!isReadyForDecision(tab)) {
        return { status: 'pending' };
      }
    } else if (record.status === 'processing') {
      const failed: FirstPageOutcome = {
        status: 'failed',
        error: 'classification_failed',
      };
      await this.writeRecord(tab.tabId, failed);
      return failed;
    } else {
      return record;
    }

    return this.organize(tab);
  }

  async retry(tab: OrganizableTab): Promise<FirstPageOutcome> {
    const record = await this.readRecord(tab.tabId);
    if (
      record?.status === 'failed' ||
      (record?.status === 'processing' && !this.inFlight.has(tab.tabId))
    ) {
      await this.writeRecord(tab.tabId, { status: 'pending' });
    }
    return this.handleStable(tab);
  }

  async remove(tabId: number): Promise<void> {
    await this.removeAll([tabId]);
  }

  /**
   * Drops several records at once.
   *
   * One pass rather than one per tab: a window that was closed with a dozen unclassified tabs would
   * otherwise read and rewrite the whole record set a dozen times, each write racing the next.
   */
  async removeAll(tabIds: readonly number[]): Promise<void> {
    if (tabIds.length === 0) return;
    await this.mutateRecords((records) => {
      for (const tabId of tabIds) delete records[String(tabId)];
    });
  }

  async listFailedTabIds(): Promise<number[]> {
    const records = await this.readRecords();
    return Object.entries(records)
      .filter(([, record]) => record.status === 'failed' || record.status === 'processing')
      .map(([tabId]) => Number(tabId))
      .filter(Number.isInteger);
  }

  private async organize(tab: OrganizableTab): Promise<FirstPageOutcome> {
    if (isExcluded(tab) || (await this.isLocked(tab.tabId))) {
      return this.complete(tab.tabId, 'skipped');
    }

    await this.writeRecord(tab.tabId, { status: 'processing' });
    return this.enqueueAutomatic(tab);
  }

  private enqueueAutomatic(tab: OrganizableTab): Promise<FirstPageOutcome> {
    return new Promise((resolve, reject) => {
      const items = this.pendingBatches.get(tab.windowId) ?? [];
      items.push({ tab, settled: false, resolve, reject });
      this.pendingBatches.set(tab.windowId, items);
      const existingTimer = this.batchTimers.get(tab.windowId);
      if (existingTimer !== undefined) clearTimeout(existingTimer);
      this.batchTimers.set(tab.windowId, setTimeout(() => {
        this.batchTimers.delete(tab.windowId);
        const batch = this.pendingBatches.get(tab.windowId) ?? [];
        this.pendingBatches.delete(tab.windowId);
        if (batch.length > 0) {
          this.batchTasks.push({
            windowId: tab.windowId,
            run: () => this.processAutomaticBatch(batch),
          });
          this.drainAutomaticBatches();
        }
      }, AUTOMATIC_BATCH_DELAY_MS));
    });
  }

  private drainAutomaticBatches(): void {
    while (
      this.activeBatchTasks < AUTOMATIC_MAX_CONCURRENT_REQUESTS &&
      this.batchTasks.length > 0
    ) {
      const taskIndex = this.batchTasks.findIndex(
        (candidate) => !this.activeBatchWindows.has(candidate.windowId),
      );
      if (taskIndex < 0) return;
      const [task] = this.batchTasks.splice(taskIndex, 1);
      if (task === undefined) return;
      this.activeBatchTasks += 1;
      this.activeBatchWindows.add(task.windowId);
      void task.run().catch(() => undefined).finally(() => {
        this.activeBatchTasks -= 1;
        this.activeBatchWindows.delete(task.windowId);
        this.drainAutomaticBatches();
      });
    }
  }

  private async processAutomaticBatch(items: AutomaticBatchItem[]): Promise<void> {
    try {
      const unlockedIds = new Set(
        (await this.locks.excludeLocked(items.map((item) => item.tab)))
          .map((tab) => tab.tabId),
      );
      const currentTabs = await Promise.all(
        items.map((item) => this.platform.getTab(item.tab.tabId)),
      );
      const eligibleItems: AutomaticBatchItem[] = [];
      for (const [index, item] of items.entries()) {
        const currentTab = currentTabs[index] ?? null;
        if (!unlockedIds.has(item.tab.tabId) || !matchesSnapshot(item.tab, currentTab)) {
          await this.completeBatchItem(item, 'skipped');
        } else {
          eligibleItems.push(item);
        }
      }
      if (eligibleItems.length === 0) return;

      const windowId = eligibleItems[0]?.tab.windowId;
      if (windowId === undefined) return;
      const groups = await this.platform.listGroups(windowId);
      const presets = await this.presets.list();
      const classifier = await this.createClassifier();
      if (!(await this.consumeAutomaticBudget())) {
        await Promise.all(eligibleItems.map((item) => this.failBatchItem(item)));
        return;
      }
      const decisions = await classifier.classify({
        mode: 'automatic',
        locale: this.getLocale(),
        tabs: eligibleItems.map(({ tab }) => ({
          ref: `tab-${tab.tabId}`,
          title: tab.title,
          hostname: getHostname(tab.url),
          currentGroup: null,
        })),
        groups: groups.map(({ ref, title, color }) => ({ ref, title, color })),
        presets,
      });

      const stillUnlockedIds = new Set(
        (await this.locks.excludeLocked(eligibleItems.map((item) => item.tab)))
          .map((tab) => tab.tabId),
      );
      const refreshedTabs = await Promise.all(
        eligibleItems.map((item) => this.platform.getTab(item.tab.tabId)),
      );
      for (const [index, item] of eligibleItems.entries()) {
        const { tab } = item;
        try {
          const decision = decisions.find((candidate) => candidate.tabRef === `tab-${tab.tabId}`);
          if (decision === undefined || decision.confidence < AUTOMATIC_CONFIDENCE_THRESHOLD) {
            await this.completeBatchItem(item, 'no_change');
            continue;
          }
          const currentTab = refreshedTabs[index] ?? null;
          if (!stillUnlockedIds.has(tab.tabId) || !matchesSnapshot(tab, currentTab)) {
            await this.completeBatchItem(item, 'skipped');
            continue;
          }

          if (decision.kind === 'existing_group' && decision.targetRef !== null) {
            const target = groups.find(
              (group) => group.ref === decision.targetRef && group.windowId === tab.windowId,
            );
            if (target !== undefined) {
              await this.platform.moveToExistingGroup(tab.tabId, target.groupId);
              await this.completeBatchItem(item, 'moved');
              continue;
            }
          }

          if (decision.kind === 'preset' && decision.targetRef !== null) {
            const target = presets.find((preset) => preset.id === decision.targetRef);
            if (target !== undefined) {
              await this.platform.moveToPreset(tab.tabId, tab.windowId, target.id);
              await this.completeBatchItem(item, 'moved');
              continue;
            }
          }

          await this.completeBatchItem(item, 'no_change');
        } catch {
          await this.failBatchItem(item);
        }
      }
    } catch {
      await Promise.all(items.filter((item) => !item.settled).map((item) => this.failBatchItem(item)));
    }
  }

  private async completeBatchItem(
    item: AutomaticBatchItem,
    result: 'moved' | 'no_change' | 'skipped',
  ): Promise<void> {
    if (item.settled) return;
    try {
      const outcome = await this.complete(item.tab.tabId, result);
      item.settled = true;
      item.resolve(outcome);
    } catch (error) {
      item.settled = true;
      item.reject(error);
    }
  }

  private async failBatchItem(item: AutomaticBatchItem): Promise<void> {
    if (item.settled) return;
    const failed: FirstPageOutcome = {
      status: 'failed',
      error: 'classification_failed',
    };
    try {
      await this.writeRecord(item.tab.tabId, failed);
      item.settled = true;
      item.resolve(failed);
    } catch (error) {
      item.settled = true;
      item.reject(error);
    }
  }

  private async isLocked(tabId: number): Promise<boolean> {
    const eligible = await this.locks.excludeLocked([{ tabId }]);
    return eligible.length === 0;
  }

  private async consumeAutomaticBudget(): Promise<boolean> {
    let consumed = false;
    const mutation = this.budgetMutation.then(async () => {
      const now = Date.now();
      const values = await this.storage.get([AUTOMATIC_BUDGET_KEY]);
      const budget = parseAutomaticClassificationBudget(values[AUTOMATIC_BUDGET_KEY]);
      const requestTimestamps = budget.requestTimestamps.filter(
        (timestamp) => timestamp > now - AUTOMATIC_BUDGET_WINDOW_MS,
      );
      if (requestTimestamps.length >= AUTOMATIC_BUDGET_MAX_REQUESTS) return;
      requestTimestamps.push(now);
      await this.storage.set({
        [AUTOMATIC_BUDGET_KEY]: { requestTimestamps },
      });
      consumed = true;
    });
    this.budgetMutation = mutation.then(() => undefined, () => undefined);
    await mutation;
    return consumed;
  }

  private async complete(
    tabId: number,
    result: 'moved' | 'no_change' | 'skipped',
  ): Promise<FirstPageOutcome> {
    const completed: FirstPageOutcome = { status: 'completed', result };
    await this.writeRecord(tabId, completed);
    return completed;
  }

  private async readRecord(tabId: number): Promise<FirstPageRecord | undefined> {
    const records = await this.readRecords();
    return records[String(tabId)];
  }

  private async readRecords(): Promise<FirstPageRecords> {
    const values = await this.storage.get([STATE_KEY]);
    return parseRecords(values[STATE_KEY]);
  }

  /**
   * Records an outcome for a tab that is still being tracked, and does nothing for one that is not.
   *
   * A classification request outlives the tab that prompted it. Closing a tab mid-run removes its
   * record, and the answer — or the failure of the whole batch — arrived afterwards and wrote it back
   * in. That resurrected row named a tab that no longer existed, so it showed a bare ID and a retry
   * that could never succeed. Only `registerCreated` introduces a record; everything after it is an
   * update to one that must already be there.
   */
  private async writeRecord(tabId: number, record: FirstPageRecord): Promise<void> {
    await this.mutateRecords((records) => {
      if (records[String(tabId)] === undefined) return;
      records[String(tabId)] = record;
    });
  }

  private async mutateRecords(change: (records: FirstPageRecords) => void): Promise<void> {
    const mutation = this.storageMutation.then(async () => {
      const records = await this.readRecords();
      change(records);
      await this.storage.set({ [STATE_KEY]: records });
    });
    this.storageMutation = mutation.catch(() => undefined);
    await mutation;
  }
}

function isReadyForDecision(tab: OrganizableTab): boolean {
  return (
    tab.status === 'complete' &&
    tab.title.trim().length > 0 &&
    tab.url.length > 0 &&
    tab.url !== 'about:blank' &&
    !tab.url.startsWith('chrome://newtab')
  );
}

function isExcluded(tab: OrganizableTab): boolean {
  return (
    tab.groupId >= 0 ||
    tab.restored ||
    tab.incognito ||
    (tab.splitViewId !== undefined && tab.splitViewId >= 0) ||
    getHostname(tab.url).length === 0
  );
}

function matchesSnapshot(
  expected: OrganizableTab,
  current: OrganizableTab | null,
): current is OrganizableTab {
  return current !== null &&
    current.tabId === expected.tabId &&
    current.windowId === expected.windowId &&
    current.title === expected.title &&
    current.url === expected.url &&
    current.groupId === expected.groupId &&
    !isExcluded(current);
}

function getHostname(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : '';
  } catch {
    return '';
  }
}

function parseRecords(value: unknown): FirstPageRecords {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const records: FirstPageRecords = {};
  for (const [key, record] of Object.entries(value)) {
    if (isFirstPageRecord(record)) {
      records[key] = record;
    }
  }
  return records;
}

function isFirstPageRecord(value: unknown): value is FirstPageRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.status === 'pending' || record.status === 'processing') {
    return true;
  }
  if (record.status === 'failed') {
    return record.error === 'classification_failed';
  }
  return (
    record.status === 'completed' &&
    (record.result === 'moved' || record.result === 'no_change' || record.result === 'skipped')
  );
}

function parseAutomaticClassificationBudget(value: unknown): AutomaticClassificationBudget {
  if (typeof value !== 'object' || value === null) {
    return { requestTimestamps: [] };
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.requestTimestamps)) {
    return { requestTimestamps: [] };
  }
  return {
    requestTimestamps: candidate.requestTimestamps.filter(
      (timestamp): timestamp is number => typeof timestamp === 'number' && Number.isFinite(timestamp),
    ),
  };
}
