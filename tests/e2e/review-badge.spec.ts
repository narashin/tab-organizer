import { resolve } from 'node:path';

import { chromium, expect, test } from '@playwright/test';

import { BADGE_FAILED_COLOR, BADGE_LIT, BADGE_UNLIT } from '../../src/background/review-badge';

/**
 * Proves the badge reaches the real toolbar, which no unit test can.
 *
 * The wrapper is covered in isolation already; what only a browser can answer is whether the
 * worker's call is accepted and whether the text survives it. A review with no key configured fails,
 * which is the one badge state reachable without standing up a provider.
 */
test('lights the toolbar badge when a review fails, and puts it out once a window asks', async () => {
  const extensionPath = resolve(import.meta.dirname, '../../dist');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    await context.route('https://work.example.test/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Apollo billing</title>' });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    // A review with nothing to look at finishes as "nothing to propose", which leaves the badge
    // alone by design. The window needs a real tab before the run can reach a different outcome.
    const workPage = await context.newPage();
    await workPage.goto('https://work.example.test/dashboard');
    // A worker does not receive its own messages, so the requests come from an extension page, which
    // is also where they come from in use.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await page.getByRole('heading', { name: 'Connect OpenAI' }).waitFor();

    await page.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'sync/review', scope: 'current' });
    });
    const afterFailedReview = await worker.evaluate(async () => ({
      text: await chrome.action.getBadgeText({}),
      color: await chrome.action.getBadgeBackgroundColor({}),
    }));

    expect(afterFailedReview.text).toBe(BADGE_LIT);
    // Chrome answers with the colour as RGBA components rather than the hex it was given.
    expect(rgbaToHex(afterFailedReview.color)).toBe(BADGE_FAILED_COLOR);

    await page.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'sync/latest' });
    });

    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe(BADGE_UNLIT);
  } finally {
    await context.close();
  }
});

function rgbaToHex(color: readonly number[]): string {
  const [red = 0, green = 0, blue = 0] = color;
  return `#${[red, green, blue].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}
