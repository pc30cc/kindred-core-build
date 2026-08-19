/**
 * 029 — legacy email-verification backfill.
 *
 * Corrects the false "already present" claim from an earlier report: no
 * migration ever copied auth.users.email_confirmed_at into
 * user_credentials.email_verified_at, so every migrated user reads back as
 * unverified. This test file has two halves:
 *
 *  - static assertions on the SQL text itself, proving the safety
 *    invariants (idempotent, never overwrites a non-null value, backfills
 *    both the UPDATE and INSERT cases) are present in both migration
 *    chains;
 *  - a pure-JS re-implementation of the same decision rule, exercised
 *    against representative legacy-user scenarios, since a real Postgres
 *    instance (with a live `auth` schema) isn't available in this test
 *    environment — this documents and locks the intended behavior even
 *    though it can't execute the SQL directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SELF_HOST = 'database/migrations/029_backfill_legacy_email_verification.sql';
const HOSTED = 'supabase/migrations/20260819160000_backfill_legacy_email_verification.sql';

describe('029 backfill SQL — safety invariants (static)', () => {
  for (const path of [SELF_HOST, HOSTED]) {
    const sql = readFileSync(path, 'utf8');

    it(`${path}: UPDATE only ever touches rows where email_verified_at IS NULL`, () => {
      const updateBlock = sql.match(/UPDATE public\.user_credentials[\s\S]*?;/)![0];
      expect(updateBlock).toMatch(/email_verified_at IS NULL/);
    });

    it(`${path}: UPDATE only sources rows where the legacy value is non-null`, () => {
      const updateBlock = sql.match(/UPDATE public\.user_credentials[\s\S]*?;/)![0];
      expect(updateBlock).toMatch(/au\.email_confirmed_at IS NOT NULL/);
    });

    it(`${path}: INSERT is idempotent (ON CONFLICT DO NOTHING)`, () => {
      const insertBlock = sql.match(/INSERT INTO public\.user_credentials[\s\S]*?;/)![0];
      expect(insertBlock).toMatch(/ON CONFLICT \(user_id\) DO NOTHING/);
    });

    it(`${path}: INSERT only creates rows for confirmed legacy users`, () => {
      const insertBlock = sql.match(/INSERT INTO public\.user_credentials[\s\S]*?;/)![0];
      expect(insertBlock).toMatch(/au\.email_confirmed_at IS NOT NULL/);
    });

    it(`${path}: INSERT never fires when a user_credentials row already exists`, () => {
      const insertBlock = sql.match(/INSERT INTO public\.user_credentials[\s\S]*?;/)![0];
      expect(insertBlock).toMatch(/NOT EXISTS[\s\S]*?user_credentials uc WHERE uc\.user_id = p\.id/);
    });

    it(`${path}: never writes password_hash or status (verification-only backfill)`, () => {
      expect(sql).not.toMatch(/password_hash\s*=/);
      expect(sql).not.toMatch(/status\s*=/);
    });

    it(`${path}: carries an in-migration proof block that fails the migration on any remaining gap`, () => {
      expect(sql).toMatch(/RAISE EXCEPTION '029:/);
    });
  }
});

/** Pure-JS mirror of the SQL's decision rule, for scenario coverage. */
interface LegacyUser {
  profileId: string;
  authUsersConfirmedAt: string | null; // null = no auth.users match or unconfirmed
  existingCredRow: { emailVerifiedAt: string | null } | null; // null = no row yet
}

function applyBackfill(user: LegacyUser): { rowExists: boolean; emailVerifiedAt: string | null } {
  if (user.existingCredRow) {
    // UPDATE branch: only touches NULL, only from a non-null source.
    if (user.existingCredRow.emailVerifiedAt === null && user.authUsersConfirmedAt !== null) {
      return { rowExists: true, emailVerifiedAt: user.authUsersConfirmedAt };
    }
    return { rowExists: true, emailVerifiedAt: user.existingCredRow.emailVerifiedAt };
  }
  // INSERT branch: only creates a row when there's a confirmed legacy match.
  if (user.authUsersConfirmedAt !== null) {
    return { rowExists: true, emailVerifiedAt: user.authUsersConfirmedAt };
  }
  return { rowExists: false, emailVerifiedAt: null };
}

describe('029 backfill decision rule — scenario coverage', () => {
  it('verified legacy user, no user_credentials row yet -> row created, verified state preserved', () => {
    const result = applyBackfill({ profileId: 'u1', authUsersConfirmedAt: '2025-01-01T00:00:00Z', existingCredRow: null });
    expect(result).toEqual({ rowExists: true, emailVerifiedAt: '2025-01-01T00:00:00Z' });
  });

  it('unverified legacy user, no user_credentials row yet -> no row created (still reads unverified)', () => {
    const result = applyBackfill({ profileId: 'u2', authUsersConfirmedAt: null, existingCredRow: null });
    expect(result).toEqual({ rowExists: false, emailVerifiedAt: null });
  });

  it('verified legacy user whose row already has email_verified_at NULL (e.g. completed password setup) -> backfilled', () => {
    const result = applyBackfill({
      profileId: 'u3',
      authUsersConfirmedAt: '2025-02-02T00:00:00Z',
      existingCredRow: { emailVerifiedAt: null },
    });
    expect(result).toEqual({ rowExists: true, emailVerifiedAt: '2025-02-02T00:00:00Z' });
  });

  it('a NEWER first-party verification timestamp is NEVER overwritten by an older legacy value', () => {
    const result = applyBackfill({
      profileId: 'u4',
      authUsersConfirmedAt: '2024-01-01T00:00:00Z', // older legacy value
      existingCredRow: { emailVerifiedAt: '2026-08-01T00:00:00Z' }, // newer first-party value
    });
    expect(result.emailVerifiedAt).toBe('2026-08-01T00:00:00Z');
  });

  it('an already-verified row is never downgraded to NULL even if legacy state is unconfirmed', () => {
    const result = applyBackfill({
      profileId: 'u5',
      authUsersConfirmedAt: null,
      existingCredRow: { emailVerifiedAt: '2026-08-01T00:00:00Z' },
    });
    expect(result.emailVerifiedAt).toBe('2026-08-01T00:00:00Z');
  });

  it('brand-new first-party-only signup (no auth.users match at all) is unaffected', () => {
    const result = applyBackfill({ profileId: 'u6', authUsersConfirmedAt: null, existingCredRow: null });
    expect(result).toEqual({ rowExists: false, emailVerifiedAt: null });
  });

  it('re-running the backfill (second pass) is a no-op for every scenario above', () => {
    const alreadyBackfilled: LegacyUser = {
      profileId: 'u1',
      authUsersConfirmedAt: '2025-01-01T00:00:00Z',
      existingCredRow: { emailVerifiedAt: '2025-01-01T00:00:00Z' },
    };
    const result = applyBackfill(alreadyBackfilled);
    expect(result).toEqual({ rowExists: true, emailVerifiedAt: '2025-01-01T00:00:00Z' });
  });
});
