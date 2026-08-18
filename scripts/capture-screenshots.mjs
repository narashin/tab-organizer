/**
 * Captures the README screenshots from the built extension.
 *
 * Everything on screen is mocked: routed hosts, invented tab titles, a fake key. Nothing from the
 * machine that runs this reaches an image, which matters because the images are published.
 *
 * Run: npm run build && node scripts/capture-screenshots.mjs
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const extensionPath = resolve(import.meta.dirname, '..', 'dist');
const outputDirectory = resolve(import.meta.dirname, '..', 'assets', 'screenshots');

const TABS = [
  { url: 'https://docs.example.com/architecture', title: 'Service architecture overview', group: 'Docs' },
  { url: 'https://docs.example.com/style-guide', title: 'Frontend style guide', group: 'Docs' },
  { url: 'https://api.example.com/reference', title: 'Payments API reference', group: 'API' },
  { url: 'https://api.example.com/webhooks', title: 'Webhook events', group: 'API' },
  { url: 'https://news.example.com/weekly', title: 'Weekly engineering digest', group: 'Reading' },
];

await mkdir(outputDirectory, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  deviceScaleFactor: 2,
  // The published images are English, whatever the machine that captures them is set to.
  locale: 'en-US',
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  await context.route('https://api.openai.com/v1/models', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"data":[]}',
  }));
  await context.route('https://api.openai.com/v1/responses', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    const input = JSON.parse(body.input ?? '{}');
    const decisions = (input.tabs ?? []).map((tab) => {
      const known = TABS.find((candidate) => candidate.title === tab.title);
      return {
        tabRef: tab.ref,
        kind: known === undefined ? 'no_change' : 'new_group',
        targetRef: null,
        suggestedName: known?.group ?? null,
        suggestedDescription: known === undefined ? null : `${known.group} pages`,
        confidence: 0.92,
        reason: known === undefined ? 'Nothing fits' : `Belongs with ${known.group}`,
      };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decisions }) }] }],
      }),
    });
  });
  for (const tab of TABS) {
    await context.route(tab.url, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<title>${tab.title}</title><main>${tab.title}</main>`,
    }));
  }

  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  await popup.getByLabel('OpenAI API key').fill('sk-example-not-a-real-key');
  await popup.getByRole('button', { name: 'Save and test' }).click();
  await popup.getByText('Connected. Organization is enabled.').waitFor();

  const shot = async (name) => {
    await popup.waitForTimeout(200);
    await popup.locator('main.app-shell').screenshot({
      path: resolve(outputDirectory, `${name}.png`),
    });
    console.log(`wrote assets/screenshots/${name}.png`);
  };

  await shot('settings');

  await popup.getByRole('button', { name: 'Presets' }).click();
  await popup.getByLabel('Name').fill('Apollo');
  await popup.getByLabel('Description').fill('Internal billing platform');
  await popup.getByLabel('Text cues, comma separated').fill('apollo, billing');
  await popup.locator('label.swatch-option:has(input[value="purple"])').click();
  await shot('presets');

  for (const tab of TABS) {
    const page = await context.newPage();
    await page.goto(tab.url);
  }
  await popup.bringToFront();
  // Reload first: the notice from saving the key has nothing to do with what this image shows.
  await popup.reload();
  await popup.getByRole('button', { name: 'Review' }).click();
  await popup.getByRole('button', { name: 'Sync current window' }).click();
  // The first summary on screen can be the "groups left uncreated" block, which is not a proposal.
  const group = popup.locator('details.group', { has: popup.locator('.check-row') }).first();
  await group.locator('summary').waitFor();
  // Open one group so the image shows what a proposal looks like from the inside.
  await group.locator('summary').click();
  // The shell clips at the popup height, so an opened group has to be brought into view.
  await group.scrollIntoViewIfNeeded();
  await shot('review');
} finally {
  await context.close();
}
