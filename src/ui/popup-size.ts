/**
 * Popup width, and only width.
 *
 * Measured on 2026-08-14: Chrome grows a popup horizontally when the document asks for more room,
 * but refuses to grow it vertically, before or after a reopen. Dragging down only ever widened the
 * frame, because the taller document added a vertical scrollbar and that is what needed the extra
 * width. Height is therefore left to the content, capped by Chrome, and the side panel is the way to
 * a taller surface.
 */
export const POPUP_MIN_WIDTH = 320;
export const POPUP_MAX_WIDTH = 800;
export const POPUP_DEFAULT_WIDTH = 400;
export const POPUP_KEYBOARD_STEP = 20;

export function clampPopupWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), POPUP_MIN_WIDTH), POPUP_MAX_WIDTH);
}

export interface PopupWidthStore {
  read(): number | null;
  write(width: number): void;
}

/**
 * Keeps the width in the popup document.
 *
 * The popup is dismissed on every focus loss, so a width the user dragged has to outlive the
 * document. This is a presentation preference of one surface, not extension state, which is why it
 * stays here instead of going through the background message layer.
 */
export function createLocalPopupWidthStore(storage: Storage): PopupWidthStore {
  const key = 'popupSize';
  return {
    read() {
      try {
        const raw = storage.getItem(key);
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        // A record written while height was still adjustable carries both values; only width is
        // still meaningful, and reading it keeps a dragged width across the change.
        const width = typeof parsed === 'number'
          ? parsed
          : typeof parsed === 'object' && parsed !== null
            ? (parsed as { width?: unknown }).width
            : undefined;
        return typeof width === 'number' && Number.isFinite(width)
          ? clampPopupWidth(width)
          : null;
      } catch {
        return null;
      }
    },
    write(width) {
      try {
        storage.setItem(key, JSON.stringify({ width: clampPopupWidth(width) }));
      } catch {
        // A full or blocked storage must not break resizing for the current session.
      }
    },
  };
}
