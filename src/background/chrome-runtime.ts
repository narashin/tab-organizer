import { ChromeActiveTabPlatform, ChromeFirstPagePlatform, ChromeSynchronizationPlatform, registerTabLifecycle } from './chrome-platform';
import { FirstPageOrganizer } from './first-page-organizer';
import {
  createClassifier,
  createTaxonomyPlanner,
  type Classifier,
  type TaxonomyEntry,
  type TaxonomyPlanner,
  type TaxonomyRequest,
} from './classifier';
import { createOrganizationMessageHandler } from './organization-messages';
import { OrganizationService } from './organization-service';
import { PresetStore } from './preset-store';
import type { LocalStorageArea, SettingsService } from './settings-service';
import { SynchronizationService } from './synchronization-service';
import { TabLockStore } from './tab-lock-store';
import type { SupportedLocale } from '../shared/localization';
import { DEFAULT_GROUPING_GRANULARITY, type GroupingGranularity } from '../shared/grouping';

export function createChromeOrganizationHandler(settings: SettingsService) {
  const local = createStorageArea(chrome.storage.local);
  const session = createStorageArea(chrome.storage.session);
  const createId = () => crypto.randomUUID();
  const presets = new PresetStore(local, createId);
  const locks = new TabLockStore(session, Date.now);
  const chromeTabs = new ChromeSynchronizationPlatform();
  const firstPagePlatform = new ChromeFirstPagePlatform(chromeTabs, presets);
  let locale: SupportedLocale = 'en';
  let granularity: GroupingGranularity = DEFAULT_GROUPING_GRANULARITY;
  let sendPathEnabled = false;

  const resolveClassifier = async (): Promise<Classifier> => {
    const config = await settings.getOrganizationRuntimeConfig(chrome.i18n.getUILanguage());
    locale = config.locale;
    granularity = config.groupingGranularity;
    sendPathEnabled = config.sendPathEnabled;
    if (!config.enabled || config.apiKey === null) throw new Error('organization_disabled');
    const classifier = createClassifier(config.provider, {
      apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl,
    });
    return {
      classify: (request) => classifier.classify({ ...request, locale: config.locale }),
    };
  };
  const dynamicClassifier: Classifier = {
    classify: async (request) => (await resolveClassifier()).classify(request),
  };
  const dynamicTaxonomyPlanner: TaxonomyPlanner = {
    plan: async (request: TaxonomyRequest): Promise<TaxonomyEntry[]> => {
      const config = await settings.getOrganizationRuntimeConfig(chrome.i18n.getUILanguage());
      if (!config.enabled || config.apiKey === null) throw new Error('organization_disabled');
      const planner = createTaxonomyPlanner(config.provider, {
        apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl,
      });
      return planner.plan({ ...request, locale: config.locale });
    },
  };
  const firstPage = new FirstPageOrganizer(
    session,
    resolveClassifier,
    presets,
    locks,
    firstPagePlatform,
    () => locale,
  );
  const synchronization = new SynchronizationService(
    dynamicClassifier,
    presets,
    locks,
    chromeTabs,
    () => locale,
    createId,
    session,
    dynamicTaxonomyPlanner,
    () => granularity,
    () => sendPathEnabled,
    async () => (await settings.getOrganizationRuntimeConfig(chrome.i18n.getUILanguage()))
      .sortTabsEnabled,
    chromeTabs,
  );
  const service = new OrganizationService(
    presets,
    locks,
    firstPage,
    synchronization,
    new ChromeActiveTabPlatform(),
  );
  registerTabLifecycle(
    firstPage,
    locks,
    settings,
    () => chrome.i18n.getUILanguage(),
    (nextLocale) => { locale = nextLocale; },
  );
  return createOrganizationMessageHandler(service);
}

function createStorageArea(area: chrome.storage.StorageArea): LocalStorageArea {
  return {
    async get(keys) { return area.get([...keys]); },
    async set(items) { await area.set(items); },
    async remove(keys) { await area.remove([...keys]); },
  };
}
