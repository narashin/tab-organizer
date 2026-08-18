import type { LocalStorageArea } from './settings-service';

/** The host a tab was showing when this extension put it in a group. */
export interface TabPlacement {
  tabId: number;
  hostname: string;
}

const PLACEMENTS_KEY = 'tabPlacements';

/**
 * Remembers which grouped tabs have already been examined, and where they pointed at the time.
 *
 * The everyday review only looks at tabs with no group, on the grounds that a grouped tab is
 * settled. A tab that was grouped as a ATLAS page and now shows a SANDY page is not settled, and
 * without this it would keep its old group until someone noticed by hand. Session-scoped: a record
 * is only useful while the tab it describes still exists, and a new browser session earns a fresh
 * look at every group.
 */
export class TabPlacementStore {
  private storageMutation: Promise<void> = Promise.resolve();

  constructor(private readonly storage: LocalStorageArea) {}

  async list(): Promise<TabPlacement[]> {
    const values = await this.storage.get([PLACEMENTS_KEY]);
    return Array.isArray(values[PLACEMENTS_KEY])
      ? values[PLACEMENTS_KEY].map(parsePlacement).filter(isDefined)
      : [];
  }

  async record(placements: readonly TabPlacement[]): Promise<void> {
    if (placements.length === 0) return;
    await this.enqueue(async () => {
      const replaced = new Set(placements.map((placement) => placement.tabId));
      const kept = (await this.list()).filter((placement) => !replaced.has(placement.tabId));
      await this.storage.set({ [PLACEMENTS_KEY]: [...kept, ...placements] });
    });
  }

  /**
   * The grouped tabs worth asking about again.
   *
   * Two cases, and they have to be treated alike. A tab whose recorded host no longer matches has
   * plainly moved on. A tab with no record at all is not settled either, it is merely unexamined:
   * the group may predate this extension entirely. Recording the current host on sight looked
   * cheaper and was wrong, because a tab that had already drifted got its new host written down as
   * if that were where it started, and it was never asked about again.
   *
   * So the first review of a session looks at every grouped tab once, and later ones only at the
   * tabs that have moved since.
   */
  async unsettledTabIds(
    tabs: readonly { tabId: number; groupId: number; hostname: string }[],
  ): Promise<number[]> {
    const placements = new Map((await this.list()).map((placement) => [
      placement.tabId,
      placement.hostname,
    ]));
    return tabs
      .filter((tab) => tab.groupId >= 0 && tab.hostname !== '' &&
        placements.get(tab.tabId) !== tab.hostname)
      .map((tab) => tab.tabId);
  }

  async removeClosedTab(tabId: number): Promise<void> {
    await this.enqueue(async () => {
      const placements = await this.list();
      if (!placements.some((placement) => placement.tabId === tabId)) return;
      await this.storage.set({
        [PLACEMENTS_KEY]: placements.filter((placement) => placement.tabId !== tabId),
      });
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.storageMutation.then(operation);
    this.storageMutation = mutation.then(() => undefined, () => undefined);
    return mutation;
  }
}

function parsePlacement(value: unknown): TabPlacement | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.tabId === 'number' && typeof candidate.hostname === 'string'
    ? { tabId: candidate.tabId, hostname: candidate.hostname }
    : null;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
