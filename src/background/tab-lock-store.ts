import type { LocalStorageArea } from './settings-service';

export interface TabLock {
  tabId: number;
  lockedAt: number;
  changed: boolean;
}

export class TabLockStore {
  private storageMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: LocalStorageArea,
    private readonly now: () => number,
  ) {}

  async list(): Promise<TabLock[]> {
    return this.enqueue(async () => {
      const { locks, hasLegacyData } = await this.readLocks();
      if (hasLegacyData) await this.storage.set({ tabLocks: locks });
      return locks;
    });
  }

  async lock(tabId: number): Promise<TabLock> {
    return this.mutate((locks) => {
      const lock: TabLock = { tabId, lockedAt: this.now(), changed: false };
      return {
        locks: [...locks.filter((item) => item.tabId !== tabId), lock],
        result: lock,
      };
    });
  }

  async recordNavigation(tabId: number): Promise<void> {
    await this.enqueue(async () => {
      const { locks } = await this.readLocks();
      const target = locks.find((lock) => lock.tabId === tabId);
      if (target === undefined || target.changed) return;
      await this.storage.set({
        tabLocks: locks.map((lock) => lock.tabId === tabId ? { ...lock, changed: true } : lock),
      });
    });
  }

  async excludeLocked<T extends { tabId: number }>(tabs: readonly T[]): Promise<T[]> {
    const lockedIds = new Set((await this.list()).map((lock) => lock.tabId));
    return tabs.filter((tab) => !lockedIds.has(tab.tabId));
  }

  async unlock(tabId: number): Promise<boolean> {
    return this.mutate((locks) => {
      const next = locks.filter((lock) => lock.tabId !== tabId);
      return { locks: next, result: next.length !== locks.length };
    });
  }

  async removeClosedTab(tabId: number): Promise<void> {
    await this.unlock(tabId);
  }

  private async mutate<T>(
    change: (locks: TabLock[]) => { locks: TabLock[]; result: T },
  ): Promise<T> {
    return this.enqueue(async () => {
      const { locks: current } = await this.readLocks();
      const next = change(current);
      await this.storage.set({ tabLocks: next.locks });
      return next.result;
    });
  }

  private async readLocks(): Promise<{ locks: TabLock[]; hasLegacyData: boolean }> {
    const values = await this.storage.get(['tabLocks']);
    if (!Array.isArray(values.tabLocks)) return { locks: [], hasLegacyData: false };
    return {
      locks: values.tabLocks.map(parseTabLock).filter(isDefined),
      hasLegacyData: values.tabLocks.some((value) => isRecord(value) && 'urlFingerprint' in value),
    };
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.storageMutation.then(operation);
    this.storageMutation = mutation.then(() => undefined, () => undefined);
    return mutation;
  }
}

function parseTabLock(value: unknown): TabLock | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.tabId === 'number' &&
    typeof candidate.lockedAt === 'number' &&
    typeof candidate.changed === 'boolean'
  ) ? {
      tabId: candidate.tabId,
      lockedAt: candidate.lockedAt,
      changed: candidate.changed,
    } : null;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
