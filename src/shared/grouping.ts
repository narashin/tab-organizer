export type GroupingGranularity = 'broad' | 'balanced' | 'fine';

export const DEFAULT_GROUPING_GRANULARITY: GroupingGranularity = 'balanced';

/** Chrome group strips get unreadable past this many groups regardless of the tab count. */
export const MAX_GROUP_COUNT = 10;

const MIN_TABS: Record<GroupingGranularity, number> = {
  broad: 6,
  balanced: 4,
  fine: 3,
};

export function isGroupingGranularity(value: unknown): value is GroupingGranularity {
  return value === 'broad' || value === 'balanced' || value === 'fine';
}

/** Smallest number of tabs worth creating a brand new group for. */
export function minTabsPerNewGroup(granularity: GroupingGranularity): number {
  return MIN_TABS[granularity];
}

/**
 * The floor a window can actually satisfy.
 *
 * Demanding four tabs per group in a three-tab window would organize nothing, so the requirement
 * scales down with the window. Fragmentation only becomes a problem once there are enough tabs to
 * fragment, and by then the configured floor applies in full.
 */
export function effectiveMinTabsPerNewGroup(
  granularity: GroupingGranularity,
  tabCount: number,
): number {
  return Math.min(minTabsPerNewGroup(granularity), Math.max(1, Math.floor(tabCount / 2)));
}

/**
 * Caps the number of groups relative to how many tabs there are to fill them.
 *
 * A fixed ceiling was the real cause of fragmentation: ten groups is reasonable for a hundred tabs
 * and leaves two or three tabs each for twenty. Deriving it from the floor keeps the two consistent.
 */
export function maxGroupCount(granularity: GroupingGranularity, tabCount: number): number {
  const byCapacity = Math.floor(tabCount / minTabsPerNewGroup(granularity));
  return Math.max(1, Math.min(MAX_GROUP_COUNT, byCapacity));
}
