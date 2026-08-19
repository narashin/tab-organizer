import { describe, expect, it } from 'vitest';

import type { OrganizationResponse } from '../src/background/organization-messages';
import {
  BADGE_FAILED_COLOR,
  BADGE_LIT,
  BADGE_READY_COLOR,
  BADGE_UNLIT,
  withReviewBadge,
  type BadgePlatform,
} from '../src/background/review-badge';
import type { SynchronizationProposal } from '../src/background/synchronization-service';

class RecordingBadge implements BadgePlatform {
  texts: string[] = [];
  colors: string[] = [];
  async setText(text: string) { this.texts.push(text); }
  async setBackgroundColor(color: string) { this.colors.push(color); }
}

/** Fails the way Chrome does when the toolbar button is gone, to prove the answer still arrives. */
class BrokenBadge implements BadgePlatform {
  async setText(): Promise<void> { throw new Error('no such action'); }
  async setBackgroundColor(): Promise<void> { throw new Error('no such action'); }
}

function proposalWith(changeCount: number): SynchronizationProposal {
  return {
    id: 'proposal-1',
    scope: 'current',
    unchangedCount: 0,
    failedTabs: [],
    skippedGroups: [],
    planFailureReason: null,
    changes: Array.from({ length: changeCount }, (_unused, index) => ({
      tabId: index + 1,
      windowId: 1,
      title: 'Apollo billing',
      hostname: 'billing.example.test',
      currentGroup: null,
      currentGroupId: -1,
      target: { kind: 'new_group' as const, ref: null, groupId: null, title: 'Work', color: 'grey' as const, description: null },
      confidence: 0.8,
      reason: 'Related',
      selected: true,
      blockedReason: null,
      splitViewId: null,
    })),
  };
}

function answering(response: OrganizationResponse) {
  return async () => response;
}

describe('review badge', () => {
  it('lights up when a review lands with something to look at', async () => {
    const badge = new RecordingBadge();
    const handler = withReviewBadge(answering({ ok: true, proposal: proposalWith(2) }), badge);

    await handler({ type: 'sync/review', scope: 'current' });

    expect(badge.texts).toEqual([BADGE_LIT]);
    expect(badge.colors).toEqual([BADGE_READY_COLOR]);
  });

  it('stays out when the review proposes nothing', async () => {
    const badge = new RecordingBadge();
    const handler = withReviewBadge(answering({ ok: true, proposal: proposalWith(0) }), badge);

    await handler({ type: 'sync/review', scope: 'current' });

    expect(badge.texts).toEqual([BADGE_UNLIT]);
    expect(badge.colors).toEqual([]);
  });

  it('marks a failed review apart from a finished one', async () => {
    const badge = new RecordingBadge();
    const handler = withReviewBadge(
      answering({ ok: false, error: 'operation_failed', reason: 'organization_disabled' }),
      badge,
    );

    await handler({ type: 'sync/review', scope: 'current' });

    expect(badge.texts).toEqual([BADGE_LIT]);
    expect(badge.colors).toEqual([BADGE_FAILED_COLOR]);
  });

  it.each([
    ['sync/latest', { type: 'sync/latest' }],
    ['sync/seen', { type: 'sync/seen' }],
    ['sync/apply', { type: 'sync/apply', proposalId: 'proposal-1', selectedTabIds: [1] }],
  ])('goes out once a window has the answer, via %s', async (_name, message) => {
    const badge = new RecordingBadge();
    const handler = withReviewBadge(answering({ ok: true }), badge);

    await handler(message);

    expect(badge.texts).toEqual([BADGE_UNLIT]);
  });

  it('leaves the badge alone for messages that say nothing about a review', async () => {
    const badge = new RecordingBadge();
    const handler = withReviewBadge(answering({ ok: true }), badge);

    await handler({ type: 'presets/delete', id: 'preset-1' });
    await handler({ type: 'locks/lock', tabId: 4 });
    await handler('not a request at all');

    expect(badge.texts).toEqual([]);
  });

  it('answers the caller even when the badge cannot be drawn', async () => {
    const handler = withReviewBadge(answering({ ok: true, proposal: proposalWith(1) }), new BrokenBadge());

    await expect(handler({ type: 'sync/review', scope: 'current' })).resolves.toEqual({
      ok: true, proposal: proposalWith(1),
    });
  });
});
