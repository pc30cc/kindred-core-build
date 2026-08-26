/**
 * 037/038 — retiring auth.users as an alternative application identity /
 * provisioning path, against a real PostgreSQL instance.
 *
 * Part A (self-host chain, the shared auth-chain database): the
 * `on_auth_user_created` trigger is gone, a raw INSERT into auth.users has
 * ZERO application side effects (no profiles/account/workspace/membership
 * row), profiles.email is enforced canonical at the table level (038), and
 * first-party signup (profiles + user_credentials) works with NO auth.users
 * row involved at all — auth.users INSERT != application signup.
 *
 * Part B (isolated — provision_account_on_signup only exists on the hosted
 * chain, whose full accounts/workspaces schema this repo's own test
 * infrastructure deliberately does not replicate outside the real
 * supabase/postgres CI image; see authStubSchema.ts's own doc comment).
 * A minimal stand-in function with the REAL signature is granted the same
 * PUBLIC/anon/authenticated-executable state 20260731160434_...sql actually
 * left it in, then 037's real SQL (read from disk, not re-implemented here)
 * is applied and the resulting privileges are proven — including literal
 * `SET ROLE anon|authenticated` execution attempts, not just privilege
 * flags — that anon/authenticated are denied and service_role can still
 * call it.
 *
 * Driven by TEST_DATABASE_URL (or the legacy CLEAN_INSTALL_DATABASE_URL) —
 * skipped entirely when no live Postgres is configured.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PgQueryable } from './pgMigrationChain';
import { ensureAuthChainInstalled } from './authStubSchema';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

const LOCKDOWN_MIGRATION = readFileSync(
  resolve(process.cwd(), 'database/migrations/037_retire_legacy_signup_trigger.sql'),
  'utf8',
);

let db: PgTestClient;

suite('037/038 — legacy GoTrue signup boundary closure (real PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN }) as unknown as PgTestClient;
    await db.connect();
    await ensureAuthChainInstalled(db);
  }, 60_000);

  afterAll(async () => { if (db) await db.end(); });

  afterEach(async () => {
    await db.query(`DELETE FROM public.profiles`);
    await db.query(`DELETE FROM public.user_credentials`);
    await db.query(`DELETE FROM auth.users`);
  });

  describe('Part A — self-host chain: auth.users is no longer a provisioning path', () => {
    it('037: no on_auth_user_created trigger remains on auth.users', async () => {
      const { rows } = await db.query(`
        SELECT count(*)::int AS n
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'auth' AND c.relname = 'users'
          AND t.tgname = 'on_auth_user_created' AND NOT t.tgisinternal
      `);
      expect(rows[0].n).toBe(0);
    });

    it('auth.users and the auth schema still exist — this closure removes a side effect, not the table', async () => {
      const { rows } = await db.query(`SELECT to_regclass('auth.users') IS NOT NULL AS exists`);
      expect(rows[0].exists).toBe(true);
    });

    it('A: inserting a fake legacy user into auth.users creates NO application identity at all', async () => {
      const before = await db.query(`SELECT count(*)::int AS n FROM public.profiles`);
      const { rows } = await db.query(
        `INSERT INTO auth.users (email) VALUES ('legacy-gotrue-signup@example.com') RETURNING id`,
      );
      const legacyUserId = rows[0].id as string;

      const afterProfiles = await db.query(`SELECT count(*)::int AS n FROM public.profiles`);
      expect(afterProfiles.rows[0].n).toBe(before.rows[0].n); // unchanged — no auto-created profile

      const specificProfile = await db.query(`SELECT 1 FROM public.profiles WHERE id = $1`, [legacyUserId]);
      expect(specificProfile.rowCount).toBe(0);

      const credentials = await db.query(`SELECT 1 FROM public.user_credentials WHERE user_id = $1`, [legacyUserId]);
      expect(credentials.rowCount).toBe(0);
    });

    it('D: first-party signup shape (profiles + user_credentials) succeeds with ZERO auth.users row involved', async () => {
      const usersBefore = await db.query(`SELECT count(*)::int AS n FROM auth.users`);

      // Mirrors exactly what POST /api/auth/signup does at the DB layer
      // (server/routes/auth.ts): mint an id, insert profiles, insert
      // user_credentials — auth.users is never read or written.
      const newUserId = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      await db.query(
        `INSERT INTO public.profiles (id, email, full_name) VALUES ($1, 'firstparty-signup@example.com', 'First Party')`,
        [newUserId],
      );
      await db.query(
        `INSERT INTO public.user_credentials (user_id, password_hash, password_algo) VALUES ($1, 'ARGON2ID_HASH', 'argon2id')`,
        [newUserId],
      );

      const profile = await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [newUserId]);
      expect(profile.rows[0].email).toBe('firstparty-signup@example.com');
      const cred = await db.query(`SELECT password_hash FROM public.user_credentials WHERE user_id = $1`, [newUserId]);
      expect(cred.rows[0].password_hash).toBe('ARGON2ID_HASH');

      const usersAfter = await db.query(`SELECT count(*)::int AS n FROM auth.users`);
      expect(usersAfter.rows[0].n).toBe(usersBefore.rows[0].n); // auth.users untouched by signup
    });
  });

  describe('Part A — 038: profiles.email canonical-storage CHECK constraint', () => {
    // 037 removed the auth.users trigger, so these write directly into
    // profiles — the same first-party signup shape as the D test above —
    // rather than relying on the now-retired trigger to populate it.
    it('an existing canonical row passes (no violation on ordinary writes)', async () => {
      const newUserId = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      const inserted = await db.query(
        `INSERT INTO public.profiles (id, email) VALUES ($1, 'canonical-check-ok@example.com') RETURNING email`,
        [newUserId],
      );
      expect(inserted.rows[0].email).toBe('canonical-check-ok@example.com');
    });

    it('a noncanonical direct INSERT is rejected by the CHECK constraint', async () => {
      await expect(
        db.query(
          `INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), '  Noncanonical@Example.com  ')`,
        ),
      ).rejects.toThrow(/profiles_email_canonical_check|check constraint/i);
    });

    it('a noncanonical direct UPDATE is rejected by the CHECK constraint', async () => {
      const newUserId = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, 'update-target@example.com')`, [newUserId]);

      await expect(
        db.query(`UPDATE public.profiles SET email = '  Update-Target-Changed@Example.com  ' WHERE id = $1`, [newUserId]),
      ).rejects.toThrow(/profiles_email_canonical_check|check constraint/i);

      // The row is untouched by the rejected write.
      const still = await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [newUserId]);
      expect(still.rows[0].email).toBe('update-target@example.com');
    });

    it('first-party signup (already-normalized input) succeeds against the constraint', async () => {
      const newUserId = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      await expect(
        db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, 'already-normalized@example.com')`, [newUserId]),
      ).resolves.toBeDefined();
    });

    it('admin_change_user_email (035, self-normalizing) succeeds against the constraint', async () => {
      const newUserId = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      await db.query(
        `INSERT INTO public.profiles (id, email) VALUES ($1, 'admin-change-check@example.com')`,
        [newUserId],
      );
      const result = await db.query(
        `SELECT * FROM public.admin_change_user_email($1, '  New-Admin-Changed@Example.com  ')`,
        [newUserId],
      );
      expect(result.rows[0].changed).toBe(true);
      expect(result.rows[0].new_email).toBe('new-admin-changed@example.com'); // RPC normalizes before writing
    });

    it('a normalized duplicate email remains rejected (036 unique index still enforced alongside the new CHECK)', async () => {
      const ownerId = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, 'dup-check-owner@example.com')`, [ownerId]);
      await expect(
        db.query(`INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), 'dup-check-owner@example.com')`),
      ).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  describe('Part B — provision_account_on_signup: ACL lockdown (isolated stand-in, real 037 SQL)', () => {
    async function installVulnerableStub() {
      // A stand-in with the REAL signature (037's lockdown logic keys off
      // to_regprocedure('public.provision_account_on_signup(uuid)'), so any
      // function with this exact signature exercises the same code path) —
      // its body only ever touches a private stub table, never
      // public.profiles/accounts/workspaces, so it cannot collide with
      // anything the rest of this shared-database test suite depends on.
      await db.query(`CREATE SCHEMA IF NOT EXISTS hosted_provisioning_stub`);
      await db.query(`CREATE TABLE IF NOT EXISTS hosted_provisioning_stub.calls (id serial PRIMARY KEY, user_id uuid, called_at timestamptz DEFAULT now())`);
      await db.query(`
        CREATE OR REPLACE FUNCTION public.provision_account_on_signup(_user_id uuid)
        RETURNS void
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path TO 'public'
        AS $$
        BEGIN
          INSERT INTO hosted_provisioning_stub.calls (user_id) VALUES (_user_id);
        END;
        $$;
      `);
      // Exactly the vulnerable grant state 20260731160434_20d5ab8b-...sql
      // actually left this function in: authenticated (and service_role)
      // executable, only PUBLIC/anon revoked.
      await db.query(`REVOKE ALL ON FUNCTION public.provision_account_on_signup(uuid) FROM PUBLIC, anon`);
      await db.query(`GRANT EXECUTE ON FUNCTION public.provision_account_on_signup(uuid) TO authenticated, service_role`);
    }

    afterAll(async () => {
      await db.query(`DROP FUNCTION IF EXISTS public.provision_account_on_signup(uuid)`);
      await db.query(`DROP SCHEMA IF EXISTS hosted_provisioning_stub CASCADE`);
    });

    it('before 037: authenticated CAN execute it (the actual vulnerable state being closed)', async () => {
      await installVulnerableStub();
      const { rows } = await db.query(`
        SELECT has_function_privilege('authenticated', 'public.provision_account_on_signup(uuid)', 'EXECUTE') AS auth_can
      `);
      expect(rows[0].auth_can).toBe(true);
    });

    it('after applying 037: anon and authenticated lose EXECUTE, service_role keeps it', async () => {
      await installVulnerableStub();
      await db.query(LOCKDOWN_MIGRATION);

      const { rows } = await db.query(`
        SELECT
          has_function_privilege('anon', 'public.provision_account_on_signup(uuid)', 'EXECUTE') AS anon_can,
          has_function_privilege('authenticated', 'public.provision_account_on_signup(uuid)', 'EXECUTE') AS auth_can,
          has_function_privilege('service_role', 'public.provision_account_on_signup(uuid)', 'EXECUTE') AS svc_can
      `);
      expect(rows[0]).toMatchObject({ anon_can: false, auth_can: false, svc_can: true });
    });

    it('B: a literal execution attempt as anon is denied (not just an ACL flag)', async () => {
      await installVulnerableStub();
      await db.query(LOCKDOWN_MIGRATION);
      await db.query('SET ROLE anon');
      try {
        await expect(
          db.query(`SELECT public.provision_account_on_signup(gen_random_uuid())`),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await db.query('RESET ROLE');
      }
    });

    it('B: a literal execution attempt as authenticated is denied (not just an ACL flag)', async () => {
      await installVulnerableStub();
      await db.query(LOCKDOWN_MIGRATION);
      await db.query('SET ROLE authenticated');
      try {
        await expect(
          db.query(`SELECT public.provision_account_on_signup(gen_random_uuid())`),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await db.query('RESET ROLE');
      }
    });

    it('C: a literal execution attempt as service_role succeeds — the approved backend path still works', async () => {
      await installVulnerableStub();
      await db.query(LOCKDOWN_MIGRATION);
      const targetId = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;

      await db.query('SET ROLE service_role');
      try {
        await expect(
          db.query(`SELECT public.provision_account_on_signup($1)`, [targetId]),
        ).resolves.toBeDefined();
      } finally {
        await db.query('RESET ROLE');
      }

      const called = await db.query(`SELECT 1 FROM hosted_provisioning_stub.calls WHERE user_id = $1`, [targetId]);
      expect(called.rowCount).toBe(1);
    });

    it('037 is safe to re-apply (idempotent) — a second application does not error and leaves the same ACL state', async () => {
      await installVulnerableStub();
      await db.query(LOCKDOWN_MIGRATION);
      await expect(db.query(LOCKDOWN_MIGRATION)).resolves.toBeDefined();

      const { rows } = await db.query(`
        SELECT
          has_function_privilege('authenticated', 'public.provision_account_on_signup(uuid)', 'EXECUTE') AS auth_can,
          has_function_privilege('service_role', 'public.provision_account_on_signup(uuid)', 'EXECUTE') AS svc_can
      `);
      expect(rows[0]).toMatchObject({ auth_can: false, svc_can: true });
    });
  });
});
