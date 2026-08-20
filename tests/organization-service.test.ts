import { describe, expect, it } from 'vitest';

import type { FirstPageOrganizer } from '../src/background/first-page-organizer';
import { OrganizationService, type ActiveTabPlatform } from '../src/background/organization-service';
import type { PresetStore } from '../src/background/preset-store';
import type { SynchronizationService } from '../src/background/synchronization-service';
import type { TabLockStore } from '../src/background/tab-lock-store';

describe('OrganizationService', () => {
  it('hydrates locked and failed tab IDs with local title and hostname summaries', async () => {
    const tabs: ActiveTabPlatform = {
      getActiveTab: async () => null,
      getOrganizableTab: async (tabId) => ({
        tabId,
        windowId: 3,
        title: tabId === 1 ? 'Locked work' : 'Failed work',
        url: `https://${tabId === 1 ? 'locked' : 'failed'}.test/private/path`,
        groupId: -1,
        incognito: false,
        status: 'complete',
        restored: false,
      }),
    };
    const service = new OrganizationService(
      { list: async () => [] } as unknown as PresetStore,
      { list: async () => [{ tabId: 1, lockedAt: 100, changed: false }] } as unknown as TabLockStore,
      { listFailedTabIds: async () => [2] } as unknown as FirstPageOrganizer,
      {} as SynchronizationService,
      tabs,
    );

    const state = await service.getState();

    expect(state).toMatchObject({
      tabSummaries: [
        { tabId: 1, title: 'Locked work', hostname: 'locked.test' },
        { tabId: 2, title: 'Failed work', hostname: 'failed.test' },
      ],
    });
    expect(JSON.stringify(state)).not.toContain('/private/path');
  });

  it('forgets failures whose tab is gone instead of listing a bare ID nobody can act on', async () => {
    const removed: number[][] = [];
    const service = new OrganizationService(
      { list: async () => [] } as unknown as PresetStore,
      { list: async () => [] } as unknown as TabLockStore,
      {
        listFailedTabIds: async () => [7, 8],
        removeAll: async (tabIds: readonly number[]) => { removed.push([...tabIds]); },
      } as unknown as FirstPageOrganizer,
      {} as SynchronizationService,
      {
        getActiveTab: async () => null,
        getOrganizableTab: async (tabId) => tabId === 7 ? null : {
          tabId, windowId: 3, title: 'Still open', url: 'https://open.test/',
          groupId: -1, incognito: false, status: 'complete' as const, restored: false,
        },
      },
    );

    const state = await service.getState();

    expect(state.failedTabIds).toEqual([8]);
    expect(removed).toEqual([[7]]);
  });

  it('clears the record rather than failing when a retry names a tab that has been closed', async () => {
    const removed: number[][] = [];
    let listed = [5];
    const service = new OrganizationService(
      { list: async () => [] } as unknown as PresetStore,
      { list: async () => [] } as unknown as TabLockStore,
      {
        listFailedTabIds: async () => listed,
        removeAll: async (tabIds: readonly number[]) => {
          removed.push([...tabIds]);
          listed = listed.filter((tabId) => !tabIds.includes(tabId));
        },
        retry: async () => { throw new Error('retry_should_not_run'); },
      } as unknown as FirstPageOrganizer,
      {} as SynchronizationService,
      { getActiveTab: async () => null, getOrganizableTab: async () => null },
    );

    const state = await service.retryFirstPage(5);

    expect(removed[0]).toEqual([5]);
    expect(state.failedTabIds).toEqual([]);
  });
});
