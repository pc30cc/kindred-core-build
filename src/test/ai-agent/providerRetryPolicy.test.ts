/**
 * P1 — bounded, validated timeout/retry policy for realtime chat.
 */
import { describe, it, expect } from 'vitest';
import {
  readBoundedEnvInt,
  isRetryableStatus,
  parseRetryAfterMs,
} from '../../../server/services/ai/index.js';

describe('env validation', () => {
  const env = (v: any) => ({ AI_X: v } as any);
  it('uses the default when unset or empty', () => {
    expect(readBoundedEnvInt('AI_X', 12000, 1000, 60000, {} as any)).toBe(12000);
    expect(readBoundedEnvInt('AI_X', 12000, 1000, 60000, env(''))).toBe(12000);
  });
  it('rejects non-numeric values', () => {
    expect(readBoundedEnvInt('AI_X', 12000, 1000, 60000, env('abc'))).toBe(12000);
  });
  it('rejects negative and zero values', () => {
    expect(readBoundedEnvInt('AI_X', 2, 1, 5, env('-5'))).toBe(2);
    expect(readBoundedEnvInt('AI_X', 28000, 1000, 120000, env('0'))).toBe(28000);
  });
  it('rejects out-of-range values instead of allowing unbounded behaviour', () => {
    expect(readBoundedEnvInt('AI_X', 28000, 1000, 120000, env('9999999'))).toBe(28000);
  });
  it('accepts a valid override', () => {
    expect(readBoundedEnvInt('AI_X', 12000, 1000, 60000, env('15000'))).toBe(15000);
  });
});

describe('status retry policy', () => {
  it('never retries 400/401/403/404', () => {
    for (const s of [400, 401, 403, 404]) expect(isRetryableStatus(s)).toBe(false);
  });
  it('retries 408 and 429', () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });
  it('retries 5xx gateway/server errors', () => {
    for (const s of [500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
  });
  it('does not retry other statuses', () => {
    for (const s of [200, 302, 402, 418, 501]) expect(isRetryableStatus(s)).toBe(false);
  });
});

describe('Retry-After handling', () => {
  it('honours a short numeric delay', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
  });
  it('ignores absent or absurd delays', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('600')).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });
  it('handles an HTTP-date within budget', () => {
    const when = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfterMs(when);
    expect(ms).toBeGreaterThan(0);
    expect(ms!).toBeLessThanOrEqual(15000);
  });
});

describe('runtime defaults', () => {
  it('keeps the realtime wall-clock budget bounded', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('runtime/ai/providers/executor.ts', 'utf8'));
    expect(src).toContain("readBoundedEnvInt('AI_HTTP_TIMEOUT_MS', 12000, 1000, 60000)");
    expect(src).toContain("readBoundedEnvInt('AI_RETRY_ATTEMPTS', 2, 1, 5)");
    expect(src).toContain("readBoundedEnvInt('AI_TOTAL_BUDGET_MS', 28000, 1000, 120000)");
  });
});
