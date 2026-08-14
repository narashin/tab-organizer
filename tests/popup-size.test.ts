import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  clampPopupWidth,
  createLocalPopupWidthStore,
  POPUP_DEFAULT_WIDTH,
  POPUP_MAX_WIDTH,
  POPUP_MIN_WIDTH,
} from '../src/ui/popup-size';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('popup width', () => {
  it('keeps a requested width inside the range Chrome will actually render', () => {
    expect(clampPopupWidth(2_000)).toBe(POPUP_MAX_WIDTH);
    expect(clampPopupWidth(10)).toBe(POPUP_MIN_WIDTH);
    expect(clampPopupWidth(512.4)).toBe(512);
  });

  it('leaves room to drag in both directions from the default', () => {
    expect(POPUP_DEFAULT_WIDTH).toBeLessThan(POPUP_MAX_WIDTH);
    expect(POPUP_DEFAULT_WIDTH).toBeGreaterThan(POPUP_MIN_WIDTH);
  });

  it('lets the popup document size itself from its content', async () => {
    const styles = await readFile(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8');

    // Chrome refuses to grow a popup vertically, so the height belongs to the content rather than a
    // number the interface picks. Pinning it produced a frame that could only ever shrink.
    expect(styles).toMatch(/\.app-shell--popup\s*\{[^}]*height: auto;/);
    expect(styles).toMatch(
      /html:has\(\.app-shell--popup\),\s*body:has\(\.app-shell--popup\)\s*\{[^}]*height: auto;/,
    );
  });

  it('round-trips a stored width and clamps whatever was persisted earlier', () => {
    const storage = new MemoryStorage();
    const store = createLocalPopupWidthStore(storage);

    expect(store.read()).toBeNull();

    store.write(640);
    expect(store.read()).toBe(640);

    // A build with a wider limit, or a hand-edited value, must not produce a clipped popup.
    storage.setItem('popupSize', JSON.stringify({ width: 4_000 }));
    expect(store.read()).toBe(POPUP_MAX_WIDTH);
  });

  it('keeps a width that was stored while height was still adjustable', () => {
    const storage = new MemoryStorage();
    const store = createLocalPopupWidthStore(storage);
    // What the previous release wrote. The height is no longer meaningful; the width still is.
    storage.setItem('popupSize', JSON.stringify({ width: 551, height: 581 }));

    expect(store.read()).toBe(551);
  });

  it('ignores unreadable or malformed values instead of throwing', () => {
    const storage = new MemoryStorage();
    const store = createLocalPopupWidthStore(storage);

    storage.setItem('popupSize', 'not json');
    expect(store.read()).toBeNull();

    storage.setItem('popupSize', JSON.stringify({ width: 'wide' }));
    expect(store.read()).toBeNull();

    storage.setItem('popupSize', JSON.stringify({ width: Number.NaN }));
    expect(store.read()).toBeNull();
  });
});
