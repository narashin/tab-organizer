import { createSettingsMessageHandler } from './settings-messages';
import type { LocalStorageArea } from './settings-service';
import { SettingsService } from './settings-service';
import { validateProviderKey } from './provider-key';

export interface BackgroundPlatform {
  storage: LocalStorageArea;
  restrictLocalStorageAccess(): Promise<void>;
  configureSidePanel(openOnActionClick: boolean): Promise<void>;
  registerMessageHandler(handler: (message: unknown) => Promise<unknown>): void;
}

export type OrganizationHandlerFactory = (
  settingsService: SettingsService,
) => (message: unknown) => Promise<unknown>;

export async function initializeBackground(
  platform: BackgroundPlatform,
  fetcher: typeof fetch = fetch,
  createOrganizationHandler?: OrganizationHandlerFactory,
): Promise<void> {
  await Promise.all([
    platform.restrictLocalStorageAccess(),
    // The action opens the popup, which is declared in the manifest and always wins over this
    // behavior. Leaving it on would declare two conflicting responses to the same click.
    platform.configureSidePanel(false),
  ]);

  const settingsService = new SettingsService(platform.storage, (apiKey, baseUrl, provider) =>
    validateProviderKey(apiKey, baseUrl, provider, fetcher),
  );
  const settingsHandler = createSettingsMessageHandler(settingsService);
  const organizationHandler = createOrganizationHandler?.(settingsService);
  platform.registerMessageHandler(async (message) => {
    if (isSettingsMessage(message)) return settingsHandler(message);
    if (organizationHandler !== undefined) return organizationHandler(message);
    return settingsHandler(message);
  });
}

function isSettingsMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    typeof (value as Record<string, unknown>).type === 'string' &&
    String((value as Record<string, unknown>).type).startsWith('settings/');
}
