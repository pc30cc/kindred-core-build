// @vitest-environment node
/**
 * 280 — the chat widget's visitor forms, against a database built by the
 * whole chain:
 *
 *   T1  a pre-chat field is required only while it is asked: rows stored the
 *       old way (asked off, required on) are fixed by the file, and the
 *       trigger keeps every later write so (an older backend's included);
 *   T2  the owners' "new offline message" mail carries {contact_phone}: the
 *       seeded rows of both editions get a Phone row (in fa/en/tr words) and
 *       the phone in the text; a template without the seeded Email row is
 *       left as the Super Admin wrote it;
 *   T3  280 runs twice: nothing changes the second time, one trigger.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;
const FILE = resolve(process.cwd(), 'database/migrations/280_widget_visitor_forms.sql');

type Row = Record<string, unknown>;

suite('280 — the widget\'s visitor forms (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
  const owner = randomUUID();
  const workspaces = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `widgetforms280_${Date.now()}`);
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, 'o@test.local', 'Owner')`, [owner]);
    for (const id of workspaces) {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
    }
  }, 600_000);

  afterAll(async () => {
    await chain?.drop();
  });

  it('T1 rows stored the old way are fixed, and every later write keeps "required" only while "asked"', async () => {
    const [a, b, c] = workspaces;
    // As the panel used to save them (asked off, required left on), written
    // past the trigger to stand for rows from before 280.
    await q('ALTER TABLE public.widget_prechat_settings DISABLE TRIGGER trg_widget_prechat_settings_require_asked');
    await q(`INSERT INTO public.widget_prechat_settings (workspace_id, ask_name, require_name, ask_email, require_email, ask_phone, require_phone)
             VALUES ($1, false, true, true, true, false, true), ($2, true, true, true, true, true, false)`, [a, b]);
    await q('ALTER TABLE public.widget_prechat_settings ENABLE TRIGGER trg_widget_prechat_settings_require_asked');
    await applyMigrationSql(chain.db, readFileSync(FILE, 'utf8'));
    const fields = 'ask_name, require_name, ask_email, require_email, ask_phone, require_phone';
    expect(await one(`SELECT ${fields} FROM public.widget_prechat_settings WHERE workspace_id = $1`, [a]))
      .toEqual({ ask_name: false, require_name: false, ask_email: true, require_email: true, ask_phone: false, require_phone: false });
    expect(await one(`SELECT ${fields} FROM public.widget_prechat_settings WHERE workspace_id = $1`, [b]))
      .toEqual({ ask_name: true, require_name: true, ask_email: true, require_email: true, ask_phone: true, require_phone: false });

    // An older backend's save (only `ask_email` off) and a new row with the
    // table's defaults for what it leaves out.
    await q(`UPDATE public.widget_prechat_settings SET ask_email = false WHERE workspace_id = $1`, [b]);
    expect(await one(`SELECT ask_email, require_email FROM public.widget_prechat_settings WHERE workspace_id = $1`, [b]))
      .toEqual({ ask_email: false, require_email: false });
    await q(`INSERT INTO public.widget_prechat_settings (workspace_id, ask_name) VALUES ($1, false)`, [c]);
    expect(await one(`SELECT ${fields} FROM public.widget_prechat_settings WHERE workspace_id = $1`, [c]))
      .toEqual({ ask_name: false, require_name: false, ask_email: true, require_email: true, ask_phone: false, require_phone: false });
    // Asked again, a field can be required again.
    await q(`UPDATE public.widget_prechat_settings SET ask_email = true, require_email = true WHERE workspace_id = $1`, [b]);
    expect(await one(`SELECT require_email FROM public.widget_prechat_settings WHERE workspace_id = $1`, [b])).toEqual({ require_email: true });
  });

  it('T2 the owners\' offline-message mail has the phone in both editions\' seeded rows, in each language\'s words; an edited one is left alone', async () => {
    const rows = await q(`SELECT edition, locale, html_body, text_body FROM public.email_templates
                          WHERE workspace_id IS NULL AND slug = 'offline_message_received' ORDER BY edition, locale`);
    expect(rows.map((r) => `${r.edition}/${r.locale}`)).toEqual(['international/en', 'international/fa', 'international/tr', 'iran/en', 'iran/fa', 'iran/tr']);
    const label: Record<string, string> = { en: 'Phone', fa: 'تلفن', tr: 'Telefon' };
    for (const r of rows) {
      const html = String(r.html_body);
      expect(html.split('{contact_phone}')).toHaveLength(2);
      expect(html).toContain(`>${label[String(r.locale)]}</td><td style="padding:6px 0;" dir="ltr">{contact_phone}</td></tr></table>`);
      expect(String(r.text_body)).toContain('({contact_email} {contact_phone})');
    }

    // A Super Admin's own wording (no seeded Email row) is not touched.
    const own = '<p>From {contact_name}: {message_body}</p>';
    await q(`UPDATE public.email_templates SET html_body = $1, text_body = 'From {contact_name}'
             WHERE workspace_id IS NULL AND slug = 'offline_message_received' AND edition = 'iran' AND locale = 'en'`, [own]);
    await applyMigrationSql(chain.db, readFileSync(FILE, 'utf8'));
    expect(await one(`SELECT html_body, text_body FROM public.email_templates
                      WHERE workspace_id IS NULL AND slug = 'offline_message_received' AND edition = 'iran' AND locale = 'en'`))
      .toEqual({ html_body: own, text_body: 'From {contact_name}' });
  });

  it('T3 a second run changes nothing and leaves one trigger', async () => {
    const before = await q(`SELECT edition, locale, html_body, text_body FROM public.email_templates
                            WHERE workspace_id IS NULL AND slug = 'offline_message_received' ORDER BY edition, locale`);
    await applyMigrationSql(chain.db, readFileSync(FILE, 'utf8'));
    const after = await q(`SELECT edition, locale, html_body, text_body FROM public.email_templates
                           WHERE workspace_id IS NULL AND slug = 'offline_message_received' ORDER BY edition, locale`);
    expect(after).toEqual(before);
    expect(await one(`SELECT count(*)::int AS n FROM pg_trigger
                      WHERE tgrelid = 'public.widget_prechat_settings'::regclass AND tgname = 'trg_widget_prechat_settings_require_asked'`))
      .toEqual({ n: 1 });
    expect(await one(`SELECT current_setting('lock_timeout') AS lt`)).toEqual({ lt: '0' });
  });
});
