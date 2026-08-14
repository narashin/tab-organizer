import { DEFAULT_PROVIDER, type Provider } from '../shared/provider';

export type ApiKeyStatus = 'missing' | 'valid' | 'invalid' | 'error';

export interface ApiKeyValidationResult {
  status: ApiKeyStatus;
}

// Anthropic pins its wire format to a dated version and rejects a request that omits it.
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Every supported provider authenticates a plain model listing, so the verdict rules stay shared
 * and only the credential header differs. Listing models also proves the key without spending
 * tokens or naming a model the account may not have.
 */
function authorizationHeaders(provider: Provider, apiKey: string): Record<string, string> {
  switch (provider) {
    case 'anthropic':
      return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
    case 'google':
      return { 'x-goog-api-key': apiKey };
    case 'openai':
      return { Authorization: `Bearer ${apiKey}` };
  }
}

export async function validateProviderKey(
  apiKey: string,
  baseUrl: string,
  provider: Provider = DEFAULT_PROVIDER,
  fetcher: typeof fetch = fetch,
  requestTimeoutMs = 15_000,
): Promise<ApiKeyValidationResult> {
  const normalizedKey = apiKey.trim();
  if (normalizedKey.length === 0) {
    return { status: 'missing' };
  }

  try {
    const response = await withTimeout((signal) => fetcher(
      `${baseUrl}/models`,
      {
        method: 'GET',
        headers: authorizationHeaders(provider, normalizedKey),
        signal,
      },
    ), requestTimeoutMs);

    if (response.ok) {
      return { status: 'valid' };
    }

    if (response.status === 401 || response.status === 403) {
      return { status: 'invalid' };
    }

    // Measured 2026-08-14: Google answers a rejected key with 400 INVALID_ARGUMENT, not 401, so the
    // status alone cannot separate a bad key from a bad request. Reporting it as a connection error
    // would tell the user to check their network when the key is what needs fixing.
    if (provider === 'google' && response.status === 400 && await isRejectedGoogleKey(response)) {
      return { status: 'invalid' };
    }

    return { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}

/**
 * Reads Google's machine-readable reason instead of matching the human message.
 *
 * The body is inspected only for that reason code and is never logged or returned; a request that
 * failed for another reason stays a connection error.
 */
async function isRejectedGoogleKey(response: Response): Promise<boolean> {
  try {
    const body: unknown = JSON.parse(await response.text());
    if (typeof body !== 'object' || body === null) return false;
    const error = (body as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) return false;
    const details = (error as { details?: unknown }).details;
    if (!Array.isArray(details)) return false;
    return details.some((detail) => typeof detail === 'object' && detail !== null &&
      (detail as { reason?: unknown }).reason === 'API_KEY_INVALID');
  } catch {
    return false;
  }
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('api_key_validation_timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
