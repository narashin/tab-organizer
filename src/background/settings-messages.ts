import type { SettingsState } from './settings-service';
import type { SettingsService } from './settings-service';
import type { LocaleSelection } from '../shared/localization';

export interface SettingsSuccessResponse {
  ok: true;
  state: SettingsState;
}

export interface SettingsErrorResponse {
  ok: false;
  error: 'invalid_request' | 'operation_failed';
}

export type BackgroundResponse = SettingsSuccessResponse | SettingsErrorResponse;

export type BackgroundRequest =
  | { type: 'settings/get'; systemLocale: string }
  | {
      type: 'settings/set-locale';
      localeSelection: LocaleSelection;
      systemLocale: string;
    }
  | { type: 'settings/save-and-test-key'; apiKey: string; systemLocale: string }
  | { type: 'settings/delete-key'; systemLocale: string }
  | { type: 'settings/set-provider'; provider: string; systemLocale: string }
  | { type: 'settings/set-model'; model: string; systemLocale: string }
  | { type: 'settings/set-base-url'; baseUrl: string; systemLocale: string }
  | { type: 'settings/set-grouping'; granularity: string; systemLocale: string }
  | { type: 'settings/set-send-path'; enabled: boolean; systemLocale: string }
  | { type: 'settings/set-first-page'; enabled: boolean; systemLocale: string };

export type SettingsMessageHandler = (message: unknown) => Promise<BackgroundResponse>;

export function createSettingsMessageHandler(
  settingsService: SettingsService,
): SettingsMessageHandler {
  return async (message) => {
    if (!isBackgroundRequest(message)) {
      return { ok: false, error: 'invalid_request' };
    }

    try {
      const state = await handleRequest(settingsService, message);
      return { ok: true, state };
    } catch {
      return { ok: false, error: 'operation_failed' };
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLocaleSelection(value: unknown): value is LocaleSelection {
  return value === 'system' || value === 'en' || value === 'ko' || value === 'ja';
}

function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    typeof value.systemLocale !== 'string'
  ) {
    return false;
  }

  if (value.type === 'settings/get' || value.type === 'settings/delete-key') {
    return true;
  }

  if (value.type === 'settings/set-locale') {
    return isLocaleSelection(value.localeSelection);
  }

  if (value.type === 'settings/set-provider') {
    return typeof value.provider === 'string';
  }

  if (value.type === 'settings/set-model') {
    return typeof value.model === 'string';
  }

  if (value.type === 'settings/set-base-url') {
    return typeof value.baseUrl === 'string';
  }

  if (value.type === 'settings/set-grouping') {
    return typeof value.granularity === 'string';
  }

  if (value.type === 'settings/set-send-path') {
    return typeof value.enabled === 'boolean';
  }

  if (value.type === 'settings/set-first-page') {
    return typeof value.enabled === 'boolean';
  }

  return value.type === 'settings/save-and-test-key' && typeof value.apiKey === 'string';
}

async function handleRequest(
  settingsService: SettingsService,
  request: BackgroundRequest,
): Promise<SettingsState> {
  switch (request.type) {
    case 'settings/get':
      return settingsService.getState(request.systemLocale);
    case 'settings/set-locale':
      return settingsService.setLocale(request.localeSelection, request.systemLocale);
    case 'settings/save-and-test-key':
      return settingsService.saveAndTestApiKey(request.apiKey, request.systemLocale);
    case 'settings/delete-key':
      return settingsService.deleteApiKey(request.systemLocale);
    case 'settings/set-provider':
      return settingsService.setProvider(request.provider, request.systemLocale);
    case 'settings/set-model':
      return settingsService.setModel(request.model, request.systemLocale);
    case 'settings/set-base-url':
      return settingsService.setBaseUrl(request.baseUrl, request.systemLocale);
    case 'settings/set-grouping':
      return settingsService.setGroupingGranularity(request.granularity, request.systemLocale);
    case 'settings/set-send-path':
      return settingsService.setSendPathEnabled(request.enabled, request.systemLocale);
    case 'settings/set-first-page':
      return settingsService.setFirstPageEnabled(request.enabled, request.systemLocale);
  }
}
