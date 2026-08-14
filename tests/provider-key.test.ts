import { describe, expect, it } from 'vitest';

import { ANTHROPIC_VERSION, validateProviderKey } from '../src/background/provider-key';
import { PROVIDER_PROFILES, PROVIDERS } from '../src/shared/provider';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

describe('validateProviderKey', () => {
  it('reports a missing key without making a request', async () => {
    let requestCount = 0;
    const fetcher: typeof fetch = async () => {
      requestCount += 1;
      return new Response(null, { status: 200 });
    };

    const result = await validateProviderKey('   ', DEFAULT_BASE_URL, 'openai', fetcher);

    expect(result).toEqual({ status: 'missing' });
    expect(requestCount).toBe(0);
  });

  it('validates against the configured endpoint rather than a fixed one', async () => {
    let receivedUrl = '';
    const fetcher: typeof fetch = async (input) => {
      receivedUrl = input.toString();
      return new Response('{"data":[]}', { status: 200 });
    };

    const result = await validateProviderKey(
      'sk-project-example', 'https://gateway.example.test/v1', 'openai', fetcher,
    );

    expect(result).toEqual({ status: 'valid' });
    expect(receivedUrl).toBe('https://gateway.example.test/v1/models');
  });

  it('reports a valid key after an authenticated models request succeeds', async () => {
    let receivedUrl = '';
    let receivedAuthorization = '';
    let receivedMethod = '';
    const fetcher: typeof fetch = async (input, init) => {
      receivedUrl = input.toString();
      receivedAuthorization = new Headers(init?.headers).get('Authorization') ?? '';
      receivedMethod = init?.method ?? '';
      return new Response('{"data":[]}', { status: 200 });
    };

    const result = await validateProviderKey('sk-project-example', DEFAULT_BASE_URL, 'openai', fetcher);

    expect(result).toEqual({ status: 'valid' });
    expect(receivedUrl).toBe('https://api.openai.com/v1/models');
    expect(receivedAuthorization).toBe('Bearer sk-project-example');
    expect(receivedMethod).toBe('GET');
  });

  it('authenticates each provider the way that provider expects', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({
        url: input.toString(),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return new Response('{"data":[]}', { status: 200 });
    };

    for (const provider of PROVIDERS) {
      await expect(validateProviderKey(
        'key-example',
        PROVIDER_PROFILES[provider].defaultBaseUrl,
        provider,
        fetcher,
      )).resolves.toEqual({ status: 'valid' });
    }

    expect(requests).toEqual([
      {
        url: 'https://api.openai.com/v1/models',
        headers: { authorization: 'Bearer key-example' },
      },
      {
        url: 'https://api.anthropic.com/v1/models',
        // Anthropic rejects a request that does not pin the wire format version.
        headers: { 'x-api-key': 'key-example', 'anthropic-version': ANTHROPIC_VERSION },
      },
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        headers: { 'x-goog-api-key': 'key-example' },
      },
    ]);
    // A key must never ride along in the query string, where proxies and logs would capture it.
    expect(requests.every((request) => !request.url.includes('key-example'))).toBe(true);
  });

  it('reads a rejected Google key out of its 400 response', async () => {
    // Measured against the live endpoint on 2026-08-14: a bad key is 400 INVALID_ARGUMENT.
    const rejected = JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
        ],
      },
    });
    const googleBaseUrl = PROVIDER_PROFILES.google.defaultBaseUrl;

    await expect(validateProviderKey(
      'key-example', googleBaseUrl, 'google', async () => new Response(rejected, { status: 400 }),
    )).resolves.toEqual({ status: 'invalid' });

    // A 400 raised by anything else is still a failed request, not a verdict on the key.
    const malformed = JSON.stringify({
      error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'FIELD_VIOLATION' }] },
    });
    await expect(validateProviderKey(
      'key-example', googleBaseUrl, 'google', async () => new Response(malformed, { status: 400 }),
    )).resolves.toEqual({ status: 'error' });

    // The same status from a provider that uses 401 for this must not be reinterpreted.
    await expect(validateProviderKey(
      'key-example', DEFAULT_BASE_URL, 'openai', async () => new Response(rejected, { status: 400 }),
    )).resolves.toEqual({ status: 'error' });
  });

  it.each([401, 403])('reports HTTP %s as an invalid key', async (status) => {
    const fetcher: typeof fetch = async () => new Response(null, { status });

    await expect(validateProviderKey('sk-project-example', DEFAULT_BASE_URL, 'openai', fetcher)).resolves.toEqual({
      status: 'invalid',
    });
  });

  it('reports rate limits and network failures without exposing error details', async () => {
    const rateLimitedFetcher: typeof fetch = async () =>
      new Response('sk-project-example', { status: 429 });
    const offlineFetcher: typeof fetch = async () => {
      throw new Error('request failed with sk-project-example');
    };

    await expect(
      validateProviderKey('sk-project-example', DEFAULT_BASE_URL, 'openai', rateLimitedFetcher),
    ).resolves.toEqual({ status: 'error' });
    await expect(validateProviderKey('sk-project-example', DEFAULT_BASE_URL, 'openai', offlineFetcher)).resolves.toEqual({
      status: 'error',
    });
  });

  it('ends a key validation request after the configured timeout', async () => {
    const fetcher: typeof fetch = async () => new Promise<Response>(() => undefined);

    await expect(validateProviderKey('sk-project-example', DEFAULT_BASE_URL, 'openai', fetcher, 1)).resolves.toEqual({
      status: 'error',
    });
  });
});
