/**
 * WORKSPACE INVITATIONS v5.1 — B.2/B.3 fingerprint proofs.
 *
 * The fingerprint must be a KEYED, domain-separated HMAC over the full intent:
 * knowing the canonical input must not be enough to reproduce the digest, and
 * rotating the server secret must change every digest.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';

const MOD = '../../server/services/invitations/idempotency.js';

async function withSecret<T>(secret: string, fn: (m: any) => Promise<T> | T): Promise<T> {
  process.env.INVITATION_LINK_SECRET = secret;
  const mod = await import(MOD);
  mod.resetDerivedKeyCache();
  return fn(mod);
}

describe('invitation idempotency fingerprints', () => {
  beforeEach(() => {
    process.env.INVITATION_LINK_SECRET = 'unit-test-secret-a';
  });

  it('is stable for identical intent under the same key', async () => {
    const input = { workspaceId: 'w1', email: 'a@b.test', expiresInDays: 7 };
    const a = await withSecret('unit-test-secret-a', (m) => m.deriveFingerprint('create', input));
    const b = await withSecret('unit-test-secret-a', (m) => m.deriveFingerprint('create', input));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when ANY intent field changes', async () => {
    const base = { workspaceId: 'w1', email: 'a@b.test', expiresInDays: 7, departments: ['d1', 'd2'] };
    const a = await withSecret('unit-test-secret-a', (m) => m.deriveFingerprint('create', base));
    for (const variant of [
      { ...base, expiresInDays: 14 },
      { ...base, email: 'other@b.test' },
      { ...base, departments: ['d2', 'd3'] },
    ]) {
      const d = await withSecret('unit-test-secret-a', (m) => m.deriveFingerprint('create', variant));
      expect(d).not.toBe(a);
    }
    // Operation is domain-separated too.
    const edit = await withSecret('unit-test-secret-a', (m) => m.deriveFingerprint('edit', base));
    expect(edit).not.toBe(a);
  });

  it('changes when the HMAC key changes (B.2: keyed, not a bare hash)', async () => {
    const input = { workspaceId: 'w1', email: 'a@b.test', expiresInDays: 7 };
    const a = await withSecret('unit-test-secret-a', (m) => m.deriveFingerprint('create', input));
    const b = await withSecret('unit-test-secret-b', (m) => m.deriveFingerprint('create', input));
    expect(b).not.toBe(a);
  });

  it('OTP intent digests are NOT reproducible with an unkeyed SHA-256', async () => {
    const code = '123456';
    const digest = await withSecret('unit-test-secret-a', (m) => m.deriveIntentDigest('otp-code', code));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    for (const guess of [code, `code|${code}`, `otp-code|${code}`]) {
      expect(digest).not.toBe(createHash('sha256').update(guess).digest('hex'));
    }
    // …and the digest itself is key-bound.
    const rotated = await withSecret('unit-test-secret-b', (m) => m.deriveIntentDigest('otp-code', code));
    expect(rotated).not.toBe(digest);
  });

  it('compares digests in constant time and rejects mismatched lengths', async () => {
    const m: any = await import(MOD);
    expect(m.timingSafeEqualHex('aa'.repeat(32), 'aa'.repeat(32))).toBe(true);
    expect(m.timingSafeEqualHex('aa'.repeat(32), 'ab'.repeat(32))).toBe(false);
    expect(m.timingSafeEqualHex('aa', 'aaaa')).toBe(false);
  });
});
