import { describe, expect, it } from 'vitest';

import type { FirstPageOrganizer } from '../src/background/first-page-organizer';
import type { HistoryRestorer, HistoryStore } from '../src/background/history-store';
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
      { list: async () => [] } as unknown as HistoryStore,
      {} as HistoryRestorer,
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
});
