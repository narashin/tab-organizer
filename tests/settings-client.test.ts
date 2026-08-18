import { describe, expect, it } from 'vitest';

import type { BackgroundRequest } from '../src/background/settings-messages';
import { RuntimeSettingsClient } from '../src/ui/settings-client';

describe('RuntimeSettingsClient', () => {
  it('sends the request contract for every settings operation', async () => {
    const receivedRequests: BackgroundRequest[] = [];
    const client = new RuntimeSettingsClient(
      async (request) => {
        receivedRequests.push(request);
        return {
          ok: true,
          state: {
            localeSelection: 'system',
            locale: 'en',
            apiKeyStatus: 'missing',
            apiKeyConfigured: false,
            organizationEnabled: false,
            model: 'gpt-5.6',
            baseUrl: 'https://api.openai.com/v1',
            baseUrlIsDefault: true,
            groupingGranularity: 'balanced',
            sendPathEnabled: false,
            sortTabsEnabled: false,
            firstPageEnabled: true,
          },
        };
      },
      () => 'ko-KR',
    );

    await client.getState();
    await client.setLocale('ja');
    await client.setModel('gpt-5.6-mini');
    await client.setBaseUrl('https://gateway.example.test/v1');
    await client.setGroupingGranularity('broad');
    await client.setSendPathEnabled(true);
    await client.setFirstPageEnabled(false);
    await client.deleteApiKey();

    expect(receivedRequests).toEqual([
      { type: 'settings/get', systemLocale: 'ko-KR' },
      { type: 'settings/set-locale', localeSelection: 'ja', systemLocale: 'ko-KR' },
      { type: 'settings/set-model', model: 'gpt-5.6-mini', systemLocale: 'ko-KR' },
      {
        type: 'settings/set-base-url',
        baseUrl: 'https://gateway.example.test/v1',
        systemLocale: 'ko-KR',
      },
      { type: 'settings/set-grouping', granularity: 'broad', systemLocale: 'ko-KR' },
      { type: 'settings/set-send-path', enabled: true, systemLocale: 'ko-KR' },
      { type: 'settings/set-first-page', enabled: false, systemLocale: 'ko-KR' },
      { type: 'settings/delete-key', systemLocale: 'ko-KR' },
    ] satisfies BackgroundRequest[]);
  });

  it('sends a typed save request with the current system locale', async () => {
    let receivedRequest: BackgroundRequest | null = null;
    const client = new RuntimeSettingsClient(
      async (request) => {
        receivedRequest = request;
        return {
          ok: true,
          state: {
            localeSelection: 'system',
            locale: 'ja',
            apiKeyStatus: 'valid',
            apiKeyConfigured: true,
            organizationEnabled: true,
            model: 'gpt-5.6',
            baseUrl: 'https://api.openai.com/v1',
            baseUrlIsDefault: true,
            groupingGranularity: 'balanced',
            sendPathEnabled: false,
            sortTabsEnabled: false,
            firstPageEnabled: true,
          },
        };
      },
      () => 'ja-JP',
    );

    const state = await client.saveAndTestApiKey('sk-project-sensitive');

    expect(receivedRequest).toEqual({
      type: 'settings/save-and-test-key',
      apiKey: 'sk-project-sensitive',
      systemLocale: 'ja-JP',
    });
    expect(state.organizationEnabled).toBe(true);
    expect(JSON.stringify(state)).not.toContain('sk-project-sensitive');
  });

  it('rejects an unsuccessful background response without exposing details', async () => {
    const client = new RuntimeSettingsClient(
      async () => ({ ok: false, error: 'operation_failed' }),
      () => 'en-US',
    );

    await expect(client.getState()).rejects.toThrow('settings_request_failed');
  });

  it('rejects a malformed successful response at the runtime boundary', async () => {
    const client = new RuntimeSettingsClient(
      async () => ({
        ok: true,
        state: { apiKey: 'sk-project-sensitive' },
      }),
      () => 'en-US',
    );

    await expect(client.getState()).rejects.toThrow('settings_request_failed');
  });

  it('rejects a state that omits the base URL the panel needs to disclose', async () => {
    const client = new RuntimeSettingsClient(
      async () => ({
        ok: true,
        state: {
          localeSelection: 'system', locale: 'en', apiKeyStatus: 'missing',
          apiKeyConfigured: false, organizationEnabled: false, model: 'gpt-5.6',
          firstPageEnabled: true,
        },
      }),
      () => 'en-US',
    );

    await expect(client.getState()).rejects.toThrow('settings_request_failed');
  });
});
