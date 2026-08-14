import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createChromePermissionBridge } from './host-permissions';
import { RuntimeSettingsClient } from './settings-client';
import { App } from './App';
import { RuntimeOrganizationClient } from './organization-client';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('sidepanel_root_missing');
}

const settingsClient = new RuntimeSettingsClient(
  async (request) => chrome.runtime.sendMessage(request),
  () => navigator.language,
);
const organizationClient = new RuntimeOrganizationClient(
  async (request) => chrome.runtime.sendMessage(request),
);
createRoot(rootElement).render(
  <StrictMode>
    <App
      settingsClient={settingsClient}
      organizationClient={organizationClient}
      permissionBridge={createChromePermissionBridge()}
    />
  </StrictMode>,
);
