import type {
  ClassificationDecision,
  ClassificationGroup,
  Classifier,
  TaxonomyPlanner,
} from './classifier';
/** A group as the interface needs to name it: the title and the color, nothing else. */
export interface GroupDescriptor {
  title: string;
  color: GroupColor;
}
import type { GroupColor, PresetStore } from './preset-store';
import { translations, type SupportedLocale } from '../shared/localization';
import { toClassificationHostname } from '../shared/tab-context';
import {
  DEFAULT_GROUPING_GRANULARITY,
  effectiveMinTabsPerNewGroup,
  maxGroupCount,
  type GroupingGranularity,
} from '../shared/grouping';
import { planTabOrder, type TabOrderPlatform, type TabOrderStep } from './tab-order';
import type { TabLockStore } from './tab-lock-store';
import type { TabPlacementStore } from './tab-placement-store';
import type { LocalStorageArea } from './settings-service';

export interface BrowserTab {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  groupId: number;
  incognito: boolean;
  splitViewId?: number;
}

export interface BrowserGroup extends ClassificationGroup {
  groupId: number;
  windowId: number;
}

/**
 * How much of the browser a review covers.
 *
 * `ungrouped` is the everyday one: tabs already in a group are the settled part of a window, and
 * sending them costs a request per five tabs while inviting the model to second-guess groups the
 * user is happy with. `active` narrows that to the one tab in front of you. `current` and `all`
 * remain because stored proposals from earlier runs carry them.
 */
export type ReviewScope = 'all' | 'current' | 'active' | 'ungrouped';

export interface SynchronizationPlatform {
  listTabs(scope: ReviewScope): Promise<BrowserTab[]>;
  listGroups(windowId: number): Promise<BrowserGroup[]>;
  getTab(tabId: number): Promise<BrowserTab | null>;
  moveToExistingGroup(tabIds: number[], groupId: number): Promise<void>;
  moveToNewGroup(
    tabIds: number[],
    windowId: number,
    title: string,
    color: GroupColor,
  ): Promise<number>;
}

export interface SynchronizationTarget extends GroupDescriptor {
  kind: 'existing_group' | 'preset' | 'new_group';
  ref: string | null;
  groupId: number | null;
  description: string | null;
}

export interface SynchronizationChange {
  tabId: number;
  windowId: number;
  title: string;
  hostname: string;
  currentGroup: GroupDescriptor | null;
  currentGroupId: number;
  target: SynchronizationTarget;
  confidence: number;
  reason: string;
  selected: boolean;
  blockedReason: 'split_view' | 'split_view_conflict' | null;
  splitViewId: number | null;
}

export type SynchronizationSkipReason = 'not_in_plan' | 'too_few_tabs';

/**
 * A group the run decided against creating, and why.
 *
 * Both gates below end in tabs staying put, and a single "unchanged" count cannot explain either.
 * Reporting the title the model asked for is what lets a user act: add a preset, or widen the
 * grouping breadth.
 */
export interface SynchronizationSkippedGroup {
  title: string;
  tabCount: number;
  reason: SynchronizationSkipReason;
  /** The floor a new group had to clear. Null when the title itself was refused. */
  minimumTabs: number | null;
}

/** A tab the run could not classify, named so it can be found rather than merely counted. */
export interface FailedTab {
  tabId: number;
  title: string;
  hostname: string;
}

export interface SynchronizationProposal {
  id: string;
  scope: ReviewScope;
  changes: SynchronizationChange[];
  unchangedCount: number;
  // Tabs whose chunk failed every attempt. They stay put, but silence would misreport coverage, and
  // a bare count leaves the user with no way to tell which tabs went unreviewed.
  failedTabs: FailedTab[];
  skippedGroups: SynchronizationSkippedGroup[];
  /**
   * Why the run had no plan to hold the chunks together, or null when it had one.
   *
   * Losing the plan is survivable but not neutral: chunks of five tabs then name groups without
   * knowing what the other chunks called the same thing, which is exactly how a window ends up with
   * a dozen one-tab groups that are all discarded as too small. Swallowing that made the outcome
   * look like a grouping decision rather than a failed request.
   */
  planFailureReason: string | null;
}

const PLAN_FAILURE_REASON_MAX_LENGTH = 120;

/**
 * Why a requested sort did not put a window in order.
 *
 * A sort that quietly does nothing is indistinguishable from a setting that never took effect,
 * which is exactly how it was reported.
 */
export type SortOutcome = 'move_refused' | 'unavailable';

export interface ApplyResult {
  applied: number;
  skipped: number;
  sortOutcome: SortOutcome | null;
}

interface StoredSynchronizationProposal {
  proposal: SynchronizationProposal;
  reviewedUrls: Record<string, string>;
}

const PROPOSAL_STORAGE_KEY = 'synchronizationProposal';
const SYNCHRONIZATION_MAX_CONCURRENT_WINDOWS = 2;

// Classification latency is bound by how fast the service emits output tokens, not by how much
// input it reads, so a window is split into small chunks that run concurrently. In-flight requests
// peak at SYNCHRONIZATION_MAX_CONCURRENT_WINDOWS times SYNCHRONIZATION_MAX_CONCURRENT_CHUNKS.
export const SYNCHRONIZATION_CHUNK_SIZE = 5;
export const SYNCHRONIZATION_MAX_CONCURRENT_CHUNKS = 10;
export const SYNCHRONIZATION_CHUNK_ATTEMPTS = 2;

export class SynchronizationService {
  private readonly proposals = new Map<string, {
    proposal: SynchronizationProposal;
    reviewedUrls: Map<number, string>;
  }>();
  private readonly applyTasks = new Map<string, Promise<ApplyResult>>();
  private proposalStorageMutation: Promise<void> = Promise.resolve();
  private operationMutation: Promise<void> = Promise.resolve();
  private reviewsInFlight = 0;

  constructor(
    private readonly classifier: Classifier,
    private readonly presets: PresetStore,
    private readonly locks: TabLockStore,
    private readonly platform: SynchronizationPlatform,
    private readonly getLocale: () => SupportedLocale,
    private readonly createProposalId: () => string,
    private readonly proposalStorage?: LocalStorageArea,
    private readonly taxonomyPlanner?: TaxonomyPlanner,
    private readonly getGranularity: () => GroupingGranularity = () => DEFAULT_GROUPING_GRANULARITY,
    private readonly getSendPathEnabled: () => boolean = () => false,
    // Read at apply time, not cached from the classification pass: a setting turned on while a
    // review sat waiting was still off by the time the tabs moved.
    private readonly getSortTabsEnabled: () => boolean | Promise<boolean> = () => false,
    private readonly tabOrder?: TabOrderPlatform,
    private readonly placements?: TabPlacementStore,
  ) {}

  /**
   * Puts the windows this apply touched into alphabetical order, when the user asked for that.
   *
   * Runs after the moves rather than instead of them, and never fails the apply: the tabs are
   * already where they belong, and a strip in the original order is a cosmetic loss. The previous
   * previous order is not recorded anywhere, so a sort cannot be reversed.
   */
  private async sortWindows(windowIds: number[]): Promise<SortOutcome | null> {
    const platform = this.tabOrder;
    if (platform === undefined || !(await this.getSortTabsEnabled())) return null;
    let outcome: SortOutcome | null = null;
    for (const windowId of windowIds) {
      let steps: TabOrderStep[] = [];
      try {
        const groups = await this.platform.listGroups(windowId);
        const presetNames = (await this.presets.list()).map((preset) => preset.name);
        steps = planTabOrder(await platform.listWindowTabs(windowId), groups, presetNames);
      } catch {
        outcome ??= 'unavailable';
        continue;
      }
      // One refused move must not abandon the rest of the strip: a half-sorted window reads as the
      // feature being broken, and the reason is worth reporting rather than swallowing.
      for (const step of steps) {
        try {
          if (step.kind === 'group') {
            await platform.moveGroup(step.groupId, step.index);
          } else {
            await platform.moveTabs(step.tabIds, step.index);
          }
        } catch {
          outcome ??= 'move_refused';
        }
      }
    }
    return outcome;
  }

  // One bad chunk must not discard the rest of the window, so failures stay local and retry once.
  private async classifyChunk(
    chunk: BrowserTab[],
    groups: BrowserGroup[],
    classificationGroups: ClassificationGroup[],
    presets: Awaited<ReturnType<PresetStore['list']>>,
    approvedGroupTitles: string[] | undefined,
    failures: unknown[],
  ): Promise<ClassificationDecision[] | null> {
    const request = {
      mode: 'synchronization' as const,
      locale: this.getLocale(),
      tabs: chunk.map((tab) => ({
        ref: `tab-${tab.tabId}`,
        title: tab.title,
        hostname: toClassificationHostname(tab.url, this.getSendPathEnabled()),
        currentGroup: toClassificationGroup(groups.find((group) => group.groupId === tab.groupId)),
      })),
      groups: classificationGroups,
      presets,
      ...(approvedGroupTitles === undefined ? {} : { approvedGroupTitles }),
    };
    let lastFailure: unknown;
    for (let attempt = 0; attempt < SYNCHRONIZATION_CHUNK_ATTEMPTS; attempt += 1) {
      try {
        return await this.classifier.classify(request);
      } catch (error: unknown) {
        lastFailure = error;
      }
    }
    failures.push(lastFailure);
    return null;
  }

  // A single chunk cannot disagree with itself, so the extra round trip only pays off past that.
  private async planApprovedTitles(
    tabs: BrowserTab[],
    groups: ClassificationGroup[],
    presets: Awaited<ReturnType<PresetStore['list']>>,
    planFailures: string[],
  ): Promise<string[] | undefined> {
    if (this.taxonomyPlanner === undefined || tabs.length <= SYNCHRONIZATION_CHUNK_SIZE) {
      return undefined;
    }
    const request = {
      locale: this.getLocale(),
      tabs: tabs.map((tab) => ({
        ref: `tab-${tab.tabId}`,
        title: tab.title,
        hostname: toClassificationHostname(tab.url, this.getSendPathEnabled()),
      })),
      groups,
      presets,
      maxTitles: maxGroupCount(this.getGranularity(), tabs.length),
    };
    // Without a plan the chunks invent rival names, so this pass earns the same retry as a chunk.
    let lastFailure = 'taxonomy_unavailable';
    for (let attempt = 0; attempt < SYNCHRONIZATION_CHUNK_ATTEMPTS; attempt += 1) {
      try {
        const entries = await this.taxonomyPlanner.plan(request);
        const titles = entries.map((entry) => entry.title);
        if (titles.length > 0) return titles;
        lastFailure = 'taxonomy_empty_plan';
        break;
      } catch (error: unknown) {
        // Chunking alone still produces a proposal, so the run continues and reports the reason.
        lastFailure = error instanceof Error ? error.message : 'taxonomy_failed';
        // A second identical request would spend the same budget and hit the same ceiling, and the
        // window waits the whole time for a plan it will not get.
        if (isTimeout(lastFailure)) break;
      }
    }
    planFailures.push(lastFailure.slice(0, PLAN_FAILURE_REASON_MAX_LENGTH));
    return undefined;
  }

  async review(scope: ReviewScope): Promise<SynchronizationProposal> {
    this.reviewsInFlight += 1;
    try {
      return await this.enqueueOperation(() => this.reviewOnce(scope));
    } finally {
      this.reviewsInFlight -= 1;
    }
  }

  /**
   * Whether a review is running right now.
   *
   * Deliberately held in memory rather than in storage. The run lives in this worker, so if the
   * worker is gone the run is gone with it, and a persisted flag would keep claiming progress that
   * nothing is making. The popup asks this on open because a run outlives the window that started
   * it, and reopening mid-run otherwise looks like nothing ever happened.
   */
  isReviewing(): boolean {
    return this.reviewsInFlight > 0;
  }

  private async reviewOnce(scope: ReviewScope): Promise<SynchronizationProposal> {
    const allTabs = await this.platform.listTabs(scope === 'ungrouped' ? 'current' : scope);
    const unlockedTabs = await this.locks.excludeLocked(allTabs);
    // A grouped tab is only settled once it has been examined and has stayed put since. The first
    // review of a session therefore looks at every group; later ones only at what has moved.
    const inspected = unlockedTabs.map((tab) => ({
      tabId: tab.tabId, groupId: tab.groupId, hostname: getHostname(tab.url),
    }));
    const unsettled = scope === 'ungrouped' && this.placements !== undefined
      ? new Set(await this.placements.unsettledTabIds(inspected))
      : new Set<number>();
    const eligible = unlockedTabs.filter((tab) => !tab.incognito && getHostname(tab.url) !== '' &&
      (scope !== 'ungrouped' || tab.groupId < 0 || unsettled.has(tab.tabId)));
    const presets = await this.presets.list();

    const windowIds = [...new Set(eligible.map((tab) => tab.windowId))];
    const failures: unknown[] = [];
    const planFailures: string[] = [];
    let attemptedChunks = 0;
    let succeededChunks = 0;
    const windowResults = await mapWithConcurrency(
      windowIds,
      SYNCHRONIZATION_MAX_CONCURRENT_WINDOWS,
      async (windowId): Promise<{
        changes: SynchronizationChange[];
        unchangedCount: number;
        failedTabs: FailedTab[];
        skippedGroups: SynchronizationSkippedGroup[];
      }> => {
      const windowTabs = eligible.filter((tab) => tab.windowId === windowId);
      // Cues are matched here, against the full local URL, so a path can decide a group without
      // ever being transmitted. The model only sees what is left over.
      const cueDecisions: ClassificationDecision[] = [];
      const tabs: BrowserTab[] = [];
      for (const tab of windowTabs) {
        const preset = matchPresetByCue(tab, presets);
        if (preset === undefined) {
          tabs.push(tab);
          continue;
        }
        cueDecisions.push({
          tabRef: `tab-${tab.tabId}`,
          kind: 'preset',
          targetRef: preset.id,
          suggestedName: null,
          suggestedDescription: null,
          confidence: 1,
          reason: translations[this.getLocale()].cueMatchReason,
        });
      }
      const groups = await this.platform.listGroups(windowId);
      const classificationGroups = groups.map(({ ref, title, color }) => ({ ref, title, color }));
      const approvedGroupTitles = await this.planApprovedTitles(
        tabs, classificationGroups, presets, planFailures,
      );
      const chunks = chunkList(tabs, SYNCHRONIZATION_CHUNK_SIZE);
      const chunkedDecisions = await mapWithConcurrency(
        chunks,
        SYNCHRONIZATION_MAX_CONCURRENT_CHUNKS,
        (chunk) => this.classifyChunk(
          chunk, groups, classificationGroups, presets, approvedGroupTitles, failures,
        ),
      );
      attemptedChunks += chunks.length;
      succeededChunks += chunkedDecisions.filter((result) => result !== null).length;
      const decisions = [
        ...cueDecisions,
        ...chunkedDecisions.flatMap((chunkResult) => chunkResult ?? []),
      ];
      const failedTabs = chunks.flatMap((chunk, index) => chunkedDecisions[index] === null
        ? chunk.map((tab) => ({
          tabId: tab.tabId, title: tab.title, hostname: getHostname(tab.url),
        }))
        : []);

      const changes: SynchronizationChange[] = [];
      const canonicalTitles = new Map<string, string>();
      const assignedColors = new Map<string, GroupColor>();
      const plannedTitles = approvedGroupTitles === undefined
        ? undefined
        : toPlannedTitles(approvedGroupTitles);
      const skippedGroups = new Map<string, SynchronizationSkippedGroup>();
      let unchangedCount = 0;
      for (const decision of decisions) {
        const tabId = parseTabRef(decision.tabRef);
        const tab = windowTabs.find((candidate) => candidate.tabId === tabId);
        if (tab === undefined || decision.kind === 'no_change') {
          unchangedCount += 1;
          continue;
        }
        const resolution = resolveTarget(
          decision, groups, presets, canonicalTitles, assignedColors, plannedTitles,
        );
        if (resolution.outcome === 'invalid') throw new Error('synchronization_invalid_target');
        if (resolution.outcome === 'unchanged') {
          unchangedCount += 1;
          continue;
        }
        if (resolution.outcome === 'rejected_title') {
          unchangedCount += 1;
          recordSkippedGroup(skippedGroups, resolution.title, 1, 'not_in_plan', null);
          continue;
        }
        const target = resolution.target;
        const current = groups.find((group) => group.groupId === tab.groupId);
        if (
          (target.kind === 'existing_group' && target.groupId === tab.groupId) ||
          (target.kind === 'preset' && current !== undefined &&
            current.title === target.title && current.color === target.color)
        ) {
          unchangedCount += 1;
          continue;
        }
        // Measured on Chrome 140: a split pair with no group is reported here and blocked, while a
        // pair inside a tab group arrives without a split id and is treated as two ordinary tabs.
        const splitView = tab.splitViewId !== undefined && tab.splitViewId >= 0;
        changes.push({
          tabId,
          windowId,
          title: tab.title,
          hostname: getHostname(tab.url),
          currentGroup: current === undefined ? null : { title: current.title, color: current.color },
          currentGroupId: tab.groupId,
          target,
          confidence: decision.confidence,
          reason: decision.reason,
          selected: !splitView,
          blockedReason: splitView ? 'split_view' : null,
          splitViewId: tab.splitViewId ?? null,
        });
      }
      // A one-tab review is an explicit request about that tab, so the floor that stops a bulk run
      // from fragmenting a window has nothing to guard here.
      const minimumTabs = scope === 'active'
        ? 1
        : effectiveMinTabsPerNewGroup(this.getGranularity(), tabs.length);
      const { kept, dropped } = withoutUndersizedNewGroups(changes, minimumTabs);
      for (const group of dropped) {
        recordSkippedGroup(skippedGroups, group.title, group.tabCount, 'too_few_tabs', minimumTabs);
      }
      return {
        changes: kept,
        unchangedCount: unchangedCount + (changes.length - kept.length),
        failedTabs,
        skippedGroups: [...skippedGroups.values()],
      };
      },
    );
    // Losing a chunk is recoverable, but losing every chunk means classification itself is broken.
    if (attemptedChunks > 0 && succeededChunks === 0) {
      throw failures[0] ?? new Error('classification_request_failed');
    }
    const changes = windowResults.flatMap((result) => result.changes);
    const unchangedCount = windowResults.reduce((total, result) => total + result.unchangedCount, 0);
    const failedTabs = windowResults.flatMap((result) => result.failedTabs);
    const skippedGroups = mergeSkippedGroups(
      windowResults.flatMap((result) => result.skippedGroups),
    );

    // Everything grouped that this run looked at counts as examined now, whatever the user does with
    // the proposal: asking again on the next run would make the review expensive forever.
    await this.placements?.record(inspected
      .filter((tab) => tab.groupId >= 0 && tab.hostname !== '')
      .map((tab) => ({ tabId: tab.tabId, hostname: tab.hostname })));

    markSplitViewConflicts(changes);
    const proposal: SynchronizationProposal = {
      id: this.createProposalId(), scope, changes, unchangedCount, failedTabs, skippedGroups,
      planFailureReason: planFailures[0] ?? null,
    };
    this.proposals.clear();
    this.proposals.set(proposal.id, {
      proposal,
      reviewedUrls: new Map(eligible.map((tab) => [tab.tabId, tab.url])),
    });
    await this.persistProposal({
      proposal,
      reviewedUrls: Object.fromEntries(eligible.map((tab) => [String(tab.tabId), tab.url])),
    });
    return proposal;
  }

  /**
   * Returns the proposal that is still awaiting a decision, or null when none is pending.
   *
   * The popup closes whenever it loses focus, so the review list has to survive outside the UI. A
   * proposal disappears from here once it is applied or replaced by a newer review.
   */
  async latestProposal(): Promise<SynchronizationProposal | null> {
    const [cached] = [...this.proposals.values()];
    if (cached !== undefined) return cached.proposal;
    if (this.proposalStorage === undefined) return null;
    const values = await this.proposalStorage.get([PROPOSAL_STORAGE_KEY]);
    const stored = parseStoredProposal(values[PROPOSAL_STORAGE_KEY]);
    if (stored === null) return null;
    this.proposals.set(stored.proposal.id, {
      proposal: stored.proposal,
      reviewedUrls: new Map(
        Object.entries(stored.reviewedUrls).map(([tabId, url]) => [Number(tabId), url]),
      ),
    });
    return stored.proposal;
  }

  async apply(proposalId: string, selectedTabIds: number[]): Promise<ApplyResult> {
    const active = this.applyTasks.get(proposalId);
    if (active !== undefined) return active;
    const task = this.enqueueOperation(() => this.applyOnce(proposalId, selectedTabIds));
    this.applyTasks.set(proposalId, task);
    try {
      return await task;
    } finally {
      if (this.applyTasks.get(proposalId) === task) this.applyTasks.delete(proposalId);
    }
  }

  private async applyOnce(proposalId: string, selectedTabIds: number[]): Promise<ApplyResult> {
    const storedProposal = await this.loadProposal(proposalId);
    if (storedProposal === undefined) throw new Error('proposal_not_found');
    const proposal = storedProposal.proposal;
    const selected = new Set(selectedTabIds);
    const valid: SynchronizationChange[] = [];
    let skipped = 0;

    const candidates = proposal.changes.filter(
      (change) => selected.has(change.tabId) && change.blockedReason === null,
    );
    const unlockedIds = new Set((await this.locks.excludeLocked(candidates)).map((change) => change.tabId));
    const currentTabs = new Map(
      (await this.platform.listTabs('all')).map((tab) => [tab.tabId, tab]),
    );
    const groupsByWindow = new Map<number, BrowserGroup[]>();

    const getGroups = async (windowId: number): Promise<BrowserGroup[]> => {
      const cached = groupsByWindow.get(windowId);
      if (cached !== undefined) return cached;
      const groups = await this.platform.listGroups(windowId);
      groupsByWindow.set(windowId, groups);
      return groups;
    };

    for (const change of proposal.changes) {
      if (!selected.has(change.tabId) || change.blockedReason !== null) continue;
      if (!unlockedIds.has(change.tabId)) {
        skipped += 1;
        continue;
      }
      const tab = currentTabs.get(change.tabId) ?? null;
      if (
        tab === null ||
        tab.windowId !== change.windowId ||
        tab.incognito ||
        tab.url !== storedProposal.reviewedUrls.get(change.tabId) ||
        tab.title !== change.title ||
        tab.groupId !== change.currentGroupId ||
        (tab.splitViewId !== undefined && tab.splitViewId >= 0)
      ) {
        skipped += 1;
        continue;
      }
      if (change.target.kind === 'existing_group' || change.target.kind === 'preset') {
        const groups = await getGroups(change.windowId);
        const target = groups.find((group) => group.groupId === change.target.groupId) ??
          findGroupByTitle(groups, change.target.title);
        if (target === undefined && change.target.kind === 'existing_group') {
          skipped += 1;
          continue;
        }
        if (target !== undefined) change.target.groupId = target.groupId;
      } else {
        // A new_group title can already name a live group: an earlier run created it, or the user
        // did. Joining it keeps one group per name instead of a second one beside it.
        const existing = findGroupByTitle(await getGroups(change.windowId), change.target.title);
        if (existing !== undefined) change.target.groupId = existing.groupId;
      }
      valid.push(change);
    }

    // The windows the user asked to act on, whether or not a move survived the recheck. Sorting is
    // gated on the setting alone: a window that was already grouped correctly still gets the order
    // the setting asks for, which is what pressing Apply with the box ticked has to mean.
    const selectedWindowIds = [...new Set(
      proposal.changes.filter((change) => selected.has(change.tabId)).map((change) => change.windowId),
    )];
    if (valid.length === 0) {
      await this.removeProposal(proposalId);
      return { applied: 0, skipped, sortOutcome: await this.sortWindows(selectedWindowIds) };
    }

    const grouped = new Map<string, SynchronizationChange[]>();
    for (const change of valid) {
      const key = change.target.groupId === null
        ? `${change.windowId}:new:${normalizeGroupTitle(change.target.title)}`
        : `${change.windowId}:existing:${change.target.groupId}`;
      const bucket = grouped.get(key);
      if (bucket === undefined) {
        grouped.set(key, [change]);
      } else {
        bucket.push(change);
      }
    }
    let applied = 0;
    for (const bucket of grouped.values()) {
      const first = bucket[0];
      if (first === undefined) continue;
      const unlockedBucketIds = new Set(
        (await this.locks.excludeLocked(bucket)).map((change) => change.tabId),
      );
      const refreshedTabs = await Promise.all(
        bucket.map((change) => this.platform.getTab(change.tabId)),
      );
      let targetExists = true;
      if (first.target.groupId !== null) {
        const groups = await this.platform.listGroups(first.windowId);
        targetExists = groups.some((group) => group.groupId === first.target.groupId);
      }
      const currentBucket = bucket.filter((change, index) => {
        const tab = refreshedTabs[index] ?? null;
        return targetExists && unlockedBucketIds.has(change.tabId) && tab !== null &&
          tab.windowId === change.windowId && !tab.incognito &&
          tab.url === storedProposal.reviewedUrls.get(change.tabId) &&
          tab.title === change.title && tab.groupId === change.currentGroupId &&
          (tab.splitViewId === undefined || tab.splitViewId < 0);
      });
      skipped += bucket.length - currentBucket.length;
      if (currentBucket.length === 0) continue;
      try {
        if (first.target.groupId !== null) {
          await this.platform.moveToExistingGroup(
            currentBucket.map((change) => change.tabId),
            first.target.groupId,
          );
        } else {
          await this.platform.moveToNewGroup(
            currentBucket.map((change) => change.tabId),
            first.windowId,
            first.target.title,
            first.target.color,
          );
        }
        applied += currentBucket.length;
      } catch {
        skipped += currentBucket.length;
        continue;
      }
    }
    await this.removeProposal(proposalId);
    // What each moved tab was showing when it was grouped, so a later navigation can be noticed.
    await this.placements?.record(valid.flatMap((change) => {
      const hostname = getHostname(storedProposal.reviewedUrls.get(change.tabId) ?? '');
      return hostname === '' ? [] : [{ tabId: change.tabId, hostname }];
    }));
    return { applied, skipped, sortOutcome: await this.sortWindows(selectedWindowIds) };
  }


  private async persistProposal(stored: StoredSynchronizationProposal): Promise<void> {
    if (this.proposalStorage === undefined) return;
    const mutation = this.proposalStorageMutation.then(async () => {
      await this.proposalStorage?.set({ [PROPOSAL_STORAGE_KEY]: stored });
    });
    this.proposalStorageMutation = mutation.then(() => undefined, () => undefined);
    await mutation;
  }

  private async loadProposal(proposalId: string) {
    const cached = this.proposals.get(proposalId);
    if (cached !== undefined) return cached;
    if (this.proposalStorage === undefined) return undefined;
    const values = await this.proposalStorage.get([PROPOSAL_STORAGE_KEY]);
    const stored = parseStoredProposal(values[PROPOSAL_STORAGE_KEY]);
    if (stored === null || stored.proposal.id !== proposalId) return undefined;
    const hydrated = {
      proposal: stored.proposal,
      reviewedUrls: new Map(
        Object.entries(stored.reviewedUrls).map(([tabId, url]) => [Number(tabId), url]),
      ),
    };
    this.proposals.set(proposalId, hydrated);
    return hydrated;
  }

  private async removeProposal(proposalId: string): Promise<void> {
    this.proposals.delete(proposalId);
    if (this.proposalStorage === undefined) return;
    const mutation = this.proposalStorageMutation.then(async () => {
      const values = await this.proposalStorage?.get([PROPOSAL_STORAGE_KEY]);
      const stored = parseStoredProposal(values?.[PROPOSAL_STORAGE_KEY]);
      if (stored?.proposal.id === proposalId) {
        await this.proposalStorage?.remove([PROPOSAL_STORAGE_KEY]);
      }
    });
    this.proposalStorageMutation = mutation.then(() => undefined, () => undefined);
    await mutation;
  }

  private async enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.operationMutation.then(operation);
    this.operationMutation = mutation.then(() => undefined, () => undefined);
    return mutation;
  }
}

/**
 * Recognizes a request that ran out of time rather than one that came back wrong.
 *
 * The timeout is raised here, but the abort can surface either as this project's own timeout error
 * or as the platform's `AbortError`, whose message reads "signal is aborted without reason".
 */
function isTimeout(message: string): boolean {
  return message.includes('timeout') || message.toLowerCase().includes('abort');
}

async function mapWithConcurrency<Input, Output>(
  inputs: Input[],
  limit: number,
  worker: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const input = inputs[index];
      if (input !== undefined) results[index] = await worker(input);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, inputs.length) }, () => run()),
  );
  return results;
}

/**
 * Drops new-group proposals that did not attract enough tabs to be worth a group.
 *
 * Chunks decide independently and cannot see how many other tabs share a proposed title, so a
 * title can end up owning one or two tabs. Creating a Chrome group for those adds clutter without
 * organizing anything. Membership in a group that already exists is untouched: the cost of a new
 * group is what this guards, not the assignment itself.
 */
/**
 * Finds the preset whose text cue appears in a tab, checking the whole local URL.
 *
 * The classifier only ever receives a hostname, so a ticket key living in the path is invisible to
 * it. Matching here recovers that signal at zero transmission cost and is exact rather than
 * inferred. The longest matching cue wins because a longer cue is the more deliberate signal; an
 * exact tie is left to the model rather than resolved arbitrarily.
 */
function matchPresetByCue(
  tab: BrowserTab,
  presets: Awaited<ReturnType<PresetStore['list']>>,
): Awaited<ReturnType<PresetStore['list']>>[number] | undefined {
  const haystack = `${tab.title} ${tab.url}`.toLowerCase();
  let best: { preset: Awaited<ReturnType<PresetStore['list']>>[number]; length: number } | undefined;
  let tied = false;
  for (const preset of presets) {
    for (const cue of preset.cues) {
      const needle = cue.trim().toLowerCase();
      if (needle.length === 0 || !haystack.includes(needle)) continue;
      if (best === undefined || needle.length > best.length) {
        best = { preset, length: needle.length };
        tied = false;
      } else if (needle.length === best.length && best.preset.id !== preset.id) {
        tied = true;
      }
    }
  }
  return tied ? undefined : best?.preset;
}

function withoutUndersizedNewGroups(
  changes: SynchronizationChange[],
  minimumTabs: number,
): { kept: SynchronizationChange[]; dropped: { title: string; tabCount: number }[] } {
  const counts = new Map<string, { title: string; tabCount: number }>();
  for (const change of changes) {
    if (change.target.kind !== 'new_group') continue;
    const key = normalizeGroupTitle(change.target.title);
    const entry = counts.get(key);
    if (entry === undefined) {
      counts.set(key, { title: change.target.title, tabCount: 1 });
    } else {
      entry.tabCount += 1;
    }
  }
  return {
    kept: changes.filter((change) => {
      if (change.target.kind !== 'new_group') return true;
      const entry = counts.get(normalizeGroupTitle(change.target.title));
      return (entry?.tabCount ?? 0) >= minimumTabs;
    }),
    dropped: [...counts.values()].filter((entry) => entry.tabCount < minimumTabs),
  };
}

function recordSkippedGroup(
  into: Map<string, SynchronizationSkippedGroup>,
  title: string,
  tabCount: number,
  reason: SynchronizationSkipReason,
  minimumTabs: number | null,
): void {
  const key = `${reason}:${normalizeGroupTitle(title)}`;
  const existing = into.get(key);
  if (existing === undefined) {
    into.set(key, { title, tabCount, reason, minimumTabs });
    return;
  }
  existing.tabCount += tabCount;
}

/** Windows are classified independently, so the same title can be refused in more than one. */
function mergeSkippedGroups(entries: SynchronizationSkippedGroup[]): SynchronizationSkippedGroup[] {
  const merged = new Map<string, SynchronizationSkippedGroup>();
  for (const entry of entries) {
    const key = `${entry.reason}:${normalizeGroupTitle(entry.title)}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...entry });
      continue;
    }
    existing.tabCount += entry.tabCount;
    existing.minimumTabs = existing.minimumTabs === null || entry.minimumTabs === null
      ? existing.minimumTabs ?? entry.minimumTabs
      : Math.max(existing.minimumTabs, entry.minimumTabs);
  }
  return [...merged.values()];
}

function chunkList<Item>(items: Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function markSplitViewConflicts(changes: SynchronizationChange[]): void {
  const splitIds = [...new Set(changes.map((change) => change.splitViewId).filter((id): id is number => id !== null))];
  for (const splitViewId of splitIds) {
    const pair = changes.filter((change) => change.splitViewId === splitViewId);
    const targets = new Set(pair.map((change) => `${change.target.kind}:${change.target.ref ?? change.target.title}`));
    if (pair.length > 1 && targets.size > 1) {
      for (const change of pair) change.blockedReason = 'split_view_conflict';
    }
  }
}

export function normalizeGroupTitle(title: string): string {
  return title.trim().toLowerCase();
}

// Grey is what an unstyled Chrome group looks like, so a group this extension named should not be
// indistinguishable from one the user made by hand.
const NEW_GROUP_COLORS: GroupColor[] = [
  'blue', 'green', 'purple', 'orange', 'pink', 'cyan', 'red', 'yellow',
];

/** The color a title maps to, before collisions within the window are taken into account. */
export function preferredGroupColor(title: string): GroupColor {
  let hash = 0;
  for (const character of normalizeGroupTitle(title)) {
    hash = (hash * 31 + character.charCodeAt(0)) % 1_000_003;
  }
  return NEW_GROUP_COLORS[hash % NEW_GROUP_COLORS.length] ?? 'blue';
}

/**
 * Picks a color for a group this run is about to create.
 *
 * The starting point comes from the title, so a project keeps its color between runs rather than
 * changing every time the tabs are reviewed. From there it steps forward until it finds a color no
 * other group in the same window is already using, because two same-colored groups side by side are
 * harder to tell apart than a group whose color moved.
 */
function assignGroupColor(
  title: string,
  groups: BrowserGroup[],
  assigned: Map<string, GroupColor>,
): GroupColor {
  const normalized = normalizeGroupTitle(title);
  const already = assigned.get(normalized);
  if (already !== undefined) return already;

  const taken = new Set<GroupColor>([
    ...groups.map((group) => group.color),
    ...assigned.values(),
  ]);
  const start = NEW_GROUP_COLORS.indexOf(preferredGroupColor(normalized));
  for (let step = 0; step < NEW_GROUP_COLORS.length; step += 1) {
    const candidate = NEW_GROUP_COLORS[(start + step) % NEW_GROUP_COLORS.length] ?? 'blue';
    if (!taken.has(candidate)) {
      assigned.set(normalized, candidate);
      return candidate;
    }
  }
  // Every color is in use, so the title decides and a repeat is accepted.
  const fallback = preferredGroupColor(normalized);
  assigned.set(normalized, fallback);
  return fallback;
}

/**
 * Finds a live group by title alone.
 *
 * Color is deliberately not part of the identity: it is cosmetic, the user is free to recolor a
 * group later, and a preset carries its own color. Matching on color as well is what produced two
 * groups with the same name.
 */
function findGroupByTitle(groups: BrowserGroup[], title: string): BrowserGroup | undefined {
  const normalized = normalizeGroupTitle(title);
  return groups.find((candidate) => normalizeGroupTitle(candidate.title) === normalized);
}

interface PlannedTitle {
  title: string;
  tokens: string[];
}

/** Splits a title into whole words so matching can never fire on part of one. */
function titleTokens(title: string): string[] {
  return normalizeGroupTitle(title)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Prepares the planned titles for matching, dropping ones too short to identify a group.
 *
 * A one-character title would claim every tab that happens to contain that character, which is a
 * worse outcome than leaving those tabs alone.
 */
function toPlannedTitles(titles: string[]): PlannedTitle[] {
  return titles
    .map((title) => ({ title: title.trim(), tokens: titleTokens(title) }))
    .filter((entry) => entry.title.length > 0 && entry.tokens.join('').length >= 2);
}

function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((token, index) => haystack[start + index] === token)) return true;
  }
  return false;
}

/**
 * Maps a proposed new-group title onto the planned title it belongs to.
 *
 * The plan is a whitelist, and a chunk routinely proposes a variant of a planned name — "ForgeHub
 * Iter 1" where the plan says "ForgeHub". Demanding the exact string dropped those tabs even though
 * the concept was approved, and it split the count that decides whether the group is worth creating
 * at all. Matching runs on whole words in order, in either direction, so "Hub" can never claim
 * "ForgeHub". The longest planned title wins because it is the more specific one; when two planned
 * titles match equally well the tab is left alone rather than assigned arbitrarily, which is how a
 * tied text cue is treated.
 */
function canonicalizeAgainstPlan(title: string, plan: PlannedTitle[]): string | undefined {
  const tokens = titleTokens(title);
  if (tokens.length === 0) return undefined;
  let best: { title: string; score: number } | undefined;
  let tied = false;
  for (const entry of plan) {
    if (!containsTokenRun(tokens, entry.tokens) && !containsTokenRun(entry.tokens, tokens)) continue;
    const score = entry.tokens.join('').length;
    if (best === undefined || score > best.score) {
      best = { title: entry.title, score };
      tied = false;
    } else if (
      score === best.score &&
      normalizeGroupTitle(entry.title) !== normalizeGroupTitle(best.title)
    ) {
      tied = true;
    }
  }
  return tied ? undefined : best?.title;
}

type TargetResolution =
  | { outcome: 'target'; target: SynchronizationTarget }
  | { outcome: 'unchanged' }
  // The model asked for a group the plan does not allow. The title is reported, not silently lost.
  | { outcome: 'rejected_title'; title: string }
  | { outcome: 'invalid' };

function resolveTarget(
  decision: Awaited<ReturnType<Classifier['classify']>>[number],
  groups: BrowserGroup[],
  presets: Awaited<ReturnType<PresetStore['list']>>,
  canonicalTitles: Map<string, string>,
  assignedColors: Map<string, GroupColor>,
  plan: PlannedTitle[] | undefined,
): TargetResolution {
  if (decision.kind === 'existing_group') {
    const group = groups.find((candidate) => candidate.ref === decision.targetRef);
    return group === undefined ? { outcome: 'invalid' } : {
      outcome: 'target',
      target: {
        kind: 'existing_group', ref: group.ref, groupId: group.groupId, title: group.title,
        color: group.color, description: null,
      },
    };
  }
  if (decision.kind === 'preset') {
    const preset = presets.find((candidate) => candidate.id === decision.targetRef);
    if (preset === undefined) return { outcome: 'invalid' };
    // A preset names a group that may already exist from an earlier run. Reuse it instead of asking
    // for a new group, which Chrome would happily create beside the one with the same name.
    const existing = findGroupByTitle(groups, preset.name);
    if (existing !== undefined) {
      return {
        outcome: 'target',
        target: {
          kind: 'existing_group', ref: existing.ref, groupId: existing.groupId,
          title: existing.title, color: existing.color, description: null,
        },
      };
    }
    return {
      outcome: 'target',
      target: {
        kind: 'preset', ref: preset.id, groupId: null, title: preset.name, color: preset.color,
        description: preset.description,
      },
    };
  }
  if (decision.kind === 'new_group' && decision.suggestedName !== null) {
    const proposed = decision.suggestedName.trim();
    if (proposed.length === 0) return { outcome: 'unchanged' };

    // A title that already names a group or preset must reuse it; the apply path has no dedup. This
    // runs before the plan is consulted, because joining what exists is never a new group.
    const reused = reuseByTitle(proposed, groups, presets);
    if (reused !== undefined) return { outcome: 'target', target: reused };

    let title = proposed;
    if (plan !== undefined) {
      const planned = canonicalizeAgainstPlan(proposed, plan);
      if (planned === undefined) return { outcome: 'rejected_title', title: proposed };
      title = planned;
      // Folding a variant onto its planned title can land on a group or preset that already exists.
      const plannedReuse = reuseByTitle(title, groups, presets);
      if (plannedReuse !== undefined) return { outcome: 'target', target: plannedReuse };
    }

    // Chunks propose the same group independently, so one casing wins for the whole window.
    const normalized = normalizeGroupTitle(title);
    const canonical = canonicalTitles.get(normalized);
    if (canonical === undefined) canonicalTitles.set(normalized, title);
    return {
      outcome: 'target',
      target: {
        kind: 'new_group', ref: null, groupId: null, title: canonical ?? title,
        color: assignGroupColor(canonical ?? title, groups, assignedColors),
        description: decision.suggestedDescription,
      },
    };
  }
  return { outcome: 'invalid' };
}

function reuseByTitle(
  title: string,
  groups: BrowserGroup[],
  presets: Awaited<ReturnType<PresetStore['list']>>,
): SynchronizationTarget | undefined {
  const group = findGroupByTitle(groups, title);
  if (group !== undefined) {
    return {
      kind: 'existing_group', ref: group.ref, groupId: group.groupId, title: group.title,
      color: group.color, description: null,
    };
  }
  const normalized = normalizeGroupTitle(title);
  const preset = presets.find((candidate) => normalizeGroupTitle(candidate.name) === normalized);
  return preset === undefined ? undefined : {
    kind: 'preset', ref: preset.id, groupId: null, title: preset.name, color: preset.color,
    description: preset.description,
  };
}

function toClassificationGroup(group: BrowserGroup | undefined): ClassificationGroup | null {
  return group === undefined ? null : { ref: group.ref, title: group.title, color: group.color };
}

function parseTabRef(value: string): number {
  const result = /^tab-(\d+)$/.exec(value);
  return result === null ? Number.NaN : Number(result[1]);
}

function getHostname(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : '';
  } catch {
    return '';
  }
}

function parseStoredProposal(value: unknown): StoredSynchronizationProposal | null {
  if (!isRecord(value) || !isRecord(value.proposal) || !isRecord(value.reviewedUrls)) return null;
  const proposal = parseProposal(value.proposal);
  if (proposal === null) return null;
  const reviewedUrls: Record<string, string> = {};
  for (const [tabId, url] of Object.entries(value.reviewedUrls)) {
    if (!/^\d+$/.test(tabId) || typeof url !== 'string') return null;
    reviewedUrls[tabId] = url;
  }
  return { proposal, reviewedUrls };
}

function parseProposal(value: Record<string, unknown>): SynchronizationProposal | null {
  if (
    typeof value.id !== 'string' || !isReviewScope(value.scope) ||
    typeof value.unchangedCount !== 'number' ||
    !Array.isArray(value.changes)
  ) {
    return null;
  }
  const changes = value.changes.filter(isSynchronizationChange);
  if (changes.length !== value.changes.length) return null;
  // A proposal written before skipped groups existed is still a usable review list, so a missing
  // field reads as an empty list rather than as corruption.
  const rawSkipped = value.skippedGroups ?? [];
  if (!Array.isArray(rawSkipped)) return null;
  const skippedGroups = rawSkipped.filter(isSkippedGroup);
  if (skippedGroups.length !== rawSkipped.length) return null;
  const planFailureReason = value.planFailureReason ?? null;
  if (planFailureReason !== null && typeof planFailureReason !== 'string') return null;
  // Same tolerance: a proposal stored before the failures were named carries only a count, which
  // this version has no way to turn back into tabs.
  const rawFailed = value.failedTabs ?? [];
  if (!Array.isArray(rawFailed)) return null;
  const failedTabs = rawFailed.filter(isFailedTab);
  if (failedTabs.length !== rawFailed.length) return null;
  return {
    id: value.id,
    scope: value.scope,
    changes,
    unchangedCount: value.unchangedCount,
    failedTabs,
    skippedGroups,
    planFailureReason,
  };
}

function isReviewScope(value: unknown): value is ReviewScope {
  return value === 'all' || value === 'current' || value === 'active' || value === 'ungrouped';
}

function isFailedTab(value: unknown): value is FailedTab {
  return isRecord(value) && typeof value.tabId === 'number' && typeof value.title === 'string' &&
    typeof value.hostname === 'string';
}

function isSkippedGroup(value: unknown): value is SynchronizationSkippedGroup {
  return isRecord(value) && typeof value.title === 'string' && typeof value.tabCount === 'number' &&
    (value.reason === 'not_in_plan' || value.reason === 'too_few_tabs') &&
    (value.minimumTabs === null || typeof value.minimumTabs === 'number');
}

function isSynchronizationChange(value: unknown): value is SynchronizationChange {
  if (!isRecord(value) || !isRecord(value.target)) return false;
  return typeof value.tabId === 'number' && typeof value.windowId === 'number' &&
    typeof value.title === 'string' && typeof value.hostname === 'string' &&
    typeof value.currentGroupId === 'number' && typeof value.confidence === 'number' &&
    typeof value.reason === 'string' && typeof value.selected === 'boolean' &&
    (value.blockedReason === null || value.blockedReason === 'split_view' ||
      value.blockedReason === 'split_view_conflict') &&
    (value.splitViewId === null || typeof value.splitViewId === 'number') &&
    (value.currentGroup === null || isGroupDescriptor(value.currentGroup)) &&
    (value.target.kind === 'existing_group' || value.target.kind === 'preset' ||
      value.target.kind === 'new_group') &&
    (value.target.ref === null || typeof value.target.ref === 'string') &&
    (value.target.groupId === null || typeof value.target.groupId === 'number') &&
    typeof value.target.title === 'string' && isGroupColor(value.target.color) &&
    (value.target.description === null || typeof value.target.description === 'string');
}

function isGroupDescriptor(value: unknown): value is GroupDescriptor {
  return isRecord(value) && typeof value.title === 'string' && isGroupColor(value.color);
}

function isGroupColor(value: unknown): value is GroupColor {
  return value === 'grey' || value === 'blue' || value === 'red' || value === 'yellow' ||
    value === 'green' || value === 'pink' || value === 'purple' || value === 'cyan' ||
    value === 'orange';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
