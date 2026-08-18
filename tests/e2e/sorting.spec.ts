import { resolve } from 'node:path';

import { chromium, expect, test } from '@playwright/test';

/**
 * Drives a real window through review, apply and the alphabetical sort.
 *
 * The unit tests prove the plan and the gate; only Chrome can say whether the moves it receives put
 * the strip in the order the plan describes, and whether the setting is still on by the time apply
 * runs. Both were reported as not working with the box ticked.
 */
test('sorts by preset order first, then alphabetically, once the setting is on', async () => {
  const extensionPath = resolve(import.meta.dirname, '../../dist');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  // Each page is named so the expected order is obvious: zulu, mike, alfa across two groups.
  // Four tabs per group: the floor for a brand new group rises with the window, and a group under
  // it is discarded before anything can be sorted.
  const pages = [
    { path: 'zulu', title: 'Zulu report', group: 'Docs' },
    { path: 'mike', title: 'Mike memo', group: 'Docs' },
    { path: 'delta', title: 'Delta draft', group: 'Docs' },
    { path: 'golf', title: 'Golf guide', group: 'Docs' },
    { path: 'papa', title: 'Papa spec', group: 'API' },
    { path: 'alfa', title: 'Alfa notes', group: 'API' },
    { path: 'echo', title: 'Echo endpoint', group: 'API' },
    { path: 'charlie', title: 'Charlie reference', group: 'API' },
    { path: 'yankee', title: 'Yankee loose', group: null },
    { path: 'bravo', title: 'Bravo loose', group: null },
  ];

  try {
    await context.route('https://api.openai.com/v1/models', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: '{"data":[]}',
    }));
    await context.route('https://api.openai.com/v1/responses', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { input?: string };
      const input = JSON.parse(body.input ?? '{}') as {
        mode?: string;
        tabs?: Array<{ ref: string; title: string }>;
      };
      const decisions = (input.tabs ?? []).map((tab) => {
        const known = pages.find((page) => tab.title.includes(page.title));
        return known?.group === undefined || known.group === null
          ? {
              tabRef: tab.ref, kind: 'no_change', targetRef: null, suggestedName: null,
              suggestedDescription: null, confidence: 0.5, reason: 'Leave it loose',
            }
          : {
              tabRef: tab.ref, kind: 'new_group', targetRef: null, suggestedName: known.group,
              suggestedDescription: `${known.group} pages`, confidence: 0.9, reason: 'Belongs here',
            };
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          output: [{ type: 'message', content: [{
            type: 'output_text', text: JSON.stringify({ decisions }),
          }] }],
        }),
      });
    });
    for (const page of pages) {
      await context.route(`https://sort.example.test/${page.path}`, (route) => route.fulfill({
        status: 200, contentType: 'text/html', body: `<title>${page.title}</title><main>x</main>`,
      }));
    }

    let [serviceWorker] = context.serviceWorkers();
    serviceWorker ??= await context.waitForEvent('serviceworker');
    const extensionId = new URL(serviceWorker.url()).host;

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByLabel('OpenAI API key').fill('sk-e2e-not-a-real-key');
    await popup.getByRole('button', { name: 'Save and test' }).click();
    await popup.getByText('Connected. Organization is enabled.').waitFor();
    // Opened out of order on purpose, so a passing assertion cannot be the order they arrived in.
    for (const page of pages) {
      const tab = await context.newPage();
      await tab.goto(`https://sort.example.test/${page.path}`);
    }

    // A preset named after the group that would otherwise sort last. Its position, not the
    // alphabet, has to decide where the group goes.
    await popup.evaluate(async () => {
      await chrome.runtime.sendMessage({
        type: 'presets/create',
        draft: { name: 'Docs', description: 'Documentation pages', cues: [], color: 'purple' },
      });
    });

    const proposal = await popup.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'sync/review', scope: 'current' });
      return response.proposal as { id: string; changes: Array<{ tabId: number }> };
    });

    // Turned on after the review, which is how a user who just noticed the setting would do it. The
    // apply has to read the setting as it stands, not as it stood when the classification ran.
    const sortBox = popup.getByRole('checkbox', { name: 'Sort tabs alphabetically after applying' });
    await sortBox.click();
    await expect(sortBox).toBeChecked();
    const applied = await popup.evaluate(async (pending) => chrome.runtime.sendMessage({
      type: 'sync/apply',
      proposalId: pending.id,
      selectedTabIds: pending.changes.map((change) => change.tabId),
    }), proposal);
    expect(applied).toMatchObject({ ok: true });

    const strip = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ windowId: (await chrome.windows.getCurrent()).id });
      const groups = new Map(
        (await chrome.tabGroups.query({})).map((group) => [group.id, group.title ?? '']),
      );
      return tabs
        .sort((left, right) => left.index - right.index)
        .map((tab) => `${groups.get(tab.groupId) ?? '-'}:${tab.title ?? ''}`);
    });

    const grouped = strip.filter((entry) => !entry.startsWith('-:'));
    const loose = strip.filter((entry) => entry.startsWith('-:'));

    // Docs first because a preset names it, then API alphabetically, members by title throughout.
    expect(grouped).toEqual([
      'Docs:Delta draft',
      'Docs:Golf guide',
      'Docs:Mike memo',
      'Docs:Zulu report',
      'API:Alfa notes',
      'API:Charlie reference',
      'API:Echo endpoint',
      'API:Papa spec',
    ]);
    // Every group sits ahead of every loose tab, with no group split around one.
    expect(strip.slice(0, grouped.length)).toEqual(grouped);
    // The loose tabs are gathered at the end and sorted among themselves. The blank tab and the
    // popup page belong to the harness rather than to the case, so only the order is asserted.
    expect(loose).toEqual([...loose].sort((left, right) => left.localeCompare(right, 'en', {
      sensitivity: 'base',
      numeric: true,
    })));
    expect(loose).toContain('-:Bravo loose');
    expect(loose.indexOf('-:Bravo loose')).toBeLessThan(loose.indexOf('-:Yankee loose'));
  } finally {
    await context.close();
  }
});
