import type { GroupColor } from './preset-store';
import type { LocalStorageArea } from './settings-service';

export interface GroupDescriptor {
  title: string;
  color: GroupColor;
}

export interface HistoryGroupState extends GroupDescriptor {
  groupId?: number;
}

export interface PriorTabState {
  tabId: number;
  windowId: number;
  group: HistoryGroupState | null;
  expectedGroup?: HistoryGroupState | null;
}

export interface HistoryOperation {
  id: string;
  kind: 'automatic' | 'sync';
  createdAt: number;
  tabs: PriorTabState[];
  status?: 'pending' | 'completed' | 'partial';
  undoneAt: number | null;
}

export interface HistoryTab {
  tabId: number;
  windowId: number;
  groupId: number;
  splitViewId?: number;
}

export interface HistoryGroup extends GroupDescriptor {
  groupId: number;
  windowId: number;
}

export interface HistoryPlatform {
  listTabs(windowIds: readonly number[]): Promise<HistoryTab[]>;
  listGroups(windowId: number): Promise<HistoryGroup[]>;
  moveToExistingGroup(tabIds: number[], groupId: number): Promise<void>;
  moveToNewGroup(tabIds: number[], windowId: number, title: string, color: GroupColor): Promise<void>;
  ungroup(tabIds: number[]): Promise<void>;
}

const HISTORY_KEY = 'organizationHistory';
const HISTORY_LIMIT = 10;

/**
 * The one operation an undo may target, or null when nothing is left to undo.
 *
 * History is newest first, so this is the most recent operation still in effect. Undo is offered as
 * a stack because that is what the word promises: reverting a run from five steps back, while four
 * later runs stand, is a state no sequence of user actions would have produced. Restoring one older
 * run in isolation is a different feature, and calling it undo is what made it confusing.
 */
export function undoableOperationId(history: readonly HistoryOperation[]): string | null {
  return history.find((operation) => operation.undoneAt === null)?.id ?? null;
}

export class HistoryStore {
  private storageMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: LocalStorageArea,
    private readonly createId: () => string,
    private readonly now: () => number,
  ) {}

  async list(): Promise<HistoryOperation[]> {
    const values = await this.storage.get([HISTORY_KEY]);
    return Array.isArray(values[HISTORY_KEY])
      ? values[HISTORY_KEY].filter(isHistoryOperation)
      : [];
  }

  async record(kind: HistoryOperation['kind'], tabs: PriorTabState[]): Promise<HistoryOperation> {
    const operation: HistoryOperation = {
      id: this.createId(),
      kind,
      createdAt: this.now(),
      tabs: tabs.map((tab) => ({
        ...tab,
        group: tab.group === null ? null : { ...tab.group },
        ...(tab.expectedGroup === undefined
          ? {}
          : { expectedGroup: tab.expectedGroup === null ? null : { ...tab.expectedGroup } }),
      })),
      status: 'pending',
      undoneAt: null,
    };
    return this.mutate(async (history) => {
      await this.storage.set({ [HISTORY_KEY]: [operation, ...history].slice(0, HISTORY_LIMIT) });
      return operation;
    });
  }

  async markUndone(id: string): Promise<void> {
    await this.mutate(async (history) => {
      const operation = history.find((item) => item.id === id);
      if (operation === undefined) throw new Error('history_not_found');
      if (operation.undoneAt !== null) throw new Error('history_already_undone');
      operation.undoneAt = this.now();
      await this.storage.set({ [HISTORY_KEY]: history });
    });
  }

  async markStatus(id: string, status: 'completed' | 'partial'): Promise<void> {
    await this.mutate(async (history) => {
      const operation = history.find((item) => item.id === id);
      if (operation === undefined) throw new Error('history_not_found');
      operation.status = status;
      await this.storage.set({ [HISTORY_KEY]: history });
    });
  }

  async setExpectedGroupId(id: string, tabIds: readonly number[], groupId: number): Promise<void> {
    const selected = new Set(tabIds);
    await this.mutate(async (history) => {
      const operation = history.find((item) => item.id === id);
      if (operation === undefined) throw new Error('history_not_found');
      for (const tab of operation.tabs) {
        if (selected.has(tab.tabId) && tab.expectedGroup !== undefined && tab.expectedGroup !== null) {
          tab.expectedGroup.groupId = groupId;
        }
      }
      await this.storage.set({ [HISTORY_KEY]: history });
    });
  }

  private async mutate<T>(change: (history: HistoryOperation[]) => Promise<T>): Promise<T> {
    const mutation = this.storageMutation.then(async () => change(await this.list()));
    this.storageMutation = mutation.then(() => undefined, () => undefined);
    return mutation;
  }
}

export class HistoryRestorer {
  private readonly undoTasks = new Map<string, Promise<{ restored: number; skipped: number }>>();

  constructor(
    private readonly store: HistoryStore,
    private readonly platform: HistoryPlatform,
  ) {}

  async undo(id: string): Promise<{ restored: number; skipped: number }> {
    const active = this.undoTasks.get(id);
    if (active !== undefined) return active;
    const task = this.undoOnce(id);
    this.undoTasks.set(id, task);
    try {
      return await task;
    } finally {
      if (this.undoTasks.get(id) === task) this.undoTasks.delete(id);
    }
  }

  private async undoOnce(id: string): Promise<{ restored: number; skipped: number }> {
    const history = await this.store.list();
    const operation = history.find((item) => item.id === id);
    if (operation === undefined) throw new Error('history_not_found');
    if (operation.undoneAt !== null) throw new Error('history_already_undone');
    // Enforced here rather than by disabling a button: a popup left open across a later run would
    // still be showing the stale one as the newest.
    if (undoableOperationId(history) !== id) throw new Error('history_not_latest');

    const windowIds = [...new Set(operation.tabs.map((tab) => tab.windowId))];
    const currentTabs = new Map(
      (await this.platform.listTabs(windowIds)).map((tab) => [tab.tabId, tab]),
    );
    const groupsByWindow = new Map<number, HistoryGroup[]>();
    await Promise.all(windowIds.map(async (windowId) => {
      groupsByWindow.set(windowId, await this.platform.listGroups(windowId));
    }));
    const restorable: PriorTabState[] = [];
    let skipped = 0;
    for (const prior of operation.tabs) {
      const tab = currentTabs.get(prior.tabId) ?? null;
      if (
        tab === null ||
        tab.windowId !== prior.windowId ||
        (tab.splitViewId !== undefined && tab.splitViewId >= 0) ||
        !matchesExpectedGroup(prior.expectedGroup, tab.groupId, groupsByWindow.get(prior.windowId) ?? [])
      ) {
        skipped += 1;
        continue;
      }
      restorable.push(prior);
    }

    const ungrouped = restorable.filter((prior) => prior.group === null).map((prior) => prior.tabId);
    if (ungrouped.length > 0) await this.platform.ungroup(ungrouped);

    const grouped = new Map<string, PriorTabState[]>();
    for (const prior of restorable) {
      if (prior.group === null) continue;
      const groupIdentity = prior.group.groupId === undefined
        ? `${prior.group.title}:${prior.group.color}`
        : `id:${prior.group.groupId}`;
      const key = `${prior.windowId}:${groupIdentity}`;
      grouped.set(key, [...(grouped.get(key) ?? []), prior]);
    }
    for (const bucket of grouped.values()) {
      const first = bucket[0];
      if (first?.group === null || first === undefined) continue;
      const groups = groupsByWindow.get(first.windowId) ?? [];
      const existing = groups.find((group) => first.group?.groupId !== undefined &&
        group.groupId === first.group.groupId) ?? groups.find(
        (group) => group.title === first.group?.title && group.color === first.group.color,
      );
      const tabIds = bucket.map((prior) => prior.tabId);
      if (existing === undefined) {
        await this.platform.moveToNewGroup(
          tabIds,
          first.windowId,
          first.group.title,
          first.group.color,
        );
      } else {
        await this.platform.moveToExistingGroup(tabIds, existing.groupId);
      }
    }
    // An undo that moved nothing has not happened, so the entry stays actionable. Marking it undone
    // would retire it for good; that is what a Chrome restart used to do, since restored tabs carry
    // new tab and window IDs and every recorded tab looks gone.
    if (restorable.length > 0) await this.store.markUndone(id);
    return { restored: restorable.length, skipped };
  }
}

function matchesExpectedGroup(
  expected: HistoryGroupState | null | undefined,
  currentGroupId: number,
  groups: HistoryGroup[],
): boolean {
  if (expected === undefined) return false;
  if (expected === null) return currentGroupId < 0;
  if (expected.groupId !== undefined) return currentGroupId === expected.groupId;
  const current = groups.find((group) => group.groupId === currentGroupId);
  return current !== undefined && current.title === expected.title && current.color === expected.color;
}

function isHistoryOperation(value: unknown): value is HistoryOperation {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return false;
  return (
    typeof value.id === 'string' &&
    (value.kind === 'automatic' || value.kind === 'sync') &&
    typeof value.createdAt === 'number' &&
    (value.status === undefined || value.status === 'pending' ||
      value.status === 'completed' || value.status === 'partial') &&
    (value.undoneAt === null || typeof value.undoneAt === 'number') &&
    value.tabs.every(isPriorTabState)
  );
}

function isPriorTabState(value: unknown): value is PriorTabState {
  return (
    isRecord(value) &&
    typeof value.tabId === 'number' &&
    typeof value.windowId === 'number' &&
    (value.group === null || isHistoryGroupState(value.group)) &&
    (value.expectedGroup === undefined || value.expectedGroup === null ||
      isHistoryGroupState(value.expectedGroup))
  );
}

function isHistoryGroupState(value: unknown): value is HistoryGroupState {
  return isGroupDescriptor(value) &&
    (!('groupId' in value) || typeof value.groupId === 'number');
}

function isGroupDescriptor(value: unknown): value is GroupDescriptor {
  return isRecord(value) && typeof value.title === 'string' && isGroupColor(value.color);
}

function isGroupColor(value: unknown): value is GroupColor {
  return (
    value === 'grey' || value === 'blue' || value === 'red' || value === 'yellow' ||
    value === 'green' || value === 'pink' || value === 'purple' || value === 'cyan' ||
    value === 'orange'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
