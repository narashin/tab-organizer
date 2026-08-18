/**
 * Alphabetical ordering of a window's tab strip.
 *
 * Kept apart from grouping on purpose: this decides where tabs sit, never which group they belong
 * to. The layout it produces is [pinned] [groups named by a preset, in preset order] [remaining
 * groups by title] [ungrouped by title]. The order it replaces is not recorded anywhere, so nothing
 * can put it back.
 */

export interface OrderedTab {
  tabId: number;
  index: number;
  pinned: boolean;
  /** Chrome reports -1 for a tab that belongs to no group. */
  groupId: number;
  title: string;
  splitViewId?: number;
}

export interface OrderedGroup {
  groupId: number;
  title: string;
}

export interface TabOrderPlatform {
  listWindowTabs(windowId: number): Promise<OrderedTab[]>;
  /** Moves tabs as one block, which is what keeps a Split View pair together. */
  moveTabs(tabIds: number[], index: number): Promise<void>;
  moveGroup(groupId: number, index: number): Promise<void>;
}

export type TabOrderStep =
  | { kind: 'group'; groupId: number; index: number }
  | { kind: 'tabs'; tabIds: number[]; index: number };

/** Where Chrome puts something moved with no position in mind. */
const END_OF_WINDOW = -1;

function byTitle(left: { title: string }, right: { title: string }): number {
  // A fixed collation, so the same window sorts the same way whatever locale the browser runs in.
  return left.title.localeCompare(right.title, 'en', { sensitivity: 'base', numeric: true });
}

/**
 * Ranks the groups a preset named, in the order the presets are stored.
 *
 * A preset is a name the user chose deliberately, so its position is a decision rather than an
 * accident of the alphabet. Groups no preset covers keep alphabetical order behind them.
 */
function toPresetRanks(presetNames: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  presetNames.forEach((name, index) => {
    const key = name.trim().toLowerCase();
    if (key.length > 0 && !ranks.has(key)) ranks.set(key, index);
  });
  return ranks;
}

function splitIdOf(tab: OrderedTab): number | null {
  return tab.splitViewId === undefined || tab.splitViewId < 0 ? null : tab.splitViewId;
}

/**
 * Collects tabs into the blocks that have to move together.
 *
 * A Split View pair is two tabs Chrome draws side by side. Putting anything between them, or moving
 * one without the other, is what would break the split, so the pair travels as a single block.
 * Skipping such a window entirely was the earlier answer, and it meant one split pair left a
 * hundred tabs unsorted.
 */
function toBlocks(tabs: OrderedTab[]): { tabIds: number[]; title: string }[] {
  const blocks: { tabIds: number[]; title: string }[] = [];
  const splits = new Map<number, { tabIds: number[]; title: string }>();
  for (const tab of tabs) {
    const splitId = splitIdOf(tab);
    if (splitId === null) {
      blocks.push({ tabIds: [tab.tabId], title: tab.title });
      continue;
    }
    const existing = splits.get(splitId);
    if (existing === undefined) {
      const block = { tabIds: [tab.tabId], title: tab.title };
      splits.set(splitId, block);
      blocks.push(block);
      continue;
    }
    existing.tabIds.push(tab.tabId);
    if (byTitle(tab, existing) < 0) existing.title = tab.title;
  }
  return blocks;
}

/**
 * Orders the blocks of a section: Split View pairs first, then everything else by title.
 *
 * A pair is a layout the user built by hand, so it gets a fixed place at the head of its section
 * rather than a position that moves whenever one of its titles changes.
 */
function sortBlocks(blocks: { tabIds: number[]; title: string }[]): { tabIds: number[]; title: string }[] {
  return [...blocks].sort((left, right) => {
    const difference = Number(right.tabIds.length > 1) - Number(left.tabIds.length > 1);
    return difference === 0 ? byTitle(left, right) : difference;
  });
}

/** Plans the moves that put one window in alphabetical order. */
export function planTabOrder(
  tabs: OrderedTab[],
  groups: OrderedGroup[],
  presetNames: readonly string[] = [],
): TabOrderStep[] {
  const movable = [...tabs]
    .filter((tab) => !tab.pinned)
    .sort((left, right) => left.index - right.index);
  const grouped = new Map<number, OrderedTab[]>();
  for (const tab of movable) {
    if (tab.groupId < 0) continue;
    grouped.set(tab.groupId, [...(grouped.get(tab.groupId) ?? []), tab]);
  }
  const presentGroups = groups.filter((group) => (grouped.get(group.groupId) ?? []).length > 0);
  const ungrouped = movable.filter((tab) => tab.groupId < 0);
  if (presentGroups.length === 0 && ungrouped.length === 0) return [];

  const steps: TabOrderStep[] = [];
  // Groups first, each sent to the end in turn, which leaves them in order at the end.
  const ranks = toPresetRanks(presetNames);
  const rankOf = (group: OrderedGroup): number =>
    ranks.get(group.title.trim().toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
  const sortedGroups = [...presentGroups].sort((left, right) => {
    const difference = rankOf(left) - rankOf(right);
    return difference === 0 ? byTitle(left, right) : difference;
  });
  for (const group of sortedGroups) {
    steps.push({ kind: 'group', groupId: group.groupId, index: END_OF_WINDOW });
  }
  // Then the loose tabs, which lands them after every group.
  for (const block of sortBlocks(toBlocks(ungrouped))) {
    steps.push({ kind: 'tabs', tabIds: block.tabIds, index: END_OF_WINDOW });
  }

  // With the blocks placed, every group's range is known, so its members move to absolute indices.
  // A tab moved inside its own group's range keeps its membership; one moved past it would not.
  let start = tabs.filter((tab) => tab.pinned).length;
  for (const group of sortedGroups) {
    const members = grouped.get(group.groupId) ?? [];
    let offset = 0;
    for (const block of sortBlocks(toBlocks(members))) {
      steps.push({ kind: 'tabs', tabIds: block.tabIds, index: start + offset });
      offset += block.tabIds.length;
    }
    start += members.length;
  }
  return steps;
}
