import { resolve } from 'node:path';

import { chromium, expect, test } from '@playwright/test';

test('loads the extension and completes localized BYOK onboarding', async () => {
  const classificationInputs: Array<{ mode?: string; tabs?: Array<{ ref: string }> }> = [];
  let modelsResponse: 'valid' | 'invalid' | 'offline' = 'valid';
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
    await context.route('https://api.openai.com/v1/models', async (route) => {
      if (modelsResponse === 'offline') {
        await route.abort('internetdisconnected');
        return;
      }
      await route.fulfill({
        status: modelsResponse === 'invalid' ? 401 : 200,
        contentType: 'application/json',
        body: '{"data":[]}',
      });
    });
    await context.route('https://api.openai.com/v1/responses', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { input?: string };
      const input = JSON.parse(body.input ?? '{}') as {
        mode?: 'automatic' | 'synchronization';
        tabs?: Array<{ ref: string }>;
      };
      classificationInputs.push(input);
      const decisions = (input.tabs ?? []).map((tab) => input.mode === 'automatic'
        ? {
            tabRef: tab.ref, kind: 'no_change', targetRef: null, suggestedName: null,
            suggestedDescription: null, confidence: 0.5, reason: 'No automatic change',
          }
        : {
            tabRef: tab.ref, kind: 'new_group', targetRef: null, suggestedName: 'E2E Work',
            suggestedDescription: 'End-to-end work tabs', confidence: 0.88, reason: 'Work page',
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
    await context.route('https://work.example.test/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Project work dashboard</title><main>Work</main>' });
    });
    await context.route('https://bulk.example.test/**', async (route) => {
      const index = new URL(route.request().url()).pathname.slice(1);
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<title>Bulk tab ${index}</title><main>Bulk</main>`,
      });
    });

    let [serviceWorker] = context.serviceWorkers();
    serviceWorker ??= await context.waitForEvent('serviceworker');
    const extensionId = new URL(serviceWorker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    await expect(page.getByRole('heading', { name: 'Connect OpenAI' })).toBeVisible();
    await page.getByLabel('Language').selectOption('ja');
    await expect(page.getByRole('heading', { name: 'OpenAI に接続' })).toBeVisible();

    await page.getByLabel('言語').selectOption('ko');
    await expect(page.getByRole('heading', { name: 'OpenAI 연결' })).toBeVisible();
    modelsResponse = 'invalid';
    await page.getByLabel('OpenAI API 키').fill('sk-project-e2e-invalid');
    await page.getByRole('button', { name: '저장 후 연결 테스트' }).click();
    await expect(page.getByText('키가 거부되었습니다. 정리 기능은 비활성 상태입니다.')).toBeVisible();
    modelsResponse = 'offline';
    await page.getByLabel('OpenAI API 키').fill('sk-project-e2e-offline');
    await page.getByRole('button', { name: '저장 후 연결 테스트' }).click();
    await expect(page.getByText('연결에 실패했습니다. 정리 기능은 비활성 상태입니다.')).toBeVisible();

    modelsResponse = 'valid';
    await page.getByLabel('OpenAI API 키').fill('sk-project-e2e-sensitive');
    await page.getByRole('button', { name: '저장 후 연결 테스트' }).click();

    await expect(page.getByText('연결되었습니다. 정리 기능이 활성화되었습니다.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('sk-project-e2e-sensitive');

    await page.getByLabel('언어').selectOption('en');
    await page.getByRole('button', { name: 'Review' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Presets' })).toBeFocused();
    await page.getByRole('button', { name: 'Presets' }).click();
    await page.getByLabel('Name').fill('Apollo');
    await page.getByLabel('Description').fill('Internal billing platform');
    await page.getByRole('button', { name: 'Create preset' }).click();
    await expect(page.getByText('Apollo')).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Presets' }).click();
    await expect(page.getByText('Apollo')).toBeVisible();

    const workPage = await context.newPage();
    await workPage.goto('https://work.example.test/dashboard');
    await expect(workPage).toHaveTitle('Project work dashboard');
    await page.bringToFront();
    const browserState = await serviceWorker.evaluate(async () => ({
      tabs: await chrome.tabs.query({ currentWindow: true }),
      groups: await chrome.tabGroups.query({}),
      session: await chrome.storage.session.get(null),
    }));
    expect(browserState.tabs.some((tab) => tab.url?.startsWith('https://work.example.test/'))).toBe(true);
    await page.getByRole('button', { name: 'Review' }).click();
    const synchronizationRequestStart = classificationInputs.length;
    await page.getByRole('button', { name: 'Sync current window' }).click();
    await expect.poll(() => classificationInputs
      .slice(synchronizationRequestStart)
      .some((input) => input.mode === 'synchronization')).toBe(true);
    const synchronizationInput = classificationInputs
      .slice(synchronizationRequestStart)
      .find((input) => input.mode === 'synchronization');
    expect(synchronizationInput?.tabs).toHaveLength(1);
    await expect(page.locator('summary').filter({ hasText: 'E2E Work' })).toBeVisible();

    // A second window must stay out of a current-window review. The background runs in a service
    // worker, which belongs to no window, so asking Chrome for "the current window" once answered
    // with tabs from every window and the review listed groups the user could not see.
    const otherWindow = await serviceWorker.evaluate(async () => {
      const created = await chrome.windows.create({ url: 'https://work.example.test/other', focused: false });
      return { windowId: created?.id ?? null, tabId: created?.tabs?.[0]?.id ?? null };
    });
    expect(otherWindow.windowId).not.toBeNull();
    await page.bringToFront();
    const scopedReview = await page.evaluate(async () => {
      const review = await chrome.runtime.sendMessage({ type: 'sync/review', scope: 'current' }) as {
        proposal?: { changes: Array<{ tabId: number; windowId: number }> };
      };
      return review.proposal?.changes.map((change) => change.windowId) ?? null;
    });
    expect(scopedReview).not.toBeNull();
    expect(new Set(scopedReview ?? []).size).toBe(1);
    expect(scopedReview).not.toContain(otherWindow.windowId);
    await serviceWorker.evaluate(async (windowId) => {
      if (windowId !== null) await chrome.windows.remove(windowId);
    }, otherWindow.windowId);
    const directReview = await page.evaluate(async () => {
      const review = await chrome.runtime.sendMessage({ type: 'sync/review', scope: 'current' }) as {
        proposal?: { id: string; changes: Array<{ tabId: number; selected: boolean }> };
      };
      return review.proposal ?? null;
    });
    expect(directReview).not.toBeNull();
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    const directApply = directReview === null ? null : await page.evaluate(async (proposal) => {
      return chrome.runtime.sendMessage({
        type: 'sync/apply',
        proposalId: proposal.id,
        selectedTabIds: proposal.changes.filter((change) => change.selected).map((change) => change.tabId),
      });
    }, directReview);
    await cdp.detach();
    expect(directApply).toMatchObject({ ok: true, applyResult: { applied: 1, skipped: 0 } });

    const groupsAfterApply = await serviceWorker.evaluate(async () => chrome.tabGroups.query({}));
    expect(groupsAfterApply.some((group) => group.title === 'E2E Work')).toBe(true);

    // The tab stays in the group it was moved into: an apply is final now, and the navigation
    // no longer offers a History section at all.
    await page.reload();
    expect(await page.getByRole('button', { name: 'History' }).count()).toBe(0);
    const workTabGroupId = await serviceWorker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({ url }))[0];
      return tab?.groupId ?? null;
    }, 'https://work.example.test/*');
    expect(workTabGroupId).not.toBe(-1);

    await page.evaluate(async () => {
      await chrome.runtime.sendMessage({
        type: 'settings/set-first-page',
        enabled: false,
        systemLocale: 'en-US',
      });
    });
    const bulkSetup = await serviceWorker.evaluate(async () => {
      const secondWindow = await chrome.windows.create({
        url: 'https://bulk.example.test/0',
        focused: false,
      });
      if (secondWindow === undefined || secondWindow.id === undefined || secondWindow.tabs?.[0]?.id === undefined) {
        throw new Error('second_window_creation_failed');
      }
      const currentWindowTabs: chrome.tabs.Tab[] = [];
      const secondWindowTabs: chrome.tabs.Tab[] = [];
      for (let start = 0; start < 50; start += 10) {
        const indexes = Array.from({ length: 10 }, (_, offset) => start + offset);
        const [currentBatch, secondBatch] = await Promise.all([
          Promise.all(indexes.map((index) => chrome.tabs.create({
            url: `https://bulk.example.test/${index + 1}`,
            active: false,
          }))),
          Promise.all(indexes.map((index) => chrome.tabs.create({
            windowId: secondWindow.id,
            url: `https://bulk.example.test/${index + 51}`,
            active: false,
          }))),
        ]);
        currentWindowTabs.push(...currentBatch);
        secondWindowTabs.push(...secondBatch);
      }
      return {
        tabIds: [secondWindow.tabs[0].id, ...currentWindowTabs, ...secondWindowTabs]
          .flatMap((tab) => typeof tab === 'number' ? [tab] : tab.id === undefined ? [] : [tab.id]),
        secondWindowId: secondWindow.id,
      };
    });
    const bulkTabIds = bulkSetup.tabIds;
    expect(bulkTabIds).toHaveLength(101);
    await expect.poll(async () => serviceWorker.evaluate(async () => {
      const bulkTabs = await chrome.tabs.query({ url: 'https://bulk.example.test/*' });
      return bulkTabs.filter((tab) => tab.status === 'complete').length;
    }), { timeout: 40_000 }).toBe(101);
    const bulkRequestStart = classificationInputs.length;
    const bulkResult = await page.evaluate(async () => {
      const review = await chrome.runtime.sendMessage({ type: 'sync/review', scope: 'all' }) as {
        proposal?: { id: string; changes: Array<{ tabId: number; selected: boolean }> };
      };
      if (review.proposal === undefined) return null;
      const selectedTabIds = review.proposal.changes
        .filter((change) => change.selected)
        .map((change) => change.tabId);
      const apply = await chrome.runtime.sendMessage({
        type: 'sync/apply', proposalId: review.proposal.id, selectedTabIds,
      });
      return { reviewed: review.proposal.changes.length, selected: selectedTabIds.length, apply };
    });
    // One change per bulk tab. The work tab from earlier is not among them: it already sits in the
    // group this run would propose for it, and an apply is final now, so nothing pulled it back out.
    expect(bulkResult?.reviewed).toBe(bulkTabIds.length);
    expect(bulkResult?.apply).toMatchObject({
      ok: true,
      applyResult: { applied: bulkResult?.selected, skipped: 0 },
    });
    const bulkRequests = classificationInputs.slice(bulkRequestStart)
      .filter((input) => input.mode === 'synchronization');
    expect(bulkRequests.length).toBeGreaterThanOrEqual(2);
    expect(bulkRequests.flatMap((input) => input.tabs ?? [])).toHaveLength(102);
    await serviceWorker.evaluate(async (tabIds) => chrome.tabs.remove(tabIds), bulkTabIds);
  } finally {
    await context.close();
  }
});
