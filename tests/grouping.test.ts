import { describe, expect, it } from 'vitest';

import {
  taxonomyTimeoutMs,
  TAXONOMY_TIMEOUT_CEILING_MS,
  TAXONOMY_TIMEOUT_FLOOR_MS,
} from '../src/background/classifier';

describe('taxonomy timeout', () => {
  it('grows with the window, because reading a hundred titles is not an eight-second job', () => {
    // The flat ceiling this replaced aborted every attempt on a hundred-tab window.
    expect(taxonomyTimeoutMs(100)).toBeGreaterThan(8_000);
    expect(taxonomyTimeoutMs(100)).toBeGreaterThan(taxonomyTimeoutMs(20));
  });

  it('keeps a floor for small windows and a ceiling for absurd ones', () => {
    expect(taxonomyTimeoutMs(1)).toBe(TAXONOMY_TIMEOUT_FLOOR_MS);
    expect(taxonomyTimeoutMs(10_000)).toBe(TAXONOMY_TIMEOUT_CEILING_MS);
  });
});

import {
  DEFAULT_GROUPING_GRANULARITY,
  MAX_GROUP_COUNT,
  effectiveMinTabsPerNewGroup,
  maxGroupCount,
  minTabsPerNewGroup,
} from '../src/shared/grouping';

describe('grouping granularity', () => {
  it('defaults to the middle setting', () => {
    expect(DEFAULT_GROUPING_GRANULARITY).toBe('balanced');
  });

  it('raises the floor as the user asks for broader groups', () => {
    expect(minTabsPerNewGroup('fine')).toBe(3);
    expect(minTabsPerNewGroup('balanced')).toBe(4);
    expect(minTabsPerNewGroup('broad')).toBe(6);
  });

  it('scales the group ceiling with the tab count instead of fixing it', () => {
    // A fixed ceiling of ten is fine for a hundred tabs and absurd for twenty.
    expect(maxGroupCount('balanced', 25)).toBe(6);
    expect(maxGroupCount('broad', 25)).toBe(4);
    expect(maxGroupCount('fine', 25)).toBe(8);
    expect(maxGroupCount('balanced', 100)).toBe(MAX_GROUP_COUNT);
  });

  it('scales the floor down so a small window still organizes', () => {
    expect(effectiveMinTabsPerNewGroup('balanced', 2)).toBe(1);
    expect(effectiveMinTabsPerNewGroup('balanced', 5)).toBe(2);
    expect(effectiveMinTabsPerNewGroup('balanced', 25)).toBe(4);
    expect(effectiveMinTabsPerNewGroup('broad', 25)).toBe(6);
  });

  it('always allows at least one group so a small window still organizes', () => {
    expect(maxGroupCount('broad', 1)).toBe(1);
    expect(maxGroupCount('broad', 0)).toBe(1);
  });
});
