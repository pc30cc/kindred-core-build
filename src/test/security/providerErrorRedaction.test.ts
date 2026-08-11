/**
 * P1 — credential redaction must apply everywhere provider/network errors are
 * persisted, returned or logged.
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../../server/lib/redactSecrets.js';
import { redactErrorMessage } from '../../../server/services/ai-agent/logs.js';

describe('redactSecrets', () => {
  const cases: [string, string][] = [
    ['Incorrect API key provided: sk-proj-ABCDEF1234567890xyz', 'sk-proj-ABCDEF1234567890xyz'],
    ['bad key rk-live-9876543210abcdef', 'rk-live-9876543210abcdef'],
    ['using pk-test-abcdef123456789', 'pk-test-abcdef123456789'],
    ['request denied for key AIzaSyA1B2C3D4E5F6G7H8', 'AIzaSyA1B2C3D4E5F6G7H8'],
    ['header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc', 'eyJhbGciOiJIUzI1NiJ9.abc'],
    ['x-api-key: super-secret-value', 'super-secret-value'],
    ['api_key=aaaabbbbccccdddd failed', 'aaaabbbbccccdddd'],
    ['GET https://api.test/v1?key=SECRETVALUE123&x=1', 'SECRETVALUE123'],
    ['https://api.test/v1?access_token=TOKEN123456', 'TOKEN123456'],
    ['client_secret: "hunter2hunter2"', 'hunter2hunter2'],
    ['password=correcthorsebattery', 'correcthorsebattery'],
  ];

  for (const [input, secret] of cases) {
    it(`redacts: ${input.slice(0, 40)}…`, () => {
      const out = redactSecrets(input) || '';
      expect(out).not.toContain(secret);
      expect(out).toContain('[redacted]');
    });
  }

  it('does not over-redact harmless diagnostics', () => {
    const msgs = [
      'OpenAI error: model gpt-4o-mini not found',
      'AI network error after 2 attempt(s): fetch failed ECONNRESET',
      'Rate limit reached for requests, please retry in 20s',
      'Anthropic error: overloaded_error',
    ];
    for (const m of msgs) expect(redactSecrets(m)).toBe(m);
  });

  it('handles null/undefined', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeNull();
  });

  it('run-log redaction reuses the shared redactor', () => {
    expect(redactErrorMessage('boom sk-live-ABCDEFGH123456')).not.toContain('sk-live-ABCDEFGH123456');
  });
});
