/**
 * Captures the Chrome tab strip after the extension has grouped real tabs.
 *
 * The groups in the image are real: the extension runs in a real Chromium and calls the Chrome
 * grouping API. Only the pages behind the tabs are mocked, so nothing from the machine that runs
 * this reaches the image.
 *
 * macOS only, and only useful with a display: the tab strip is browser UI, which the page
 * screenshot API cannot reach, so the region the window occupies is captured instead. Screen
 * Recording permission is required for the terminal running it.
 *
 * Run: npm run build && node scripts/capture-tab-strip.mjs
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';

const extensionPath = resolve(import.meta.dirname, '..', 'dist');
const outputPath = resolve(import.meta.dirname, '..', 'assets', 'screenshots', 'tab-strip.png');
const TABS = [
  { url: 'https://docs.example.com/architecture', title: 'Service architecture overview', group: 'Docs' },
  { url: 'https://docs.example.com/style-guide', title: 'Frontend style guide', group: 'Docs' },
  { url: 'https://api.example.com/reference', title: 'Payments API reference', group: 'API' },
  { url: 'https://api.example.com/webhooks', title: 'Webhook events', group: 'API' },
];
if (process.platform !== 'darwin') {
  console.error('This capture uses the macOS screencapture command; run it on macOS.');
  process.exit(1);
}

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: false, locale: 'en-US',
  args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
    '--window-position=0,0', '--window-size=1280,820',
  ],
});
try {
  await context.route('https://api.openai.com/v1/models', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
  await context.route('https://api.openai.com/v1/responses', async (route) => {
    const input = JSON.parse(JSON.parse(route.request().postData() ?? '{}').input ?? '{}');
    const decisions = (input.tabs ?? []).map((tab) => {
      const known = TABS.find((c) => c.title === tab.title);
      return { tabRef: tab.ref, kind: known ? 'new_group' : 'no_change', targetRef: null,
        suggestedName: known?.group ?? null, suggestedDescription: known ? `${known.group} pages` : null,
        confidence: 0.93, reason: known ? `Belongs with ${known.group}` : 'Nothing fits' };
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decisions }) }] }] }) });
  });
  for (const t of TABS) await context.route(t.url, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: `<title>${t.title}</title><main>${t.title}</main>` }));

  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByLabel('OpenAI API key').fill('sk-example-not-a-real-key');
  await popup.getByRole('button', { name: 'Save and test' }).click();
  await popup.getByText('Connected. Organization is enabled.').waitFor();
  for (const t of TABS) { const p = await context.newPage(); await p.goto(t.url); }
  // The blank starter tab adds nothing to the image.
  for (const page of context.pages()) {
    if (page.url() === 'about:blank') await page.close();
  }
  await popup.bringToFront();
  await popup.getByRole('button', { name: 'Sync', exact: true }).click();
  await popup.getByRole('button', { name: 'Sync tabs that need it' }).click();
  await popup.locator('summary').first().waitFor();
  await popup.getByRole('button', { name: /Apply selected/ }).click();
  await popup.waitForTimeout(1500);
  const groups = await worker.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => `${g.title}:${g.color}`));
  console.log('real chrome groups:', JSON.stringify(groups));
  // The tab strip is browser UI, so the page screenshot API cannot reach it. Grab the region the
  // window occupies instead; the window was positioned at the top-left on purpose.
  await popup.waitForTimeout(800);
  // Start below the menu bar: the region is the browser window, not the desktop around it.
  execFileSync('screencapture', ['-x', '-R', '0,38,1280,86', outputPath]);
  console.log('captured tab strip');
} finally { await context.close(); }
