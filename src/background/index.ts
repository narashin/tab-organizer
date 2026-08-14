import type { BackgroundPlatform } from './initialize';
import { initializeBackground } from './initialize';
import { createChromeOrganizationHandler } from './chrome-runtime';

const platform: BackgroundPlatform = {
  storage: {
    async get(keys) {
      return chrome.storage.local.get([...keys]);
    },
    async set(items) {
      await chrome.storage.local.set(items);
    },
    async remove(keys) {
      await chrome.storage.local.remove([...keys]);
    },
  },
  async restrictLocalStorageAccess() {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  },
  async configureSidePanel(openPanelOnActionClick) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick });
  },
  registerMessageHandler(handler) {
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      void handler(message).then(sendResponse);
      return true;
    });
  },
};

void initializeBackground(platform, fetch, createChromeOrganizationHandler).catch(() => {
  console.error('background_initialization_failed');
});
