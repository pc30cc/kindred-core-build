// @vitest-environment node
/**
 * 291 — the content of every email the platform sends, against a database
 * built by every migration before 291 (as production had it), then 291, then
 * whatever follows it.
 *
 *   - every slug the code sends has its six rows (both editions, fa/en/tr),
 *     each content only (the layout is the email core's), with a preview
 *     line, one title and a hand-written text part (offline_message_received
 *     aside, whose text part is made from its HTML);
 *   - each row prints only the keys its sender fills, plus the core's, and
 *     the same words in both editions;
 *   - the transcripts: the operator's container says the team reads it, the
 *     visitor's keeps the line for someone who never asked for it, and the
 *     operator's says resolved, never closed;
 *   - an invitation's end is a details row, never inside a sentence (it can
 *     be "No expiry");
 *   - a row a Super Admin edited is kept and named, a switched-off one is
 *     replaced and stays off, a missing one is added, an edited visitor
 *     transcript gets only its new container, the slugs nothing sends are
 *     untouched, and a second run changes and names nothing new.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '291_email_templates_redesign.sql';

/** Filled for every template by the email core (renderEditionTemplate). */
const CORE = ['brand', 'year', 'support_email'];
const BILLING = ['workspace', 'billing_url'];
/**
 * Every slug the code sends and the keys its sender fills (the sends of the
 * email map: auth-email.ts, verification/service.ts, invitations/worker.ts,
 * adminEmailProviders.ts, visitorTranscript.ts, widget/offlineNotice.ts,
 * notificationEmail/producers.ts and the billing senders through
 * billing/account/notify.ts, which adds {workspace} and {billing_url}).
 */
const SENT: Record<string, string[]> = {
  email_verify: ['name', 'action_url', 'email', 'expiry_time'],
  password_reset: ['name', 'action_url', 'email', 'expiry_time'],
  verification_code: ['code', 'minutes'],
  invite_otp: ['code', 'expiry_minutes'],
  invite_member: ['name', 'workspace', 'inviter', 'role', 'action_url', 'expiry'],
  email_test: ['provider', 'slot', 'sent_at'],
  visitor_conversation_transcript: ['workspace', 'workspace_name', 'date', 'transcript', 'transcript_text'],
  offline_message_received: ['conversation_id', 'action_url', 'contact_name', 'contact_email', 'contact_phone', 'message_body'],
  offline_messages_summary: ['count', 'minutes', 'action_url'],
  operator_unread_digest: ['name', 'count', 'minutes', 'workspace', 'list', 'action_url'],
  operator_conversation_transcript: ['name', 'subject', 'contact', 'workspace', 'resolved_at', 'transcript', 'action_url'],
  operator_invoice_paid: ['name', 'workspace', 'amount', 'invoice_label', 'action_url'],
  operator_weekly_summary: ['name', 'workspace', 'conversations', 'resolved', 'messages', 'action_url'],
  operator_product_update: ['name', 'title', 'body'],
  billing_renewal_reminder: [...BILLING, 'plan_name', 'new_plan_name', 'amount', 'balance', 'period_end', 'days_left'],
  billing_renewed: [...BILLING, 'plan_name', 'old_plan_name', 'amount', 'balance', 'period_start', 'period_end'],
  billing_plan_changed: [...BILLING, 'plan_name', 'old_plan_name', 'amount', 'balance', 'period_start', 'period_end'],
  billing_card_renewed: [...BILLING, 'plan_name', 'old_plan_name', 'amount', 'balance', 'period_start', 'period_end', 'card'],
  billing_plan_activated: [...BILLING, 'plan_name', 'period_end', 'amount', 'balance'],
  billing_expired: [...BILLING, 'plan_name', 'expired_at'],
  billing_change_scheduled: [...BILLING, 'plan_name', 'new_plan_name', 'effective_at'],
  billing_payment_receipt: [...BILLING, 'receipt_url', 'receipt_number', 'amount', 'balance'],
  billing_trial_ending: [...BILLING, 'trial_end', 'days_left'],
  billing_trial_ended: [...BILLING],
  billing_card_payment_failed: [...BILLING, 'plan_name', 'amount', 'card', 'failure_reason', 'due_at'],
  billing_card_removed: [...BILLING, 'card', 'reason', 'plan_name', 'period_end'],
  billing_locked_data_deletion: [...BILLING, 'plan_name', 'days_left', 'deletion_date', 'locked_summary', 'export_url'],
  billing_ai_pack_purchased: [...BILLING, 'pack_name', 'credit', 'amount', 'balance', 'ai_balance'],
};
const SLUGS = Object.keys(SENT);
/** The rows this test edits before 291, which 291 keeps. */
const EDITED = ['iran/password_reset/en', 'international/visitor_conversation_transcript/tr'];

interface Row { edition: string; slug: string; locale: string; subject: string; html_body: string; text_body: string | null; is_active: boolean }

const placeholders = (text: string | null) => [...String(text ?? '').matchAll(/\{\{([a-z_][a-z0-9_]*)\}\}|\{([a-z_][a-z0-9_]*)\}/gi)]
  .map((m) => ({ key: m[1] ?? m[2], double: m[1] !== undefined }));

suite('291 — the content of every sent email template (real PostgreSQL)', () => {
  let admin: pg.Client;
  let db: pg.Client;
  const name = `email291_${Date.now()}`;
  const notices: string[] = [];
  let before: Row[] = [];
  let firstRun: string[] = [];

  const rows = async (where = 'TRUE', params: unknown[] = []): Promise<Row[]> => (await db.query(
    `SELECT edition, slug, locale, subject, html_body, text_body, is_active FROM public.email_templates
      WHERE workspace_id IS NULL AND ${where} ORDER BY slug, locale, edition`, params,
  )).rows as Row[];
  const apply = async (file: string) => applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
  /** 291 itself, with its NOTICEs heard (an earlier file may have quietened them). */
  const apply291 = async () => {
    await db.query('SET client_min_messages = notice');
    notices.length = 0;
    await apply(FILE);
    return notices.filter((n) => n.startsWith('291:'));
  };

  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN!);
    url.pathname = `/${name}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    db.on('notice', (n) => notices.push(String(n.message)));

    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter((f) => f < FILE)) await apply(file);
    before = await rows();

    // A Super Admin's own subject (on a reset and on a visitor transcript),
    // a row deleted and one switched off.
    await db.query(`UPDATE public.email_templates SET subject = 'Our own reset — {brand}'
                     WHERE workspace_id IS NULL AND edition = 'iran' AND slug = 'password_reset' AND locale = 'en'`);
    await db.query(`UPDATE public.email_templates SET subject = 'Sohbetiniz — {workspace_name}'
                     WHERE workspace_id IS NULL AND edition = 'international' AND slug = 'visitor_conversation_transcript' AND locale = 'tr'`);
    await db.query(`DELETE FROM public.email_templates
                     WHERE workspace_id IS NULL AND edition = 'international' AND slug = 'billing_trial_ended' AND locale = 'tr'`);
    await db.query(`UPDATE public.email_templates SET is_active = false
                     WHERE workspace_id IS NULL AND edition = 'iran' AND slug = 'email_test' AND locale = 'fa'`);

    firstRun = await apply291();
    for (const file of files.filter((f) => f > FILE)) await apply(file);
  }, 900_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  it('every sent slug had its six rows before, each a whole document (the old layouts)', () => {
    for (const slug of SLUGS) {
      expect(before.filter((r) => r.slug === slug).map((r) => `${r.edition}/${r.locale}`), slug).toEqual([
        'international/en', 'iran/en', 'international/fa', 'iran/fa', 'international/tr', 'iran/tr',
      ]);
    }
  });

  it('every sent slug has its six rows, each content only: a preview line, one title, a text part', async () => {
    const after = await rows('slug = ANY($1)', [SLUGS]);
    expect(after).toHaveLength(SLUGS.length * 6);
    for (const r of after) {
      const at = `${r.edition}/${r.slug}/${r.locale}`;
      if (EDITED.includes(at)) continue;
      expect(r.html_body, at).not.toMatch(/<html|<head|<body|<style|<script|style="/i);
      expect(r.html_body.startsWith('<div class="preheader">'), at).toBe(true);
      expect(r.html_body.match(/<h1>/g), at).toHaveLength(1);
      expect(r.subject, at).not.toMatch(/!|[A-Z]{4,}(?![a-z])/);
      if (r.slug === 'offline_message_received') expect(r.text_body, at).toBeNull();
      else expect(String(r.text_body).length, at).toBeGreaterThan(20);
      // A button is one link; a code is the sender's own digits.
      for (const action of r.html_body.match(/<p class="action">[\s\S]*?<\/p>/g) ?? []) expect(action.match(/<a /g), at).toHaveLength(1);
      if (/code|otp/.test(r.slug)) expect(r.html_body, at).toContain('<div class="code">{code}</div>');
    }
    // The same words in both editions.
    for (const slug of SLUGS) {
      for (const locale of ['fa', 'en', 'tr']) {
        if (EDITED.some((at) => at.endsWith(`/${slug}/${locale}`))) continue;
        const pair = after.filter((r) => r.slug === slug && r.locale === locale);
        expect([pair[0].subject, pair[0].html_body, pair[0].text_body], `${slug}/${locale}`)
          .toEqual([pair[1].subject, pair[1].html_body, pair[1].text_body]);
      }
    }
  });

  it('each row prints only the keys its sender fills (and the core\'s); the operator notices keep {{double}}', async () => {
    const { fillEmailTemplate } = await import('../../../server/services/email/index.js');
    for (const r of await rows('slug = ANY($1)', [SLUGS])) {
      const at = `${r.edition}/${r.slug}/${r.locale}`;
      const allowed = new Set([...SENT[r.slug], ...CORE]);
      for (const part of [r.subject, r.html_body, r.text_body]) {
        for (const p of placeholders(part)) {
          expect(allowed.has(p.key), `${at} prints {${p.key}}`).toBe(true);
          expect(p.double, `${at} {${p.key}}`).toBe(r.slug.startsWith('operator_'));
        }
      }
      // Filled as a sender fills it, nothing is left as typed.
      const data = Object.fromEntries([...allowed].map((key) => [key, `v-${key}`]));
      const out = fillEmailTemplate(r, data);
      for (const part of [out.subject, out.html, out.text]) expect(part, at).not.toMatch(/\{\{?[a-z_]+\}?\}/);
    }
  });

  it('the Persian rows are written in Persian letters, with the half-space where it belongs', async () => {
    for (const r of await rows(`slug = ANY($1) AND locale = 'fa'`, [SLUGS])) {
      const all = `${r.subject}\n${r.html_body}\n${r.text_body ?? ''}`;
      expect(all, r.slug).not.toMatch(/[يك]/);
      expect(all, r.slug).not.toMatch(/(^|[\s«(])(ن?می) [؀-ۿ]/);
      expect(all, r.slug).not.toMatch(/ [،؛.:؟]/);
    }
  });

  it('the transcripts: the operator\'s is read by the team and was resolved; the visitor\'s says what to do if unasked', async () => {
    for (const r of await rows(`slug = 'operator_conversation_transcript'`)) {
      const at = `${r.edition}/${r.locale}`;
      expect(r.html_body, at).toContain('<div class="transcript" data-reader="team">{{transcript}}</div>');
      // Queued only when a conversation is resolved (routes/conversations.ts),
      // which is not closed: a closed one has told the visitor it ended.
      for (const part of [r.html_body, r.text_body ?? '']) {
        expect(part, at).not.toMatch(/closed|بسته|kapan|kapat/i);
        expect(part, at).toMatch(/resolved|حل شد|çözül/);
      }
    }
    const ignore: Record<string, string> = {
      fa: 'اگر شما این ایمیل را نخواسته‌اید، آن را نادیده بگیرید.',
      en: 'If you didn’t ask for this email, you can ignore it.',
      tr: 'Bu e-postayı siz istemediyseniz yok sayabilirsiniz.',
    };
    for (const r of await rows(`slug = 'visitor_conversation_transcript'`)) {
      const at = `${r.edition}/${r.locale}`;
      if (EDITED.includes(`${r.edition}/${r.slug}/${r.locale}`)) continue;
      expect(r.html_body, at).toContain('<div class="transcript">{transcript}</div>');
      expect(r.html_body, at).toContain(`<p class="note">${ignore[r.locale]}</p>`);
      expect(r.text_body, at).toContain(ignore[r.locale]);
    }
  });

  it('an invitation\'s end is a details row, in the HTML and the text part, never inside a sentence', async () => {
    const label: Record<string, string> = { fa: 'اعتبار تا', en: 'Valid until', tr: 'Geçerlilik sonu' };
    for (const r of await rows(`slug = 'invite_member'`)) {
      const at = `${r.edition}/${r.locale}`;
      expect(r.html_body.match(/\{expiry\}/g), at).toHaveLength(1);
      expect(r.html_body, at).toContain(`<table class="details"><tr><th>${label[r.locale]}</th><td>{expiry}</td></tr></table>`);
      expect(r.text_body?.match(/\{expiry\}/g), at).toHaveLength(1);
      expect(r.text_body, at).toContain(`${label[r.locale]}: {expiry}`);
    }
  });

  it('an edited visitor transcript keeps the Super Admin\'s words and gets only the container its rows belong in', async () => {
    const kept = (await rows(`edition = 'international' AND slug = 'visitor_conversation_transcript' AND locale = 'tr'`))[0];
    const seeded = before.find((r) => r.edition === 'international' && r.slug === 'visitor_conversation_transcript' && r.locale === 'tr')!;
    const table = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">{transcript}</table>';
    expect(seeded.html_body).toContain(table);
    expect(kept.subject).toBe('Sohbetiniz — {workspace_name}');
    expect(kept.text_body).toBe(seeded.text_body);
    expect(kept.html_body).toBe(seeded.html_body.replace(table, '<div class="transcript">{transcript}</div>'));
    expect(kept.html_body).toMatch(/<html/i);
  });

  it('keeps and names an edited row, replaces and names a switched-off one, adds a missing one', async () => {
    const edited = (await rows(`edition = 'iran' AND slug = 'password_reset' AND locale = 'en'`))[0];
    const seeded = before.find((r) => r.edition === 'iran' && r.slug === 'password_reset' && r.locale === 'en')!;
    expect(edited).toMatchObject({ subject: 'Our own reset — {brand}', html_body: seeded.html_body, text_body: seeded.text_body });

    const off = (await rows(`edition = 'iran' AND slug = 'email_test' AND locale = 'fa'`))[0];
    expect(off.is_active).toBe(false);
    expect(off.html_body.startsWith('<div class="preheader">')).toBe(true);

    const added = (await rows(`edition = 'international' AND slug = 'billing_trial_ended' AND locale = 'tr'`))[0];
    const twin = (await rows(`edition = 'iran' AND slug = 'billing_trial_ended' AND locale = 'tr'`))[0];
    expect(added).toMatchObject({ subject: twin.subject, html_body: twin.html_body, text_body: twin.text_body, is_active: true });

    expect(firstRun).toEqual([
      '291: 165 rows replaced, 1 added',
      '291: kept as the Super Admin wrote them (not replaced): iran/password_reset/en, international/visitor_conversation_transcript/tr',
      '291: switched off (left off): iran/email_test/fa',
      '291: kept, the transcript\'s table changed to div.transcript: international/visitor_conversation_transcript/tr',
    ]);
  });

  it('leaves the slugs nothing sends as they were', async () => {
    const legacy = (r: Row) => !SLUGS.includes(r.slug);
    expect((await rows()).filter(legacy)).toEqual(before.filter(legacy));
    expect(before.filter(legacy).length).toBeGreaterThan(0);
  });

  it('a second run changes nothing and names only what it named before', async () => {
    const was = await rows();
    const secondRun = await apply291();
    expect(await rows()).toEqual(was);
    expect(secondRun).toEqual([
      '291: 0 rows replaced, 0 added',
      '291: kept as the Super Admin wrote them (not replaced): iran/password_reset/en, international/visitor_conversation_transcript/tr',
      '291: switched off (left off): iran/email_test/fa',
    ]);
    expect((await db.query(`SELECT to_regclass('pg_temp._email_291') AS t`)).rows[0].t).toBeNull();
    expect((await db.query(`SELECT current_setting('lock_timeout') AS lt`)).rows[0].lt).toBe('0');
  });
});
