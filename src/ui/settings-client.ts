import type { SettingsState } from '../background/settings-service';
import { isGroupingGranularity, type GroupingGranularity } from '../shared/grouping';
import type { LocaleSelection } from '../shared/localization';
import type { Provider } from '../shared/provider';
import type {
  BackgroundRequest,
} from '../background/settings-messages';

export interface SettingsClient {
  getState(): Promise<SettingsState>;
  setLocale(localeSelection: LocaleSelection): Promise<SettingsState>;
  saveAndTestApiKey(apiKey: string): Promise<SettingsState>;
  deleteApiKey(): Promise<SettingsState>;
  setProvider(provider: Provider): Promise<SettingsState>;
  setModel(model: string): Promise<SettingsState>;
  setBaseUrl(baseUrl: string): Promise<SettingsState>;
  setGroupingGranularity(granularity: GroupingGranularity): Promise<SettingsState>;
  setSendPathEnabled(enabled: boolean): Promise<SettingsState>;
  setSortTabsEnabled(enabled: boolean): Promise<SettingsState>;
  setFirstPageEnabled(enabled: boolean): Promise<SettingsState>;
}

export type RuntimeMessenger = (request: BackgroundRequest) => Promise<unknown>;
export type SystemLocaleReader = () => string;

export class RuntimeSettingsClient implements SettingsClient {
  constructor(
    private readonly sendMessage: RuntimeMessenger,
    private readonly readSystemLocale: SystemLocaleReader,
  ) {}

  async getState(): Promise<SettingsState> {
    return this.request({
      type: 'settings/get',
      systemLocale: this.readSystemLocale(),
    });
  }

  async setLocale(localeSelection: LocaleSelection): Promise<SettingsState> {
    return this.request({
      type: 'settings/set-locale',
      localeSelection,
      systemLocale: this.readSystemLocale(),
    });
  }

  async saveAndTestApiKey(apiKey: string): Promise<SettingsState> {
    return this.request({
      type: 'settings/save-and-test-key',
      apiKey,
      systemLocale: this.readSystemLocale(),
    });
  }

  async deleteApiKey(): Promise<SettingsState> {
    return this.request({
      type: 'settings/delete-key',
      systemLocale: this.readSystemLocale(),
    });
  }

  async setProvider(provider: Provider): Promise<SettingsState> {
    return this.request({
      type: 'settings/set-provider',
      provider,
      systemLocale: this.readSystemLocale(),
    });
  }

  async setModel(model: string): Promise<SettingsState> {
    return this.request({
      type: 'settings/set-model',
      model,
      systemLocale: this.readSystemLocale(),
    });
  }

  async setBaseUrl(baseUrl: string): Promise<SettingsState> {
    return this.request({
      type: 'settings/set-base-url',
      baseUrl,
      systemLocale: this.readSystemLocale(),
    });
  }

  async setGroupingGranularity(granularity: GroupingGranularity): Promise<SettingsState> {
    return this.request({
      type: 'settings/set-grouping',
      granularity,
      systemLocale: this.readSystemLocale(),
    });
  }

  async setSendPathEnabled(enabled: boolean): Promise<SettingsState> {
    return this.request({
      type: 'settings/set-send-path',
      enabled,
      systemLocale: this.readSystemLocale(),
    });
  }

  async setSortTabsEnabled(enabled: boolean): Promise<SettingsState> {
    return this.request({
      type: 'settings/set-sort-tabs',
      enabled,
      systemLocale: this.readSystemLocale(),
    });
  }

  async setFirstPageEnabled(enabled: boolean): Promise<SettingsState> {
    return this.request({
      type: 'settings/set-first-page',
      enabled,
      systemLocale: this.readSystemLocale(),
    });
  }

  private async request(message: BackgroundRequest): Promise<SettingsState> {
    const response = await this.sendMessage(message);
    if (!isSettingsSuccessResponse(response)) {
      throw new Error('settings_request_failed');
    }
    return response.state;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSettingsState(value: unknown): value is SettingsState {
  if (!isRecord(value)) {
    return false;
  }

  const localeSelection = value.localeSelection;
  const locale = value.locale;
  const apiKeyStatus = value.apiKeyStatus;

  return (
    (localeSelection === 'system' ||
      localeSelection === 'en' ||
      localeSelection === 'ko' ||
      localeSelection === 'ja') &&
    (locale === 'en' || locale === 'ko' || locale === 'ja') &&
    (apiKeyStatus === 'missing' ||
      apiKeyStatus === 'valid' ||
      apiKeyStatus === 'invalid' ||
      apiKeyStatus === 'error') &&
    typeof value.apiKeyConfigured === 'boolean' &&
    typeof value.organizationEnabled === 'boolean' &&
    typeof value.model === 'string' &&
    typeof value.baseUrl === 'string' &&
    typeof value.baseUrlIsDefault === 'boolean' &&
    isGroupingGranularity(value.groupingGranularity) &&
    typeof value.sendPathEnabled === 'boolean' &&
    typeof value.sortTabsEnabled === 'boolean' &&
    typeof value.firstPageEnabled === 'boolean'
  );
}

function isSettingsSuccessResponse(
  value: unknown,
): value is { ok: true; state: SettingsState } {
  return isRecord(value) && value.ok === true && isSettingsState(value.state);
}
