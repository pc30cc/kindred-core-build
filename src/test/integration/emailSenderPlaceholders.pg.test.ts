/**
 * 252 — the platform email settings stop holding placeholder sender
 * identities, against real PostgreSQL.
 *
 * Nothing reads email_settings.sender_email or
 * email_settings_localized.sender_name (emailProviderOwnership.test.ts), but
 * the platform rows still said "My Platform" / "پلتفرم من" / "Destekly" and
 * noreply@example.com, which read like the names platform mail is sent
 * under. The migration clears exactly those values on the platform rows,
 * leaves every other value alone, and stops the column default from writing
 * noreply@example.com into a new platform row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PgQueryable } from './pgMigrationChain';
import { ensureAuthChainInstalled } from './authStubSchema';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

const MIGRATION = readFileSync(
  resolve(process.cwd(), 'database/migrations/252_email_sender_placeholders_cleared.sql'),
  'utf8',
);
const LOCALES = ['zz-252-en', 'zz-252-fa', 'zz-252-tr', 'zz-252-own'];

let db: PgTestClient;

async function cleanUp() {
  await db.query(`DELETE FROM public.email_settings_localized WHERE locale = ANY($1)`, [LOCALES]);
  await db.query(`DELETE FROM public.email_settings WHERE workspace_id IS NULL`);
}

suite('252 — email sender placeholders cleared (real PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN }) as unknown as PgTestClient;
    await db.connect();
    await ensureAuthChainInstalled(db);
    await cleanUp();
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await cleanUp();
    await db.end();
  });

  it('clears the three placeholder names and keeps a real one', async () => {
    await db.query(
      `INSERT INTO public.email_settings_localized (workspace_id, locale, sender_name, footer_text)
       VALUES (NULL, 'zz-252-en', 'My Platform', 'kept'),
              (NULL, 'zz-252-fa', 'پلتفرم من', NULL),
              (NULL, 'zz-252-tr', 'Destekly', NULL),
              (NULL, 'zz-252-own', 'Webyar Support', NULL)`,
    );
    await db.query(MIGRATION);
    const { rows } = await db.query(
      `SELECT locale, sender_name, footer_text FROM public.email_settings_localized
        WHERE locale = ANY($1) ORDER BY locale`,
      [LOCALES],
    );
    expect(rows).toEqual([
      { locale: 'zz-252-en', sender_name: null, footer_text: 'kept' },
      { locale: 'zz-252-fa', sender_name: null, footer_text: null },
      { locale: 'zz-252-own', sender_name: 'Webyar Support', footer_text: null },
      { locale: 'zz-252-tr', sender_name: null, footer_text: null },
    ]);
  });

  it('clears the invented address and a new platform row no longer gets it', async () => {
    await db.query(`DELETE FROM public.email_settings WHERE workspace_id IS NULL`);
    await db.query(
      `INSERT INTO public.email_settings (workspace_id, sender_email, reply_to_email)
       VALUES (NULL, 'noreply@example.com', 'support@example.org')`,
    );
    await db.query(MIGRATION);
    const cleared = await db.query(`SELECT sender_email, reply_to_email FROM public.email_settings WHERE workspace_id IS NULL`);
    expect(cleared.rows).toEqual([{ sender_email: null, reply_to_email: 'support@example.org' }]);

    // What PUT /api/admin/management/email-settings inserts: reply_to_email only.
    await db.query(`DELETE FROM public.email_settings WHERE workspace_id IS NULL`);
    await db.query(`INSERT INTO public.email_settings (workspace_id, reply_to_email) VALUES (NULL, '')`);
    const fresh = await db.query(`SELECT sender_email FROM public.email_settings WHERE workspace_id IS NULL`);
    expect(fresh.rows).toEqual([{ sender_email: null }]);
  });

  it('runs again without error or change', async () => {
    await expect(db.query(MIGRATION)).resolves.toBeDefined();
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM public.email_settings_localized WHERE locale = ANY($1) AND sender_name IS NOT NULL`,
      [LOCALES],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });
});
