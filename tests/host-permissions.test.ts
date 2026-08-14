import { describe, expect, it } from 'vitest';

import { toOriginPattern } from '../src/shared/base-url';
import { ensureHostAccess, type PermissionBridge } from '../src/ui/host-permissions';

function createBridge(granted: string[], accept: boolean) {
  const calls = { contains: [] as string[][], request: [] as string[][] };
  const bridge: PermissionBridge = {
    async contains(origins) {
      calls.contains.push(origins);
      return origins.every((origin) => granted.includes(origin));
    },
    async request(origins) {
      calls.request.push(origins);
      if (accept) granted.push(...origins);
      return accept;
    },
  };
  return { bridge, calls };
}

describe('toOriginPattern', () => {
  it('reduces an endpoint to the origin pattern Chrome grants against', () => {
    expect(toOriginPattern('https://gateway.example.test/v1'))
      .toBe('https://gateway.example.test/*');
    expect(toOriginPattern('http://localhost:11434/v1')).toBe('http://localhost:11434/*');
  });

  it('returns null for input that is not a usable endpoint', () => {
    expect(toOriginPattern('not-a-url')).toBeNull();
    expect(toOriginPattern('')).toBeNull();
  });

  it('never grants a host the endpoint validator would refuse to store', () => {
    // Reads as OpenAI, resolves to evil.com. Granting first would leave the access behind.
    expect(toOriginPattern('https://api.openai.com@evil.example/v1')).toBeNull();
    expect(toOriginPattern('https://user@127.0.0.1/v1')).toBeNull();
    expect(toOriginPattern('http://gateway.corp.example/v1')).toBeNull();
    expect(toOriginPattern('https://gw.example.test/v1?key=abc')).toBeNull();
  });
});

describe('ensureHostAccess', () => {
  it('does not prompt when the host is already granted', async () => {
    const { bridge, calls } = createBridge(['https://api.openai.com/*'], false);

    await expect(ensureHostAccess('https://api.openai.com/v1', bridge)).resolves.toBe(true);
    expect(calls.contains).toEqual([['https://api.openai.com/*']]);
    expect(calls.request).toEqual([]);
  });

  it('prompts once for a host that is not granted yet', async () => {
    const { bridge, calls } = createBridge([], true);

    await expect(ensureHostAccess('https://gw.example.test/v1', bridge)).resolves.toBe(true);
    expect(calls.request).toEqual([['https://gw.example.test/*']]);
  });

  it('reports denial so the caller can leave the endpoint unchanged', async () => {
    const { bridge, calls } = createBridge([], false);

    await expect(ensureHostAccess('https://gw.example.test/v1', bridge)).resolves.toBe(false);
    expect(calls.request).toHaveLength(1);
  });

  it('refuses an endpoint it cannot turn into an origin', async () => {
    const { bridge, calls } = createBridge([], true);

    await expect(ensureHostAccess('not-a-url', bridge)).resolves.toBe(false);
    expect(calls.contains).toEqual([]);
    expect(calls.request).toEqual([]);
  });

  it('treats a bridge failure as a denial rather than a grant', async () => {
    const bridge: PermissionBridge = {
      contains: async () => { throw new Error('permissions_unavailable'); },
      request: async () => true,
    };

    await expect(ensureHostAccess('https://gw.example.test/v1', bridge)).resolves.toBe(false);
  });
});
