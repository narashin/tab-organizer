import { describe, expect, it } from 'vitest';

import {
  initializeBackground,
  type BackgroundPlatform,
} from '../src/background/initialize';
import type { SettingsMessageHandler } from '../src/background/settings-messages';
import type { StoredValues } from '../src/background/settings-service';

class FakePlatform implements BackgroundPlatform {
  readonly values: StoredValues = {};
  restrictedAccess = false;
  // Null until configured, so a missing call cannot pass as a deliberate false.
  openOnActionClick: boolean | null = null;
  handler: SettingsMessageHandler | null = null;

  readonly storage = {
    get: async (keys: readonly string[]): Promise<StoredValues> =>
      Object.fromEntries(
        keys.filter((key) => key in this.values).map((key) => [key, this.values[key]]),
      ),
    set: async (items: StoredValues): Promise<void> => {
      Object.assign(this.values, items);
    },
    remove: async (keys: readonly string[]): Promise<void> => {
      for (const key of keys) {
        delete this.values[key];
      }
    },
  };

  async restrictLocalStorageAccess(): Promise<void> {
    this.restrictedAccess = true;
  }

  async configureSidePanel(openOnActionClick: boolean): Promise<void> {
    this.openOnActionClick = openOnActionClick;
  }

  registerMessageHandler(handler: SettingsMessageHandler): void {
    this.handler = handler;
  }
}

describe('initializeBackground', () => {
  it('restricts local storage, leaves the action to the popup, and registers settings', async () => {
    const platform = new FakePlatform();
    const fetcher: typeof fetch = async () => new Response('{"data":[]}', { status: 200 });

    await initializeBackground(platform, fetcher);

    expect(platform.restrictedAccess).toBe(true);
    expect(platform.openOnActionClick).toBe(false);
    expect(platform.handler).not.toBeNull();

    const response = await platform.handler?.({
      type: 'settings/save-and-test-key',
      apiKey: 'sk-project-valid',
      systemLocale: 'en-US',
    });
    expect(response).toMatchObject({
      ok: true,
      state: { organizationEnabled: true },
    });
  });
});
