import { describe, expect, it } from 'vitest';

import {
  createSettingsMessageHandler,
  type BackgroundResponse,
} from '../src/background/settings-messages';
import {
  DEFAULT_API_BASE_URL,
  SettingsService,
  type LocalStorageArea,
} from '../src/background/settings-service';

class MemoryStorage implements LocalStorageArea {
  private readonly values: Record<string, unknown> = {};

  async get(keys: readonly string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(
      keys.filter((key) => key in this.values).map((key) => [key, this.values[key]]),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      delete this.values[key];
    }
  }
}

describe('settings message handler', () => {
  it('returns a secret-free enabled state after a save-and-test request', async () => {
    const service = new SettingsService(new MemoryStorage(), async () => ({
      status: 'valid',
    }));
    const handleMessage = createSettingsMessageHandler(service);

    const response = await handleMessage({
      type: 'settings/save-and-test-key',
      apiKey: 'sk-project-sensitive',
      systemLocale: 'en-US',
    });

    expect(response).toEqual({
      ok: true,
      state: {
        localeSelection: 'system',
        locale: 'en',
        provider: 'openai',
        providerKeys: { openai: true, anthropic: false, google: false },
        apiKeyStatus: 'valid',
        apiKeyConfigured: true,
        organizationEnabled: true,
        model: 'gpt-5.6',
        baseUrl: DEFAULT_API_BASE_URL,
        baseUrlIsDefault: true,
        groupingGranularity: 'balanced',
        sendPathEnabled: false,
        sortTabsEnabled: false,
        firstPageEnabled: true,
      },
    } satisfies BackgroundResponse);
    expect(JSON.stringify(response)).not.toContain('sk-project-sensitive');
  });

  it('routes model and first-page updates to their settings operations', async () => {
    const service = new SettingsService(new MemoryStorage(), async () => ({
      status: 'valid',
    }));
    const handleMessage = createSettingsMessageHandler(service);

    const modelResponse = await handleMessage({
      type: 'settings/set-model',
      model: 'gpt-5.6-mini',
      systemLocale: 'en-US',
    });
    const firstPageResponse = await handleMessage({
      type: 'settings/set-first-page',
      enabled: false,
      systemLocale: 'en-US',
    });

    expect(modelResponse.ok && modelResponse.state.model).toBe('gpt-5.6-mini');
    expect(firstPageResponse.ok && firstPageResponse.state.firstPageEnabled).toBe(false);
  });

  it('routes a base URL update and refuses one the validator rejects', async () => {
    const service = new SettingsService(new MemoryStorage(), async () => ({ status: 'valid' }));
    const handleMessage = createSettingsMessageHandler(service);

    const accepted = await handleMessage({
      type: 'settings/set-base-url',
      baseUrl: 'https://gateway.example.test/v1',
      systemLocale: 'en-US',
    });
    const rejected = await handleMessage({
      type: 'settings/set-base-url',
      baseUrl: 'http://example.com/v1',
      systemLocale: 'en-US',
    });
    const malformed = await handleMessage({
      type: 'settings/set-base-url',
      systemLocale: 'en-US',
    });

    expect(accepted.ok && accepted.state.baseUrl).toBe('https://gateway.example.test/v1');
    expect(rejected).toEqual({ ok: false, error: 'operation_failed' });
    expect(malformed).toEqual({ ok: false, error: 'invalid_request' });
  });

  it('rejects malformed messages without invoking settings behavior', async () => {
    const service = new SettingsService(new MemoryStorage(), async () => ({
      status: 'valid',
    }));
    const handleMessage = createSettingsMessageHandler(service);

    await expect(handleMessage({ type: 'settings/save-and-test-key' })).resolves.toEqual({
      ok: false,
      error: 'invalid_request',
    });
    await expect(handleMessage({ type: 'tabs/group-all' })).resolves.toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });
});
