import type { OrganizationMessageHandler, OrganizationRequest, OrganizationResponse } from './organization-messages';

/**
 * The toolbar light that says a finished review is waiting.
 *
 * A review outlives the window that started it, so the answer can land with nobody watching. Until
 * now the only way to learn that was to open the popup again and hope. The badge closes that gap
 * from the browser frame, which is the one surface the extension can still reach once its own
 * window is gone.
 */
export interface BadgePlatform {
  setText(text: string): Promise<void>;
  setBackgroundColor(color: string): Promise<void>;
}

/**
 * A dot rather than a count: the badge answers "is something waiting", and the count is already on
 * the screen the badge sends the user to. A glyph rather than the space this first used, because
 * whether Chrome draws the pill around whitespace is not something the extension can observe —
 * `getBadgeText` reports back whatever was set, drawn or not.
 */
export const BADGE_LIT = '●';
export const BADGE_UNLIT = '';
export const BADGE_READY_COLOR = '#1a73e8';
export const BADGE_FAILED_COLOR = '#d93025';

type BadgeState = 'ready' | 'failed' | 'unlit';

/**
 * Lights the badge when a review lands, and puts it out once a window has the answer.
 *
 * Wrapped around the message handler rather than built into it: the badge is a Chrome surface, and
 * the services underneath organize tabs whether or not a browser is drawing them. Every decision it
 * makes comes from a request the user already sends, so nothing new has to be kept in sync.
 */
export function withReviewBadge(
  handler: OrganizationMessageHandler,
  platform: BadgePlatform,
): OrganizationMessageHandler {
  return async (message) => {
    const response = await handler(message);
    const state = badgeStateFor(message, response);
    if (state !== null) await paint(platform, state);
    return response;
  };
}

function badgeStateFor(message: unknown, response: OrganizationResponse): BadgeState | null {
  const type = requestType(message);
  if (type === null) return null;
  switch (type) {
    case 'sync/review':
      if (!response.ok) return 'failed';
      // A run that proposes nothing leaves nothing to look at, so it leaves the badge alone as
      // well. Lighting it would send the user to a screen that says "nothing to propose".
      return (response.proposal?.changes.length ?? 0) > 0 ? 'ready' : 'unlit';
    // Both mean a window now holds the answer: `sync/latest` is what a popup asks on open, and
    // `sync/seen` is what one already open reports when the run it was watching lands. A failed run
    // clears the same way, since the reason it carried was never stored to show a second time.
    case 'sync/latest':
    case 'sync/seen':
    case 'sync/apply':
      return 'unlit';
    default:
      return null;
  }
}

function requestType(message: unknown): OrganizationRequest['type'] | null {
  if (typeof message !== 'object' || message === null) return null;
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' ? type as OrganizationRequest['type'] : null;
}

/**
 * Paints the badge, and never lets that failure reach the caller.
 *
 * The tabs have already moved by the time this runs. Turning a drawing problem into a failed
 * operation would report the work as undone when it is done.
 */
async function paint(platform: BadgePlatform, state: BadgeState): Promise<void> {
  try {
    if (state === 'unlit') {
      await platform.setText(BADGE_UNLIT);
      return;
    }
    await platform.setBackgroundColor(state === 'ready' ? BADGE_READY_COLOR : BADGE_FAILED_COLOR);
    await platform.setText(BADGE_LIT);
  } catch {
    // Nothing to do: the badge is an extra, and the answer it points at is still there.
  }
}
