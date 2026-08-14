import { describe, expect, it } from 'vitest';

import { resolveLocale, translations } from '../src/shared/localization';

describe('resolveLocale', () => {
  it.each([
    { selection: 'system', systemLocale: 'ko-KR', expected: 'ko' },
    { selection: 'system', systemLocale: 'ja-JP', expected: 'ja' },
    { selection: 'system', systemLocale: 'fr-FR', expected: 'en' },
    { selection: 'en', systemLocale: 'ko-KR', expected: 'en' },
    { selection: 'ko', systemLocale: 'en-US', expected: 'ko' },
    { selection: 'ja', systemLocale: 'en-US', expected: 'ja' },
  ] as const)(
    'resolves $selection with $systemLocale to $expected',
    ({ selection, systemLocale, expected }) => {
      expect(resolveLocale(selection, systemLocale)).toBe(expected);
    },
  );
});

describe('translation catalogs', () => {
  it('keeps every supported locale at English key parity', () => {
    const englishKeys = Object.keys(translations.en).sort();

    expect(Object.keys(translations.ko).sort()).toEqual(englishKeys);
    expect(Object.keys(translations.ja).sort()).toEqual(englishKeys);
  });
});
