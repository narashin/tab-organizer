import { describe, expect, it } from 'vitest';

import { redactForLog } from '../src/shared/safe-logger';

describe('redactForLog', () => {
  it('removes explicit secrets and authorization values from nested log data', () => {
    const secret = 'sk-project-sensitive';
    const input = {
      message: `Connection failed for ${secret}`,
      request: {
        headers: {
          Authorization: `Bearer ${secret}`,
        },
        apiKey: secret,
      },
      safeCode: 'openai_connection_failed',
    };

    const redacted = redactForLog(input, [secret]);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Bearer ');
    expect(serialized).toContain('openai_connection_failed');
    expect(serialized).toContain('[REDACTED]');
  });
});
