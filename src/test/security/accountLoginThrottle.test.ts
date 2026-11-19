// @vitest-environment node
/**
 * Password guessing spread over many addresses. The (address, email) tracker
 * locks one address; the per-account counter (middleware/security.ts,
 * ACCOUNT_LOCK_AFTER) stops the account being guessed from everywhere else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ from: () => ({ insert: async () => ({}) }) }),
}));

const sec = await import('../../../server/middleware/security.js');

const reqFrom = (ip: string) => ({ ip, headers: {} }) as unknown as Request;
const EMAIL = 'owner@example.com';

beforeEach(() => {
  sec.__resetAccountLoginFailuresForTests();
});

describe('per-account login failures', () => {
  it('locks the account once it has failed ACCOUNT_LOCK_AFTER times from different addresses', async () => {
    for (let i = 0; i < sec.ACCOUNT_LOCK_AFTER; i++) {
      const req = reqFrom(`185.23.${Math.floor(i / 200)}.${(i % 200) + 1}`);
      const verdict = await sec.checkBruteForce(req, EMAIL);
      // No single address ever reaches its own lock.
      expect(verdict.blocked).toBe(false);
      expect(verdict.accountLocked).toBe(false);
      sec.recordLoginAttempt(req, EMAIL, false);
    }
    const fresh = await sec.checkBruteForce(reqFrom('203.0.114.9'), EMAIL);
    expect(fresh.blocked).toBe(false);
    expect(fresh.accountLocked).toBe(true);
    expect(fresh.accountRetryAfter).toBeGreaterThan(0);
    // Another account is not affected.
    expect((await sec.checkBruteForce(reqFrom('203.0.114.9'), 'other@example.com')).accountLocked).toBe(false);
  });

  it('counts the address case-insensitively and forgets it after a successful login', async () => {
    for (let i = 0; i < sec.ACCOUNT_LOCK_AFTER - 1; i++) sec.recordLoginAttempt(reqFrom(`185.24.0.${i + 1}`), i % 2 ? EMAIL : EMAIL.toUpperCase(), false);
    expect(sec.accountLoginFailures(EMAIL).count).toBe(sec.ACCOUNT_LOCK_AFTER - 1);
    sec.recordLoginAttempt(reqFrom('185.24.1.1'), EMAIL, true);
    expect(sec.accountLoginFailures(EMAIL).count).toBe(0);
  });
});
