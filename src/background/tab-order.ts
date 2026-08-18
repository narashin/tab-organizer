/**
 * Alphabetical ordering of a window's tab strip.
 *
 * Kept apart from grouping on purpose: this decides where tabs sit, never which group they belong
 * to. The layout it produces is [pinned] [groups by title] [ungrouped by title], and the order it
 * replaces is not recorded anywhere, so a sort cannot be undone.
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
  moveTab(tabId: number, index: number): Promise<void>;
  moveGroup(groupId: number, index: number): Promise<void>;
}

export type TabOrderStep =
  | { kind: 'group'; groupId: number; index: number }
  | { kind: 'tab'; tabId: number; index: number };

/** Where Chrome puts something moved with no position in mind. */
const END_OF_WINDOW = -1;

function byTitle(left: { title: string }, right: { title: string }): number {
  // A fixed collation, so the same window sorts the same way whatever locale the browser runs in.
  return left.title.localeCompare(right.title, 'en', { sensitivity: 'base', numeric: true });
}

/**
 * Plans the moves that put one window in alphabetical order.
 *
 * Returns an empty plan for a window holding Split View tabs. Sorting moves everything around them,
 * which is still a move, and this extension does not move a tab in Split View.
 */
export function planTabOrder(tabs: OrderedTab[], groups: OrderedGroup[]): TabOrderStep[] {
  if (tabs.some((tab) => tab.splitViewId !== undefined && tab.splitViewId >= 0)) return [];

  const movable = [...tabs].filter((tab) => !tab.pinned).sort((left, right) => left.index - right.index);
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
  const sortedGroups = [...presentGroups].sort(byTitle);
  for (const group of sortedGroups) {
    steps.push({ kind: 'group', groupId: group.groupId, index: END_OF_WINDOW });
  }
  // Then the loose tabs, which lands them after every group.
  for (const tab of [...ungrouped].sort(byTitle)) {
    steps.push({ kind: 'tab', tabId: tab.tabId, index: END_OF_WINDOW });
  }

  // With the blocks placed, every group's range is known, so its members move to absolute indices.
  // A tab moved inside its own group's range keeps its membership; one moved past it would not.
  let start = tabs.filter((tab) => tab.pinned).length;
  for (const group of sortedGroups) {
    const members = [...(grouped.get(group.groupId) ?? [])].sort(byTitle);
    members.forEach((tab, offset) => {
      steps.push({ kind: 'tab', tabId: tab.tabId, index: start + offset });
    });
    start += members.length;
  }
  return steps;
}
