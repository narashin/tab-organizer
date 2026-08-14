import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createChromePermissionBridge } from './host-permissions';
import { RuntimeSettingsClient } from './settings-client';
import { App } from './App';
import { RuntimeOrganizationClient } from './organization-client';
import { createLocalPopupWidthStore } from './popup-size';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('popup_root_missing');
}

const settingsClient = new RuntimeSettingsClient(
  async (request) => chrome.runtime.sendMessage(request),
  () => navigator.language,
);
const organizationClient = new RuntimeOrganizationClient(
  async (request) => chrome.runtime.sendMessage(request),
);

// Chrome only accepts this call while the user gesture that opened the popup is still active, so it
// runs here instead of being forwarded to the service worker. The popup closes once the panel opens.
const openSidePanel = async () => {
  const currentWindow = await chrome.windows.getCurrent();
  if (currentWindow.id === undefined) throw new Error('window_id_missing');
  await chrome.sidePanel.open({ windowId: currentWindow.id });
  window.close();
};

createRoot(rootElement).render(
  <StrictMode>
    <App
      shell="popup"
      settingsClient={settingsClient}
      organizationClient={organizationClient}
      permissionBridge={createChromePermissionBridge()}
      openSidePanel={openSidePanel}
      popupWidthStore={createLocalPopupWidthStore(window.localStorage)}
    />
  </StrictMode>,
);
