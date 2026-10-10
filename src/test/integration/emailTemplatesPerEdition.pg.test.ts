// @vitest-environment node
/**
 * 260 — email templates per edition, against a database built by the whole
 * chain, through the real sendEmail() on the real data layer (postgres-only).
 *
 *   - every platform template belongs to an edition; each edition has every
 *     template (the other's copied once), one row per (edition, slug, locale);
 *   - the new templates (verification_code, email_test) exist for both
 *     editions in fa/en/tr; a re-run never overwrites an edited row;
 *   - sendEmail sends only the running edition's text, in a language that
 *     edition offers (Iran: Persian only), and never falls back to the other
 *     edition's row.
 *
 * Only the mail provider's HTTP call is stood in for (captured).
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; from: string }>);
vi.mock('../../../server/services/email/providers/resend.js', () => ({
  sendViaResend: async (_cfg: unknown, to: string, subject: string, html: string, _text: string, from: string) => {
    sent.push({ to, subject, html, from });
    return { success: true, provider: 'resend', id: `m-${sent.length}` };
  },
}));

suite('260 — email templates per edition (real PostgreSQL, real sendEmail)', () => {
  let chain: FullChainDatabase;
  let config: import('../../../server/config.js').ServerConfig;
  let sendEmail: typeof import('../../../server/services/email/index.js').sendEmail;
  let sendPlatformEmail: typeof import('../../../server/services/email/index.js').sendPlatformEmail;
  let invalidate: () => void;

  const setRegion = async (mode: string, locales: string[] = ['en', 'fa', 'tr']) => {
    await chain.db.query(`UPDATE public.platform_settings SET region_mode = $1, active_locales = $2`, [mode, locales]);
    invalidate();
  };
  const count = async (sql: string, params: unknown[] = []) => Number((await chain.db.query(sql, params)).rows[0].n);

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `email260_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    await chain.db.query(
      `INSERT INTO public.app_runtime_config (key, value) VALUES ('default_email_provider', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ provider_name: 'resend', config: { api_key: 're_test', from_email: 'no-reply@example.test', from_name: 'Sender' } })],
    );
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig();
    ({ sendEmail, sendPlatformEmail } = await import('../../../server/services/email/index.js'));
    invalidate = (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache;
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('every platform template belongs to an edition, and each edition has them all', async () => {
    expect(await count(`SELECT count(*)::int AS n FROM public.email_templates WHERE workspace_id IS NULL AND edition IS NULL`)).toBe(0);
    const perEdition = await chain.db.query(
      `SELECT edition, count(*)::int AS n FROM public.email_templates WHERE workspace_id IS NULL GROUP BY 1 ORDER BY 1`,
    );
    expect(perEdition.rows).toHaveLength(2);
    expect(perEdition.rows[0].n).toBe(perEdition.rows[1].n);
    expect(await count(
      `SELECT count(*)::int AS n FROM (
         SELECT slug, locale FROM public.email_templates WHERE workspace_id IS NULL AND edition = 'iran'
         EXCEPT SELECT slug, locale FROM public.email_templates WHERE workspace_id IS NULL AND edition = 'international'
       ) d`,
    )).toBe(0);
  });

  it('seeds verification_code and email_test for both editions in fa/en/tr', async () => {
    for (const slug of ['verification_code', 'email_test']) {
      const rows = await chain.db.query(
        `SELECT edition, locale FROM public.email_templates WHERE workspace_id IS NULL AND slug = $1 ORDER BY 1, 2`, [slug],
      );
      expect(rows.rows).toEqual([
        { edition: 'international', locale: 'en' }, { edition: 'international', locale: 'fa' }, { edition: 'international', locale: 'tr' },
        { edition: 'iran', locale: 'en' }, { edition: 'iran', locale: 'fa' }, { edition: 'iran', locale: 'tr' },
      ]);
    }
    const fa = await chain.db.query(
      `SELECT html_body FROM public.email_templates WHERE workspace_id IS NULL AND edition = 'iran' AND slug = 'verification_code' AND locale = 'fa'`,
    );
    expect(fa.rows[0].html_body).toContain('dir="rtl"');
    expect(fa.rows[0].html_body).toContain('{code}');
  });

  it('a second platform row for the same (edition, slug, locale) is refused', async () => {
    await expect(chain.db.query(
      `INSERT INTO public.email_templates (workspace_id, edition, slug, locale, subject, html_body)
       VALUES (NULL, 'iran', 'verification_code', 'fa', 'dup', '<p/>')`,
    )).rejects.toThrow(/uq_email_templates_platform_edition_slug_locale/);
  });

  it('re-running 260 adds nothing and keeps an edited template', async () => {
    await chain.db.query(
      `UPDATE public.email_templates SET subject = 'EDITED' WHERE workspace_id IS NULL AND edition = 'iran' AND slug = 'email_test' AND locale = 'fa'`,
    );
    const before = await count(`SELECT count(*)::int AS n FROM public.email_templates`);
    await applyMigrationSql(chain.db, readFileSync(resolve(process.cwd(), 'database/migrations/260_email_templates_per_edition.sql'), 'utf8'));
    expect(await count(`SELECT count(*)::int AS n FROM public.email_templates`)).toBe(before);
    const edited = await chain.db.query(
      `SELECT subject FROM public.email_templates WHERE workspace_id IS NULL AND edition = 'iran' AND slug = 'email_test' AND locale = 'fa'`,
    );
    expect(edited.rows[0].subject).toBe('EDITED');
  });

  it('sends only the running edition\'s text', async () => {
    await chain.db.query(
      `UPDATE public.email_templates SET subject = CASE edition WHEN 'iran' THEN 'IRAN {code}' ELSE 'INTL {code}' END
        WHERE workspace_id IS NULL AND slug = 'verification_code' AND locale = 'en'`,
    );
    await setRegion('multi');
    sent.length = 0;
    const intl = await sendEmail(config, { workspaceId: null, to: 'a@example.test', templateSlug: 'verification_code', templateData: { code: '123456', minutes: '10' }, locale: 'en' });
    expect(intl.success).toBe(true);
    expect(sent[0].subject).toBe('INTL 123456');
  });

  it('Iran sends Persian whatever language is asked for', async () => {
    await chain.db.query(
      `UPDATE public.email_templates SET subject = 'IRAN-FA {code}'
        WHERE workspace_id IS NULL AND edition = 'iran' AND slug = 'verification_code' AND locale = 'fa'`,
    );
    await setRegion('iran', ['fa']);
    sent.length = 0;
    await sendEmail(config, { workspaceId: null, to: 'a@example.test', templateSlug: 'verification_code', templateData: { code: '654321', minutes: '10' }, locale: 'en' });
    expect(sent[0].subject).toBe('IRAN-FA 654321');
  });

  it('never falls back to the other edition\'s template', async () => {
    await setRegion('multi');
    await chain.db.query(`DELETE FROM public.email_templates WHERE workspace_id IS NULL AND edition = 'international' AND slug = 'email_test'`);
    sent.length = 0;
    const res = await sendEmail(config, { workspaceId: null, to: 'a@example.test', templateSlug: 'email_test', locale: 'fa' });
    expect(res.success).toBe(false);
    expect(sent).toHaveLength(0);

    // With the caller's own fallback text it still goes out — never the Iranian row.
    const withFallback = await sendEmail(config, { workspaceId: null, to: 'a@example.test', templateSlug: 'email_test', locale: 'fa', subject: 'fallback', html: '<p>fallback</p>' });
    expect(withFallback.success).toBe(true);
    expect(sent[0].subject).toBe('fallback');
  });

  it('a language the edition lacks falls back within the edition', async () => {
    await setRegion('multi', ['en', 'tr']);
    await chain.db.query(
      `DELETE FROM public.email_templates WHERE workspace_id IS NULL AND edition = 'international' AND slug = 'verification_code' AND locale = 'tr'`,
    );
    sent.length = 0;
    await sendEmail(config, { workspaceId: null, to: 'a@example.test', templateSlug: 'verification_code', templateData: { code: '111111', minutes: '10' }, locale: 'tr' });
    expect(sent[0].subject).toBe('INTL 111111');
  });

  it('{support_email} is the edition\'s own support address, never one made from the recipient', async () => {
    await chain.db.query(`DELETE FROM public.platform_domains`);
    await chain.db.query(`INSERT INTO public.platform_domains (primary_domain, canonical_base_url) VALUES ('example.test', 'https://www.intl.example.test/')`);
    await chain.db.query(
      `UPDATE public.email_templates SET subject = 'SUP {support_email}'
        WHERE workspace_id IS NULL AND slug = 'verification_code' AND locale IN ('en', 'fa')`,
    );
    await setRegion('multi');
    sent.length = 0;
    await sendEmail(config, { workspaceId: null, to: 'someone@customer.test', templateSlug: 'verification_code', templateData: { code: '1', minutes: '1' }, locale: 'en' });
    expect(sent[0].subject).toBe('SUP support@intl.example.test');

    await setRegion('iran', ['fa']);
    sent.length = 0;
    await sendEmail(config, { workspaceId: null, to: 'someone@customer.test', templateSlug: 'verification_code', templateData: { code: '1', minutes: '1' }, locale: 'fa' });
    expect(sent[0].subject).toBe('SUP info@webyar.ai');
  });
  it('the workspace-less send (sign-up code) uses the same edition template, its own text only without one', async () => {
    await setRegion('iran', ['fa']);
    sent.length = 0;
    const res = await sendPlatformEmail(config, {
      to: 'new@customer.test', subject: 'compiled', text: 'compiled 1', html: '<p>compiled 1</p>',
      templateSlug: 'verification_code', templateData: { code: '1', minutes: '1' }, locale: 'en',
    });
    expect(res.success).toBe(true);
    expect(sent[0].subject).toBe('SUP info@webyar.ai');

    await chain.db.query(`DELETE FROM public.email_templates WHERE workspace_id IS NULL AND edition = 'iran' AND slug = 'verification_code'`);
    sent.length = 0;
    await sendPlatformEmail(config, {
      to: 'new@customer.test', subject: 'compiled', text: 'compiled 1', html: '<p>compiled 1</p>',
      templateSlug: 'verification_code', templateData: { code: '1', minutes: '1' }, locale: 'fa',
    });
    expect(sent[0].subject).toBe('compiled');
  });
});
