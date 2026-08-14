const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set([
  'authorization',
  'apikey',
  'api_key',
  'token',
  'secret',
]);

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value.replace(/Bearer\s+[^\s"']+/gi, REDACTED);
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.replaceAll(secret, REDACTED);
    }
  }
  return redacted;
}

export function redactForLog(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return redactString(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, secrets));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, secrets),
    };
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redactForLog(item, secrets),
      ]),
    );
  }

  return value;
}
