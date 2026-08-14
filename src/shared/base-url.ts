export const DEFAULT_API_BASE_URL = 'https://api.openai.com/v1';

const MAX_BASE_URL_LENGTH = 200;
// Only hosts that Chrome can actually grant belong here. `[::1]` is omitted because no manifest
// match pattern covers an IPv6 literal, so accepting it would strand the user on a denied prompt.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Returns a canonical base URL, or null when the extension must not send an API key there.
 *
 * Private network hosts stay allowed on purpose: the request runs in the user's own browser, on
 * their own network, against an address they typed themselves, so blocking those ranges would only
 * lock out on-premise gateways without closing an attack path. Plaintext is the real risk, so http
 * is confined to loopback, where a local runtime has no transport to secure.
 */
export function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BASE_URL_LENGTH) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    return null;
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  const normalized = `${parsed.origin}${path}`;
  // Percent-encoding expands non-ASCII, so the cap has to hold on the stored form as well.
  return normalized.length > MAX_BASE_URL_LENGTH ? null : normalized;
}

/**
 * Reduces an endpoint to the origin match pattern Chrome grants host access against.
 *
 * This runs on the normalized value so the extension can never hold access to a host it then
 * refuses to store. `https://api.openai.com@evil.com/v1` reads as OpenAI but resolves to
 * `evil.com`, and granting that before rejecting the URL would leave the grant behind for good.
 */
export function toOriginPattern(baseUrl: string): string | null {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized === null) {
    return null;
  }
  return `${new URL(normalized).origin}/*`;
}
