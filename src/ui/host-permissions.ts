import { toOriginPattern } from '../shared/base-url';

export interface PermissionBridge {
  contains(origins: string[]): Promise<boolean>;
  request(origins: string[]): Promise<boolean>;
}

/**
 * Confirms the panel may reach an endpoint, prompting the user only when it is not granted yet.
 *
 * `chrome.permissions.request` needs a user gesture, so this runs in the panel rather than the
 * service worker. The default endpoint is already covered by the manifest, so `contains` answers
 * for it and no dialog appears. Anything that goes wrong counts as denied: granting host access on
 * a failed check would send the key somewhere the user never approved.
 */
export async function ensureHostAccess(
  baseUrl: string,
  bridge: PermissionBridge,
): Promise<boolean> {
  const origin = toOriginPattern(baseUrl);
  if (origin === null) {
    return false;
  }
  try {
    if (await bridge.contains([origin])) {
      return true;
    }
    return await bridge.request([origin]);
  } catch {
    return false;
  }
}

export function createChromePermissionBridge(): PermissionBridge {
  return {
    contains: (origins) => chrome.permissions.contains({ origins }),
    request: (origins) => chrome.permissions.request({ origins }),
  };
}
