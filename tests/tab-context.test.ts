import { describe, expect, it } from 'vitest';

import { toClassificationHostname } from '../src/shared/tab-context';

describe('toClassificationHostname', () => {
  it('sends the hostname alone by default', () => {
    expect(toClassificationHostname('https://jira.example.test/browse/ATLAS-431', false))
      .toBe('jira.example.test');
  });

  it('adds the path when the user opts in', () => {
    expect(toClassificationHostname('https://jira.example.test/browse/ATLAS-431', true))
      .toBe('jira.example.test/browse/ATLAS-431');
  });

  it('never sends a query or fragment even when the path is opted in', () => {
    // Tokens, search terms, and one-time links live here; the path is structural by comparison.
    expect(toClassificationHostname('https://mail.example.test/u/0?token=abc123', true))
      .toBe('mail.example.test/u/0');
    expect(toClassificationHostname('https://example.test/search?q=private+words', true))
      .toBe('example.test/search');
    expect(toClassificationHostname('https://example.test/reset#one-time-link', true))
      .toBe('example.test/reset');
  });

  it('drops a bare or trailing slash so the value stays comparable', () => {
    expect(toClassificationHostname('https://example.test/', true)).toBe('example.test');
    expect(toClassificationHostname('https://example.test/a/', true)).toBe('example.test/a');
  });

  it('returns an empty string for anything that is not web content', () => {
    expect(toClassificationHostname('chrome://settings', true)).toBe('');
    expect(toClassificationHostname('not-a-url', true)).toBe('');
  });
});
