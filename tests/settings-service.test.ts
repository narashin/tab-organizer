import { describe, expect, it } from 'vitest';

import type { ApiKeyValidationResult } from '../src/background/provider-key';
import {
  DEFAULT_API_BASE_URL,
  SettingsService,
  normalizeBaseUrl,
  type LocalStorageArea,
  type StoredValues,
} from '../src/background/settings-service';

class MemoryStorage implements LocalStorageArea {
  readonly values: StoredValues = {};

  async get(keys: readonly string[]): Promise<StoredValues> {
    return Object.fromEntries(
      keys.filter((key) => key in this.values).map((key) => [key, this.values[key]]),
    );
  }

  async set(items: StoredValues): Promise<void> {
    Object.assign(this.values, items);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      delete this.values[key];
    }
  }
}

describe('SettingsService', () => {
  it('returns a disabled, secret-free state before a key is configured', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));

    const state = await service.getState('fr-FR');

    expect(state).toEqual({
      localeSelection: 'system',
      locale: 'en',
      provider: 'openai',
      providerKeys: { openai: false, anthropic: false, google: false },
      apiKeyStatus: 'missing',
      apiKeyConfigured: false,
      organizationEnabled: false,
      model: 'gpt-5.6',
      baseUrl: DEFAULT_API_BASE_URL,
      baseUrlIsDefault: true,
      groupingGranularity: 'balanced',
      sendPathEnabled: false,
      firstPageEnabled: true,
    });
    expect('openAiApiKey' in state).toBe(false);
    expect('apiKey' in state).toBe(false);
  });

  it('stores a valid key locally while returning only masked state', async () => {
    const storage = new MemoryStorage();
    const validator = async (key: string): Promise<ApiKeyValidationResult> =>
      key === 'sk-project-valid' ? { status: 'valid' } : { status: 'invalid' };
    const service = new SettingsService(storage, validator);

    const state = await service.saveAndTestApiKey('sk-project-valid', 'ko-KR');

    expect(storage.values).toEqual({
      apiKeys: { openai: 'sk-project-valid' },
      settings: {
        localeSelection: 'system',
        provider: 'openai',
        providers: {
          openai: { model: 'gpt-5.6', baseUrl: DEFAULT_API_BASE_URL, apiKeyStatus: 'valid' },
          anthropic: {
            model: 'claude-opus-5',
            baseUrl: 'https://api.anthropic.com/v1',
            apiKeyStatus: 'missing',
          },
          google: {
            model: 'gemini-3.5-flash',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            apiKeyStatus: 'missing',
          },
        },
        groupingGranularity: 'balanced',
        sendPathEnabled: false,
        firstPageEnabled: true,
      },
    });
    expect(state).toEqual({
      localeSelection: 'system',
      locale: 'ko',
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
      firstPageEnabled: true,
    });
    expect(JSON.stringify(state)).not.toContain('sk-project-valid');
  });

  it.each([
    { validationStatus: 'invalid', expectedStatus: 'invalid' },
    { validationStatus: 'error', expectedStatus: 'error' },
  ] as const)(
    'keeps organization disabled after $validationStatus validation',
    async ({ validationStatus, expectedStatus }) => {
      const storage = new MemoryStorage();
      const service = new SettingsService(storage, async () => ({
        status: validationStatus,
      }));

      const state = await service.saveAndTestApiKey('sk-project-example', 'en-US');

      expect(state.apiKeyStatus).toBe(expectedStatus);
      expect(state.apiKeyConfigured).toBe(true);
      expect(state.organizationEnabled).toBe(false);
    },
  );

  it('applies an explicit language immediately and persists it', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));

    const state = await service.setLocale('ja', 'ko-KR');

    expect(state.locale).toBe('ja');
    expect(storage.values.settings).toMatchObject({
      localeSelection: 'ja',
      provider: 'openai',
      providers: {
        openai: { model: 'gpt-5.6', baseUrl: DEFAULT_API_BASE_URL, apiKeyStatus: 'missing' },
      },
      groupingGranularity: 'balanced',
      sendPathEnabled: false,
      firstPageEnabled: true,
    });
  });

  it('removes a configured key and disables organization', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));
    await service.saveAndTestApiKey('sk-project-valid', 'en-US');

    const state = await service.deleteApiKey('en-US');

    expect(storage.values.apiKeys).toEqual({});
    expect(storage.values.openAiApiKey).toBeUndefined();
    expect(state.apiKeyStatus).toBe('missing');
    expect(state.apiKeyConfigured).toBe(false);
    expect(state.organizationEnabled).toBe(false);
  });

  it('does not restore a key when validation completes after deletion', async () => {
    const storage = new MemoryStorage();
    storage.values.openAiApiKey = 'sk-project-existing';
    let resolveValidation: ((result: ApiKeyValidationResult) => void) | undefined;
    const validation = new Promise<ApiKeyValidationResult>((resolve) => {
      resolveValidation = resolve;
    });
    const service = new SettingsService(storage, async () => validation);

    const saving = service.saveAndTestApiKey('sk-project-new', 'en-US');
    await Promise.resolve();
    await service.deleteApiKey('en-US');
    resolveValidation?.({ status: 'valid' });
    await saving;

    expect(storage.values.apiKeys).toEqual({});
    expect(storage.values.openAiApiKey).toBeUndefined();
    await expect(service.getState('en-US')).resolves.toMatchObject({
      apiKeyStatus: 'missing',
      organizationEnabled: false,
    });
  });

  it('preserves settings changed while API key validation is pending', async () => {
    const storage = new MemoryStorage();
    let resolveValidation: ((result: ApiKeyValidationResult) => void) | undefined;
    const validation = new Promise<ApiKeyValidationResult>((resolve) => {
      resolveValidation = resolve;
    });
    const service = new SettingsService(storage, async () => validation);

    const saving = service.saveAndTestApiKey('sk-project-valid', 'en-US');
    await Promise.resolve();
    await service.setLocale('ja', 'en-US');
    await service.setModel('gpt-5.6-mini', 'en-US');
    await service.setFirstPageEnabled(false, 'en-US');
    resolveValidation?.({ status: 'valid' });
    const state = await saving;

    expect(state).toMatchObject({
      localeSelection: 'ja',
      locale: 'ja',
      model: 'gpt-5.6-mini',
      firstPageEnabled: false,
      organizationEnabled: true,
    });
  });

  it('does not replace a valid key when its validation status cannot be stored', async () => {
    const storage = new MemoryStorage();
    storage.values.openAiApiKey = 'sk-project-existing';
    storage.values.settings = {
      localeSelection: 'system',
      apiKeyStatus: 'valid',
      model: 'gpt-5.6',
      firstPageEnabled: true,
    };
    const set = storage.set.bind(storage);
    storage.set = async (items) => {
      if ('settings' in items) throw new Error('storage_unavailable');
      await set(items);
    };
    const service = new SettingsService(storage, async () => ({ status: 'invalid' }));

    await expect(service.saveAndTestApiKey('sk-project-invalid', 'en-US')).rejects.toThrow(
      'storage_unavailable',
    );

    expect(storage.values.openAiApiKey).toBe('sk-project-existing');
  });

  it('persists an explicit model ID and first-page automation preference', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));

    await service.setModel('gpt-5.6-mini', 'en-US');
    const state = await service.setFirstPageEnabled(false, 'en-US');

    expect(state.model).toBe('gpt-5.6-mini');
    expect(state.firstPageEnabled).toBe(false);
  });

  it('stores a custom OpenAI-compatible base URL and reads it back', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));

    const state = await service.setBaseUrl('https://gateway.example.test/v1', 'en-US');

    expect(state.baseUrl).toBe('https://gateway.example.test/v1');
    expect((await service.getState('en-US')).baseUrl)
      .toBe('https://gateway.example.test/v1');
  });

  it('rejects a base URL the extension must not send a key to', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));

    for (const candidate of ['http://example.com/v1', 'not-a-url', '', `https://a.test/${'x'.repeat(300)}`]) {
      await expect(service.setBaseUrl(candidate, 'en-US')).rejects.toThrow('invalid_base_url');
    }
    expect((await service.getState('en-US')).baseUrl).toBe(DEFAULT_API_BASE_URL);
  });

  it('validates a key against the endpoint that is configured at that moment', async () => {
    const storage = new MemoryStorage();
    const seen: string[] = [];
    const service = new SettingsService(storage, async (_apiKey, baseUrl) => {
      seen.push(baseUrl);
      return { status: 'valid' };
    });

    await service.saveAndTestApiKey('sk-project-valid', 'en-US');
    await service.setBaseUrl('https://gateway.example.test/v1', 'en-US');
    await service.saveAndTestApiKey('sk-project-valid', 'en-US');

    expect(seen).toEqual([DEFAULT_API_BASE_URL, 'https://gateway.example.test/v1']);
  });

  it('discards a validation result whose endpoint changed while it was in flight', async () => {
    const storage = new MemoryStorage();
    let resolveValidation: ((result: ApiKeyValidationResult) => void) | undefined;
    const validation = new Promise<ApiKeyValidationResult>((resolve) => {
      resolveValidation = resolve;
    });
    const service = new SettingsService(storage, async () => validation);

    const saving = service.saveAndTestApiKey('sk-project-valid', 'en-US');
    await Promise.resolve();
    await service.setBaseUrl('https://gateway.example.test/v1', 'en-US');
    resolveValidation?.({ status: 'valid' });
    await saving;

    const state = await service.getState('en-US');
    expect(state.baseUrl).toBe('https://gateway.example.test/v1');
    expect(state.apiKeyStatus).toBe('missing');
    expect(state.organizationEnabled).toBe(false);
  });

  it('persists the grouping granularity and rejects an unknown value', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));

    const state = await service.setGroupingGranularity('broad', 'en-US');

    expect(state.groupingGranularity).toBe('broad');
    expect((await service.getState('en-US')).groupingGranularity).toBe('broad');
    await expect(service.setGroupingGranularity('huge', 'en-US')).rejects.toThrow(
      'invalid_grouping_granularity',
    );
  });

  it('falls back to the default granularity when storage predates the setting', async () => {
    const storage = new MemoryStorage();
    storage.values.settings = {
      localeSelection: 'system', apiKeyStatus: 'missing', model: 'gpt-5.6', firstPageEnabled: true,
    };
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));

    expect((await service.getState('en-US')).groupingGranularity).toBe('balanced');
  });

  it('hands the configured endpoint to the organization runtime', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));
    await service.setBaseUrl('https://gateway.example.test/v1', 'en-US');
    await service.saveAndTestApiKey('sk-project-valid', 'en-US');

    const config = await service.getOrganizationRuntimeConfig('en-US');

    expect(config).toMatchObject({
      apiKey: 'sk-project-valid',
      baseUrl: 'https://gateway.example.test/v1',
      groupingGranularity: 'balanced',
      enabled: true,
    });
  });

  it('forces re-validation when the endpoint the key was checked against changes', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));
    await service.saveAndTestApiKey('sk-project-valid', 'en-US');

    const moved = await service.setBaseUrl('https://gateway.example.test/v1', 'en-US');

    expect(moved.apiKeyStatus).toBe('missing');
    expect(moved.apiKeyConfigured).toBe(true);
    expect(moved.organizationEnabled).toBe(false);
  });

  it('keeps the validation result when the endpoint is saved unchanged', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));
    await service.saveAndTestApiKey('sk-project-valid', 'en-US');

    const resaved = await service.setBaseUrl('https://api.openai.com/v1/', 'en-US');

    expect(resaved.apiKeyStatus).toBe('valid');
    expect(resaved.organizationEnabled).toBe(true);
  });

  it('keeps a stored base URL readable when the rest of the settings predate it', async () => {
    const storage = new MemoryStorage();
    storage.values.settings = {
      localeSelection: 'system', apiKeyStatus: 'missing', model: 'gpt-5.6', firstPageEnabled: true,
    };
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));

    expect((await service.getState('en-US')).baseUrl).toBe(DEFAULT_API_BASE_URL);
  });

  it('carries a single-provider installation over to the provider layout', async () => {
    const storage = new MemoryStorage();
    // What an installation from before providers existed looks like on disk.
    storage.values.openAiApiKey = 'sk-project-existing';
    storage.values.settings = {
      localeSelection: 'ko',
      apiKeyStatus: 'valid',
      model: 'gpt-5.6-mini',
      baseUrl: 'https://gateway.example.test/v1',
      firstPageEnabled: false,
    };
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));

    const state = await service.getState('en-US');

    expect(state).toMatchObject({
      provider: 'openai',
      providerKeys: { openai: true, anthropic: false, google: false },
      apiKeyStatus: 'valid',
      apiKeyConfigured: true,
      organizationEnabled: true,
      model: 'gpt-5.6-mini',
      baseUrl: 'https://gateway.example.test/v1',
      localeSelection: 'ko',
      firstPageEnabled: false,
    });

    // The old copy is only dropped once the key has been written to its provider slot.
    await service.setLocale('ja', 'en-US');
    expect(storage.values.openAiApiKey).toBe('sk-project-existing');
    await service.saveAndTestApiKey('sk-project-existing', 'en-US');
    expect(storage.values.apiKeys).toEqual({ openai: 'sk-project-existing' });
    expect(storage.values.openAiApiKey).toBeUndefined();
  });

  it('keeps every provider key when the active provider changes', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));
    await service.saveAndTestApiKey('sk-openai', 'en-US');
    await service.setProvider('anthropic', 'en-US');
    await service.saveAndTestApiKey('sk-anthropic', 'en-US');

    const state = await service.setProvider('openai', 'en-US');

    expect(state).toMatchObject({
      provider: 'openai',
      providerKeys: { openai: true, anthropic: true, google: false },
      apiKeyConfigured: true,
      organizationEnabled: true,
    });
    expect(storage.values.apiKeys).toEqual({
      openai: 'sk-openai',
      anthropic: 'sk-anthropic',
    });
  });

  it('gives each provider its own model, endpoint, and verdict', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));
    await service.saveAndTestApiKey('sk-openai', 'en-US');
    await service.setModel('gpt-5.6-mini', 'en-US');

    const anthropic = await service.setProvider('anthropic', 'en-US');

    // Defaults, not the OpenAI values, and no verdict carried over to an unverified provider.
    expect(anthropic).toMatchObject({
      model: 'claude-opus-5',
      baseUrl: 'https://api.anthropic.com/v1',
      baseUrlIsDefault: true,
      apiKeyStatus: 'missing',
      apiKeyConfigured: false,
      organizationEnabled: false,
    });

    await expect(service.setProvider('openai', 'en-US')).resolves.toMatchObject({
      model: 'gpt-5.6-mini',
      apiKeyStatus: 'valid',
    });
  });

  it('reports the active provider and its key to the organization runtime', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));
    await service.saveAndTestApiKey('sk-openai', 'en-US');
    await service.setProvider('google', 'en-US');
    await service.saveAndTestApiKey('sk-google', 'en-US');

    await expect(service.getOrganizationRuntimeConfig('en-US')).resolves.toMatchObject({
      provider: 'google',
      apiKey: 'sk-google',
      model: 'gemini-3.5-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      enabled: true,
    });
  });

  it('rejects a provider it cannot route', async () => {
    const storage = new MemoryStorage();
    const service = new SettingsService(storage, async () => ({ status: 'valid' }));

    await expect(service.setProvider('mistral', 'en-US')).rejects.toThrow('invalid_provider');
  });

});

describe('normalizeBaseUrl', () => {
  it('accepts https anywhere, including a private network host', () => {
    expect(normalizeBaseUrl('https://gateway.example.test/v1'))
      .toBe('https://gateway.example.test/v1');
    expect(normalizeBaseUrl('https://10.0.0.5:8443/v1')).toBe('https://10.0.0.5:8443/v1');
  });

  it('accepts plaintext only on the loopback host so a local runtime stays usable', () => {
    expect(normalizeBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
    expect(normalizeBaseUrl('http://example.com/v1')).toBeNull();
  });

  it('trims surrounding space and drops a trailing slash so equality checks hold', () => {
    expect(normalizeBaseUrl('  https://api.example.test/v1/  ')).toBe('https://api.example.test/v1');
    expect(normalizeBaseUrl('https://api.example.test/')).toBe('https://api.example.test');
  });

  it('refuses forms that could disguise or leak the destination', () => {
    // Reads as OpenAI but resolves to evil.example; the rest can smuggle data or hide the target.
    expect(normalizeBaseUrl('https://api.openai.com@evil.example/v1')).toBeNull();
    expect(normalizeBaseUrl('https://user:pw@gw.example.test/v1')).toBeNull();
    expect(normalizeBaseUrl('https://gw.example.test/v1?key=abc')).toBeNull();
    expect(normalizeBaseUrl('https://gw.example.test/v1#fragment')).toBeNull();
  });

  it('refuses an IPv6 loopback that Chrome could never grant', () => {
    // No manifest match pattern covers an IPv6 literal, so accepting it would strand the user.
    expect(normalizeBaseUrl('http://[::1]:11434/v1')).toBeNull();
  });

  it('applies the length cap to the normalized form, not the raw input', () => {
    // Percent-encoding expands non-ASCII, so a short input can normalize past the cap.
    const short = `https://a.test/${'e\u0301'.repeat(40)}`;
    expect(short.length).toBeLessThan(200);
    expect(normalizeBaseUrl(short)).toBeNull();
  });

  it('rejects input that is not a usable endpoint', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl('   ')).toBeNull();
    expect(normalizeBaseUrl('not-a-url')).toBeNull();
    expect(normalizeBaseUrl('ftp://files.example.test/v1')).toBeNull();
    expect(normalizeBaseUrl(`https://a.test/${'x'.repeat(300)}`)).toBeNull();
  });
});
