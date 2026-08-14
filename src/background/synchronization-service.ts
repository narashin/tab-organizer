import type {
  ClassificationDecision,
  ClassificationGroup,
  Classifier,
  TaxonomyPlanner,
} from './classifier';
import type { GroupDescriptor, HistoryStore, PriorTabState } from './history-store';
import type { GroupColor, PresetStore } from './preset-store';
import { translations, type SupportedLocale } from '../shared/localization';
import { toClassificationHostname } from '../shared/tab-context';
import {
  DEFAULT_GROUPING_GRANULARITY,
  effectiveMinTabsPerNewGroup,
  maxGroupCount,
  type GroupingGranularity,
} from '../shared/grouping';
import type { TabLockStore } from './tab-lock-store';
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

export interface SynchronizationPlatform {
  listTabs(scope: 'all' | 'current'): Promise<BrowserTab[]>;
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

export interface SynchronizationProposal {
  id: string;
  scope: 'all' | 'current';
  changes: SynchronizationChange[];
  unchangedCount: number;
  // Tabs whose chunk failed every attempt. They stay put, but silence would misreport coverage.
  failedTabCount: number;
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
  private readonly applyTasks = new Map<string, Promise<{ applied: number; skipped: number }>>();
  private proposalStorageMutation: Promise<void> = Promise.resolve();
  private operationMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly classifier: Classifier,
    private readonly presets: PresetStore,
    private readonly locks: TabLockStore,
    private readonly history: HistoryStore,
    private readonly platform: SynchronizationPlatform,
    private readonly getLocale: () => SupportedLocale,
    private readonly createProposalId: () => string,
    private readonly proposalStorage?: LocalStorageArea,
    private readonly taxonomyPlanner?: TaxonomyPlanner,
    private readonly getGranularity: () => GroupingGranularity = () => DEFAULT_GROUPING_GRANULARITY,
    private readonly getSendPathEnabled: () => boolean = () => false,
  ) {}

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
    for (let attempt = 0; attempt < SYNCHRONIZATION_CHUNK_ATTEMPTS; attempt += 1) {
      try {
        const entries = await this.taxonomyPlanner.plan(request);
        const titles = entries.map((entry) => entry.title);
        if (titles.length > 0) return titles;
        return undefined;
      } catch {
        // The taxonomy pass is an optimization; chunking alone still produces a usable proposal.
      }
    }
    return undefined;
  }

  async review(scope: 'all' | 'current'): Promise<SynchronizationProposal> {
    return this.enqueueOperation(() => this.reviewOnce(scope));
  }

  private async reviewOnce(scope: 'all' | 'current'): Promise<SynchronizationProposal> {
    const allTabs = await this.platform.listTabs(scope);
    const unlockedTabs = await this.locks.excludeLocked(allTabs);
    const eligible = unlockedTabs.filter((tab) => !tab.incognito && getHostname(tab.url) !== '');
    const presets = await this.presets.list();

    const windowIds = [...new Set(eligible.map((tab) => tab.windowId))];
    const failures: unknown[] = [];
    let attemptedChunks = 0;
    let succeededChunks = 0;
    const windowResults = await mapWithConcurrency(
      windowIds,
      SYNCHRONIZATION_MAX_CONCURRENT_WINDOWS,
      async (windowId): Promise<{
        changes: SynchronizationChange[];
        unchangedCount: number;
        failedTabCount: number;
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
      const approvedGroupTitles = await this.planApprovedTitles(tabs, classificationGroups, presets);
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
      const failedTabCount = chunks.reduce(
        (total, chunk, index) => total + (chunkedDecisions[index] === null ? chunk.length : 0),
        0,
      );

      const changes: SynchronizationChange[] = [];
      const canonicalTitles = new Map<string, string>();
      const assignedColors = new Map<string, GroupColor>();
      const approvedTitles = approvedGroupTitles === undefined
        ? undefined
        : new Set(approvedGroupTitles.map((title) => title.trim().toLowerCase()));
      let unchangedCount = 0;
      for (const decision of decisions) {
        const tabId = parseTabRef(decision.tabRef);
        const tab = windowTabs.find((candidate) => candidate.tabId === tabId);
        if (tab === undefined || decision.kind === 'no_change') {
          unchangedCount += 1;
          continue;
        }
        const target = resolveTarget(
          decision, groups, presets, canonicalTitles, assignedColors, approvedTitles,
        );
        if (target === null) throw new Error('synchronization_invalid_target');
        if (target === 'unchanged') {
          unchangedCount += 1;
          continue;
        }
        const current = groups.find((group) => group.groupId === tab.groupId);
        if (
          (target.kind === 'existing_group' && target.groupId === tab.groupId) ||
          (target.kind === 'preset' && current !== undefined &&
            current.title === target.title && current.color === target.color)
        ) {
          unchangedCount += 1;
          continue;
        }
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
      const kept = withoutUndersizedNewGroups(
        changes,
        effectiveMinTabsPerNewGroup(this.getGranularity(), tabs.length),
      );
      return {
        changes: kept,
        unchangedCount: unchangedCount + (changes.length - kept.length),
        failedTabCount,
      };
      },
    );
    // Losing a chunk is recoverable, but losing every chunk means classification itself is broken.
    if (attemptedChunks > 0 && succeededChunks === 0) {
      throw failures[0] ?? new Error('classification_request_failed');
    }
    const changes = windowResults.flatMap((result) => result.changes);
    const unchangedCount = windowResults.reduce((total, result) => total + result.unchangedCount, 0);
    const failedTabCount = windowResults.reduce((total, result) => total + result.failedTabCount, 0);

    markSplitViewConflicts(changes);
    const proposal = { id: this.createProposalId(), scope, changes, unchangedCount, failedTabCount };
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

  async apply(proposalId: string, selectedTabIds: number[]): Promise<{ applied: number; skipped: number }> {
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

  private async applyOnce(
    proposalId: string,
    selectedTabIds: number[],
  ): Promise<{ applied: number; skipped: number }> {
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

    if (valid.length === 0) {
      await this.removeProposal(proposalId);
      return { applied: 0, skipped };
    }
    const prior: PriorTabState[] = valid.map((change) => ({
      tabId: change.tabId,
      windowId: change.windowId,
      group: change.currentGroup === null ? null : {
        ...change.currentGroup,
        ...(change.currentGroupId < 0 ? {} : { groupId: change.currentGroupId }),
      },
      expectedGroup: {
        ...(change.target.groupId === null ? {} : { groupId: change.target.groupId }),
        title: change.target.title,
        color: change.target.color,
      },
    }));
    const operation = await this.history.record('sync', prior);

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
      let newGroupId: number | null = null;
      try {
        if (first.target.groupId !== null) {
          await this.platform.moveToExistingGroup(
            currentBucket.map((change) => change.tabId),
            first.target.groupId,
          );
        } else {
          newGroupId = await this.platform.moveToNewGroup(
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
      if (newGroupId !== null) {
        await this.setExpectedGroupIdBestEffort(
          operation.id,
          currentBucket.map((change) => change.tabId),
          newGroupId,
        );
      }
    }
    await this.history.markStatus(operation.id, applied === valid.length ? 'completed' : 'partial');
    await this.removeProposal(proposalId);
    return { applied, skipped };
  }

  private async setExpectedGroupIdBestEffort(
    operationId: string,
    tabIds: number[],
    groupId: number,
  ): Promise<void> {
    try {
      await this.history.setExpectedGroupId(operationId, tabIds, groupId);
    } catch {
      // The stored group descriptor remains available for undo fallback.
    }
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
): SynchronizationChange[] {
  const counts = new Map<string, number>();
  for (const change of changes) {
    if (change.target.kind !== 'new_group') continue;
    const key = change.target.title.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return changes.filter((change) => {
    if (change.target.kind !== 'new_group') return true;
    const key = change.target.title.trim().toLowerCase();
    return (counts.get(key) ?? 0) >= minimumTabs;
  });
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

function resolveTarget(
  decision: Awaited<ReturnType<Classifier['classify']>>[number],
  groups: BrowserGroup[],
  presets: Awaited<ReturnType<PresetStore['list']>>,
  canonicalTitles: Map<string, string>,
  assignedColors: Map<string, GroupColor>,
  approvedTitles: Set<string> | undefined,
): SynchronizationTarget | 'unchanged' | null {
  if (decision.kind === 'existing_group') {
    const group = groups.find((candidate) => candidate.ref === decision.targetRef);
    return group === undefined ? null : {
      kind: 'existing_group', ref: group.ref, groupId: group.groupId, title: group.title,
      color: group.color, description: null,
    };
  }
  if (decision.kind === 'preset') {
    const preset = presets.find((candidate) => candidate.id === decision.targetRef);
    if (preset === undefined) return null;
    // A preset names a group that may already exist from an earlier run. Reuse it instead of asking
    // for a new group, which Chrome would happily create beside the one with the same name.
    const existing = findGroupByTitle(groups, preset.name);
    if (existing !== undefined) {
      return {
        kind: 'existing_group', ref: existing.ref, groupId: existing.groupId, title: existing.title,
        color: existing.color, description: null,
      };
    }
    return {
      kind: 'preset', ref: preset.id, groupId: null, title: preset.name, color: preset.color,
      description: preset.description,
    };
  }
  if (decision.kind === 'new_group' && decision.suggestedName !== null) {
    const title = decision.suggestedName.trim();
    if (title.length === 0) return 'unchanged';
    const normalized = title.toLowerCase();

    // A title that already names a group or preset must reuse it; the apply path has no dedup.
    const group = findGroupByTitle(groups, title);
    if (group !== undefined) {
      return {
        kind: 'existing_group', ref: group.ref, groupId: group.groupId, title: group.title,
        color: group.color, description: null,
      };
    }
    const preset = presets.find((candidate) => candidate.name.trim().toLowerCase() === normalized);
    if (preset !== undefined) {
      return {
        kind: 'preset', ref: preset.id, groupId: null, title: preset.name, color: preset.color,
        description: preset.description,
      };
    }
    if (approvedTitles !== undefined && !approvedTitles.has(normalized)) return 'unchanged';

    // Chunks propose the same group independently, so one casing wins for the whole window.
    const canonical = canonicalTitles.get(normalized);
    if (canonical === undefined) canonicalTitles.set(normalized, title);
    return {
      kind: 'new_group', ref: null, groupId: null, title: canonical ?? title,
      color: assignGroupColor(canonical ?? title, groups, assignedColors),
      description: decision.suggestedDescription,
    };
  }
  return null;
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
  if (!isRecord(value) || !isSynchronizationProposal(value.proposal) || !isRecord(value.reviewedUrls)) {
    return null;
  }
  const reviewedUrls: Record<string, string> = {};
  for (const [tabId, url] of Object.entries(value.reviewedUrls)) {
    if (!/^\d+$/.test(tabId) || typeof url !== 'string') return null;
    reviewedUrls[tabId] = url;
  }
  return { proposal: value.proposal, reviewedUrls };
}

function isSynchronizationProposal(value: unknown): value is SynchronizationProposal {
  return isRecord(value) && typeof value.id === 'string' &&
    (value.scope === 'all' || value.scope === 'current') &&
    Array.isArray(value.changes) && value.changes.every(isSynchronizationChange) &&
    typeof value.unchangedCount === 'number' && typeof value.failedTabCount === 'number';
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
