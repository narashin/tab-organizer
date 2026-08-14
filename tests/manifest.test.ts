import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import manifest from '../public/manifest.json';
import englishMessages from '../public/_locales/en/messages.json';
import japaneseMessages from '../public/_locales/ja/messages.json';
import koreanMessages from '../public/_locales/ko/messages.json';

describe('Manifest V3 contract', () => {
  it('opens the side panel with only required permissions and OpenAI host access', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe('116');
    expect(manifest.permissions).toEqual(['sidePanel', 'storage', 'tabs', 'tabGroups']);
    expect(manifest.host_permissions).toEqual(['https://api.openai.com/*']);
    // A custom endpoint cannot be declared up front, so it is granted at runtime instead.
    expect(manifest.optional_host_permissions).toEqual([
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ]);
    expect(manifest.side_panel.default_path).toBe('sidepanel.html');
    expect(manifest.action.default_title).toBe('__MSG_actionTitle__');
    // The action opens the popup; the side panel stays reachable from inside it.
    expect(manifest.action.default_popup).toBe('popup.html');
    // Without declared icons Chrome draws the first letter of the localized name, which differs per
    // locale. Every declared file must also exist in the packaged output.
    const iconPaths = ['16', '32', '48', '128'].map((size) => `icons/icon-${size}.png`);
    expect(Object.values(manifest.icons)).toEqual(iconPaths);
    expect(Object.values(manifest.action.default_icon)).toEqual(iconPaths);
  });

  it('ships every icon the manifest declares', async () => {
    const declared = [
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
    ];

    for (const relativePath of new Set(declared)) {
      const file = await readFile(resolve(process.cwd(), 'public', relativePath));
      expect(file.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
    expect(manifest.background).toEqual({
      service_worker: 'assets/background.js',
      type: 'module',
    });
  });

  it('keeps manifest locale keys at parity', () => {
    const englishKeys = Object.keys(englishMessages).sort();

    expect(Object.keys(koreanMessages).sort()).toEqual(englishKeys);
    expect(Object.keys(japaneseMessages).sort()).toEqual(englishKeys);
  });
});
