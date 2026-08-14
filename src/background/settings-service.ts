import type { ApiKeyStatus, ApiKeyValidationResult } from './provider-key';
import type {
  LocaleSelection,
  SupportedLocale,
} from '../shared/localization';
import { resolveLocale } from '../shared/localization';
import { DEFAULT_API_BASE_URL, normalizeBaseUrl } from '../shared/base-url';
import {
  createProviderRecord,
  DEFAULT_PROVIDER,
  isProvider,
  PROVIDER_PROFILES,
  type Provider,
} from '../shared/provider';
import {
  DEFAULT_GROUPING_GRANULARITY,
  isGroupingGranularity,
  type GroupingGranularity,
} from '../shared/grouping';

export { DEFAULT_API_BASE_URL, normalizeBaseUrl } from '../shared/base-url';

export type StoredValues = Record<string, unknown>;

export interface LocalStorageArea {
  get(keys: readonly string[]): Promise<StoredValues>;
  set(items: StoredValues): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

export interface SettingsState {
  localeSelection: LocaleSelection;
  locale: SupportedLocale;
  provider: Provider;
  // Which providers hold a key, so the interface can show what switching would cost.
  providerKeys: Record<Provider, boolean>;
  apiKeyStatus: ApiKeyStatus;
  apiKeyConfigured: boolean;
  organizationEnabled: boolean;
  model: string;
  baseUrl: string;
  // The panel must warn about a custom endpoint without hardcoding the default it compares against.
  baseUrlIsDefault: boolean;
  groupingGranularity: GroupingGranularity;
  sendPathEnabled: boolean;
  firstPageEnabled: boolean;
}

export interface OrganizationRuntimeConfig {
  provider: Provider;
  apiKey: string | null;
  model: string;
  baseUrl: string;
  groupingGranularity: GroupingGranularity;
  sendPathEnabled: boolean;
  firstPageEnabled: boolean;
  locale: SupportedLocale;
  enabled: boolean;
}

export type ApiKeyValidator = (
  apiKey: string,
  baseUrl: string,
  provider: Provider,
) => Promise<ApiKeyValidationResult>;

interface StoredProviderSettings {
  model: string;
  baseUrl: string;
  apiKeyStatus: ApiKeyStatus;
}

interface StoredSettings {
  localeSelection: LocaleSelection;
  provider: Provider;
  providers: Record<Provider, StoredProviderSettings>;
  groupingGranularity: GroupingGranularity;
  sendPathEnabled: boolean;
  firstPageEnabled: boolean;
}

const SETTINGS_KEY = 'settings';
const API_KEYS_STORAGE_KEY = 'apiKeys';
// The single-provider layout this replaced. It is read until the next write so an existing
// installation keeps working, then removed once the key lives in its provider slot.
const LEGACY_API_KEY_STORAGE_KEY = 'openAiApiKey';

const STORAGE_KEYS = [SETTINGS_KEY, API_KEYS_STORAGE_KEY, LEGACY_API_KEY_STORAGE_KEY] as const;

function isLocaleSelection(value: unknown): value is LocaleSelection {
  return value === 'system' || value === 'en' || value === 'ko' || value === 'ja';
}

function isApiKeyStatus(value: unknown): value is ApiKeyStatus {
  return value === 'missing' || value === 'valid' || value === 'invalid' || value === 'error';
}

function createDefaultProviderSettings(provider: Provider): StoredProviderSettings {
  return {
    model: PROVIDER_PROFILES[provider].defaultModel,
    baseUrl: PROVIDER_PROFILES[provider].defaultBaseUrl,
    apiKeyStatus: 'missing',
  };
}

function parseProviderSettings(value: unknown, provider: Provider): StoredProviderSettings {
  const defaults = createDefaultProviderSettings(provider);
  if (typeof value !== 'object' || value === null) return defaults;

  const candidate = value as Record<string, unknown>;
  return {
    model: typeof candidate.model === 'string' && candidate.model.trim().length > 0
      ? candidate.model
      : defaults.model,
    baseUrl: typeof candidate.baseUrl === 'string'
      ? normalizeBaseUrl(candidate.baseUrl) ?? defaults.baseUrl
      : defaults.baseUrl,
    apiKeyStatus: isApiKeyStatus(candidate.apiKeyStatus) ? candidate.apiKeyStatus : 'missing',
  };
}

function parseStoredSettings(value: unknown): StoredSettings {
  const defaults: StoredSettings = {
    localeSelection: 'system',
    provider: DEFAULT_PROVIDER,
    providers: createProviderRecord(createDefaultProviderSettings),
    groupingGranularity: DEFAULT_GROUPING_GRANULARITY,
    sendPathEnabled: false,
    firstPageEnabled: true,
  };
  if (typeof value !== 'object' || value === null) return defaults;

  const candidate = value as Record<string, unknown>;
  const storedProviders = typeof candidate.providers === 'object' && candidate.providers !== null
    ? candidate.providers as Record<string, unknown>
    : undefined;
  // A record written before providers existed carries model, baseUrl, and status at the top level.
  // Those settings were made against OpenAI, so they belong to that provider and nowhere else.
  const legacyOpenAi = storedProviders === undefined ? candidate : undefined;

  return {
    localeSelection: isLocaleSelection(candidate.localeSelection)
      ? candidate.localeSelection
      : defaults.localeSelection,
    provider: isProvider(candidate.provider) ? candidate.provider : defaults.provider,
    providers: createProviderRecord((provider) => parseProviderSettings(
      provider === 'openai' && legacyOpenAi !== undefined
        ? legacyOpenAi
        : storedProviders?.[provider],
      provider,
    )),
    groupingGranularity: isGroupingGranularity(candidate.groupingGranularity)
      ? candidate.groupingGranularity
      : defaults.groupingGranularity,
    sendPathEnabled: candidate.sendPathEnabled === true,
    firstPageEnabled: typeof candidate.firstPageEnabled === 'boolean'
      ? candidate.firstPageEnabled
      : defaults.firstPageEnabled,
  };
}

function parseApiKeys(values: StoredValues): Record<Provider, string> {
  const stored = values[API_KEYS_STORAGE_KEY];
  const record = typeof stored === 'object' && stored !== null
    ? stored as Record<string, unknown>
    : {};
  const legacy = values[LEGACY_API_KEY_STORAGE_KEY];

  return createProviderRecord((provider) => {
    const value = record[provider];
    if (typeof value === 'string' && value.length > 0) return value;
    if (provider === 'openai' && typeof legacy === 'string') return legacy;
    return '';
  });
}

/** Empty slots are dropped so an unused provider leaves nothing behind in storage. */
function serializeApiKeys(keys: Record<Provider, string>): Record<string, string> {
  const stored: Record<string, string> = {};
  for (const [provider, key] of Object.entries(keys)) {
    if (key.length > 0) stored[provider] = key;
  }
  return stored;
}

export class SettingsService {
  private apiKeyOperationRevision = 0;
  private storageMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: LocalStorageArea,
    private readonly validateApiKey: ApiKeyValidator,
  ) {}

  async getState(systemLocale: string): Promise<SettingsState> {
    const values = await this.storage.get(STORAGE_KEYS);
    return this.createState(values, systemLocale);
  }

  async getOrganizationRuntimeConfig(systemLocale: string): Promise<OrganizationRuntimeConfig> {
    const values = await this.storage.get(STORAGE_KEYS);
    const state = this.createState(values, systemLocale);
    const apiKey = parseApiKeys(values)[state.provider];
    return {
      provider: state.provider,
      apiKey: apiKey.length > 0 ? apiKey : null,
      model: state.model,
      baseUrl: state.baseUrl,
      groupingGranularity: state.groupingGranularity,
      sendPathEnabled: state.sendPathEnabled,
      firstPageEnabled: state.firstPageEnabled,
      locale: state.locale,
      enabled: state.organizationEnabled,
    };
  }

  async saveAndTestApiKey(
    apiKey: string,
    systemLocale: string,
  ): Promise<SettingsState> {
    const revision = this.apiKeyOperationRevision += 1;
    const normalizedKey = apiKey.trim();
    const stored = await this.storage.get([SETTINGS_KEY]);
    const settingsBeforeCall = parseStoredSettings(stored[SETTINGS_KEY]);
    const provider = settingsBeforeCall.provider;
    const { baseUrl } = settingsBeforeCall.providers[provider];
    const result = await this.validateApiKey(normalizedKey, baseUrl, provider);

    return this.mutate(async (settings) => {
      if (revision !== this.apiKeyOperationRevision) {
        return this.getState(systemLocale);
      }
      // The endpoint, and now the provider, can move while validation is in flight. A verdict earned
      // against the old target would otherwise overwrite the reset that the move performed.
      const target = settings.providers[provider];
      const status = settings.provider === provider && target.baseUrl === baseUrl
        ? result.status
        : 'missing';
      const nextSettings = this.withProvider(settings, provider, { apiKeyStatus: status });
      const keys = parseApiKeys(await this.storage.get(STORAGE_KEYS));
      // One write for both records: a key stored without its verdict, or a verdict stored against a
      // key that failed to save, would leave organization enabled on an unverified pair.
      await this.storage.set({
        [API_KEYS_STORAGE_KEY]: serializeApiKeys({ ...keys, [provider]: normalizedKey }),
        [SETTINGS_KEY]: nextSettings,
      });
      await this.retireLegacyApiKey();
      return this.getState(systemLocale);
    });
  }

  async setLocale(
    localeSelection: LocaleSelection,
    systemLocale: string,
  ): Promise<SettingsState> {
    return this.mutate(async (settings) => {
      await this.storage.set({
        [SETTINGS_KEY]: { ...settings, localeSelection } satisfies StoredSettings,
      });
      return this.getState(systemLocale);
    });
  }

  async setProvider(provider: string, systemLocale: string): Promise<SettingsState> {
    if (!isProvider(provider)) {
      throw new Error('invalid_provider');
    }
    this.apiKeyOperationRevision += 1;
    return this.mutate(async (settings) => {
      await this.storage.set({
        [SETTINGS_KEY]: { ...settings, provider } satisfies StoredSettings,
      });
      return this.getState(systemLocale);
    });
  }

  async deleteApiKey(systemLocale: string): Promise<SettingsState> {
    this.apiKeyOperationRevision += 1;
    return this.mutate(async (settings) => {
      const provider = settings.provider;
      const keys = parseApiKeys(await this.storage.get(STORAGE_KEYS));
      await this.storage.set({
        [API_KEYS_STORAGE_KEY]: serializeApiKeys({ ...keys, [provider]: '' }),
        [SETTINGS_KEY]: this.withProvider(settings, provider, { apiKeyStatus: 'missing' }),
      });
      await this.retireLegacyApiKey();
      return this.getState(systemLocale);
    });
  }

  async setModel(model: string, systemLocale: string): Promise<SettingsState> {
    const normalized = model.trim();
    if (normalized.length === 0 || normalized.length > 100) {
      throw new Error('invalid_model');
    }
    return this.mutate(async (settings) => {
      await this.storage.set({
        [SETTINGS_KEY]: this.withProvider(settings, settings.provider, { model: normalized }),
      });
      return this.getState(systemLocale);
    });
  }

  async setBaseUrl(baseUrl: string, systemLocale: string): Promise<SettingsState> {
    const normalized = normalizeBaseUrl(baseUrl);
    if (normalized === null) {
      throw new Error('invalid_base_url');
    }
    return this.mutate(async (settings) => {
      const provider = settings.provider;
      const current = settings.providers[provider];
      // A key proven against one endpoint says nothing about another, so moving hosts must not
      // carry the old verdict over and leave organization enabled against an unchecked host.
      const apiKeyStatus = normalized === current.baseUrl ? current.apiKeyStatus : 'missing';
      await this.storage.set({
        [SETTINGS_KEY]: this.withProvider(settings, provider, { baseUrl: normalized, apiKeyStatus }),
      });
      return this.getState(systemLocale);
    });
  }

  async setGroupingGranularity(
    granularity: string,
    systemLocale: string,
  ): Promise<SettingsState> {
    if (!isGroupingGranularity(granularity)) {
      throw new Error('invalid_grouping_granularity');
    }
    return this.mutate(async (settings) => {
      await this.storage.set({
        [SETTINGS_KEY]: { ...settings, groupingGranularity: granularity } satisfies StoredSettings,
      });
      return this.getState(systemLocale);
    });
  }

  async setSendPathEnabled(
    sendPathEnabled: boolean,
    systemLocale: string,
  ): Promise<SettingsState> {
    return this.mutate(async (settings) => {
      await this.storage.set({
        [SETTINGS_KEY]: { ...settings, sendPathEnabled } satisfies StoredSettings,
      });
      return this.getState(systemLocale);
    });
  }

  async setFirstPageEnabled(
    firstPageEnabled: boolean,
    systemLocale: string,
  ): Promise<SettingsState> {
    return this.mutate(async (settings) => {
      await this.storage.set({
        [SETTINGS_KEY]: { ...settings, firstPageEnabled } satisfies StoredSettings,
      });
      return this.getState(systemLocale);
    });
  }

  private withProvider(
    settings: StoredSettings,
    provider: Provider,
    change: Partial<StoredProviderSettings>,
  ): StoredSettings {
    return {
      ...settings,
      providers: {
        ...settings.providers,
        [provider]: { ...settings.providers[provider], ...change },
      },
    } satisfies StoredSettings;
  }

  /**
   * Drops the single-key layout once the same secret lives in its provider slot.
   *
   * This runs after the write that stored it, never before: losing the old copy first would leave
   * an installation with no key at all if the write failed.
   */
  private async retireLegacyApiKey(): Promise<void> {
    await this.storage.remove([LEGACY_API_KEY_STORAGE_KEY]);
  }

  private async mutate<T>(change: (settings: StoredSettings) => Promise<T>): Promise<T> {
    const mutation = this.storageMutation.then(async () => {
      const values = await this.storage.get([SETTINGS_KEY]);
      return change(parseStoredSettings(values[SETTINGS_KEY]));
    });
    this.storageMutation = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  private createState(values: StoredValues, systemLocale: string): SettingsState {
    const settings = parseStoredSettings(values[SETTINGS_KEY]);
    const keys = parseApiKeys(values);
    const provider = settings.provider;
    const active = settings.providers[provider];
    const apiKeyConfigured = keys[provider].length > 0;
    const apiKeyStatus = apiKeyConfigured ? active.apiKeyStatus : 'missing';

    return {
      localeSelection: settings.localeSelection,
      locale: resolveLocale(settings.localeSelection, systemLocale),
      provider,
      providerKeys: createProviderRecord((candidate) => keys[candidate].length > 0),
      apiKeyStatus,
      apiKeyConfigured,
      organizationEnabled: apiKeyConfigured && apiKeyStatus === 'valid',
      model: active.model,
      baseUrl: active.baseUrl,
      baseUrlIsDefault: active.baseUrl === PROVIDER_PROFILES[provider].defaultBaseUrl,
      groupingGranularity: settings.groupingGranularity,
      sendPathEnabled: settings.sendPathEnabled,
      firstPageEnabled: settings.firstPageEnabled,
    };
  }
}
