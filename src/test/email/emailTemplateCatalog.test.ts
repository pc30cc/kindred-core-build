// @vitest-environment node
/**
 * The email template catalog (server/services/email/templateCatalog.ts) is
 * the one list of every template the platform keeps, and Super Admin →
 * Branding → Email templates is drawn from it. The owner's rule — every
 * email has a template, every template is viewable there — holds only while
 * the list is true, so this reads the senders:
 *
 *   - every slug a sender names is in the catalog as `sent`, and every
 *     `sent` slug has a sender: a new mail, or a new way of naming one,
 *     fails here until the catalog knows it;
 *   - the slugs nothing sends are listed as `legacy`, never left out;
 *   - each sent slug's sample values are exactly the keys its sender fills,
 *     in every language and both editions, and name no brand (the core
 *     fills {brand}); the operator notices keep their {{double}} braces;
 *   - every template has a name and a description in en, fa and tr.
 *
 * That each `sent` slug is seeded for both editions in fa, en and tr, and
 * that its rows print only the catalog's keys, is checked against a real
 * migration chain by integration/emailTemplatesRedesign291.pg.test.ts, which
 * takes its list from the catalog.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import {
  CORE_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_CATALOG,
  catalogEntry,
  catalogView,
  isSentTemplate,
  sampleTemplateData,
  templateVariables,
} from '../../../server/services/email/templateCatalog.js';
import { NOTIFICATION_EMAILS } from '../../../server/services/notificationEmail/types.js';
import { TRANSCRIPT_TEMPLATE_SLUG } from '../../../server/services/visitorTranscript.js';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (['node_modules', 'dist'].includes(name)) continue;
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The members of a string-literal union or object list in a file, between two markers. */
function literalsBetween(path: string, start: string, end: string): string[] {
  const source = read(path);
  const from = source.indexOf(start);
  expect(from, `${path}: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  return [...source.slice(from, to).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/**
 * Every way a sender names a template today, and the slugs each can name.
 * A `templateSlug:` written any other way is a sender this test does not
 * know: it fails until it is added here (and its slug to the catalog).
 */
const INDIRECTIONS: Record<string, { file: string; slugs: () => string[] }> = {
  'definition.slug': {
    file: 'server/services/notificationEmail/dispatcher.ts',
    slugs: () => Object.values(NOTIFICATION_EMAILS).map((d) => d.slug),
  },
  'link.slug': {
    file: 'server/services/auth-email.ts',
    slugs: () => literalsBetween('server/services/auth-email.ts', 'const AUTH_LINKS = {', '} as const;').filter((s) => s.includes('_') && !s.startsWith('auth_')),
  },
  slug: {
    file: 'server/services/billing/account/notify.ts',
    slugs: () => literalsBetween('server/services/billing/account/notify.ts', 'export type BillingEmailSlug =', ';'),
  },
  TRANSCRIPT_TEMPLATE_SLUG: {
    file: 'server/services/visitorTranscript.ts',
    slugs: () => [TRANSCRIPT_TEMPLATE_SLUG],
  },
};
/** Pass a slug through rather than name one: the core's outbox, and Super Admin's test of any catalog template. */
const PASS_THROUGH: Record<string, string> = {
  'request.templateSlug': 'server/services/email/outbox.ts',
  'input.slug': 'server/services/email/templateAdmin.ts',
};

function sentByCode(): { slugs: Set<string>; unknown: string[] } {
  const slugs = new Set<string>();
  const unknown: string[] = [];
  const files = [...sourceFiles('server'), ...sourceFiles('worker')].filter((f) => f !== join('server/services/email/index.ts'));
  for (const file of files) {
    for (const m of read(file).matchAll(/templateSlug:\s*([^,;\n}]+)/g)) {
      const named = m[1].trim();
      const literal = /^'([a-z_]+)'$/.exec(named);
      if (literal) {
        slugs.add(literal[1]);
        continue;
      }
      const indirection = INDIRECTIONS[named];
      if (indirection && indirection.file === file) {
        for (const slug of indirection.slugs()) slugs.add(slug);
        continue;
      }
      if (PASS_THROUGH[named] === file) continue;
      unknown.push(`${file}: templateSlug: ${named}`);
    }
  }
  return { slugs, unknown };
}

const SENT = EMAIL_TEMPLATE_CATALOG.filter((e) => e.status === 'sent');
const LEGACY = EMAIL_TEMPLATE_CATALOG.filter((e) => e.status === 'legacy');
const LOCALES = { en, fa, tr } as const;

function resolves(locale: unknown, path: string): boolean {
  let current: unknown = locale;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' && current.trim() !== '';
}

describe('the email template catalog', () => {
  it('names every slug once', () => {
    const slugs = EMAIL_TEMPLATE_CATALOG.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('knows every way a sender names a template', () => {
    expect(sentByCode().unknown).toEqual([]);
  });

  it('has every slug the code sends as sent, and nothing sent that no sender sends', () => {
    const { slugs } = sentByCode();
    expect(slugs.size).toBeGreaterThanOrEqual(28);
    expect([...slugs].sort()).toEqual(SENT.map((e) => e.slug).sort());
    for (const slug of slugs) expect(isSentTemplate(slug), slug).toBe(true);
  });

  it('lists the slugs nothing sends as legacy: the hosted seed\'s six and billing v2\'s twelve', () => {
    expect(LEGACY.map((e) => e.slug).sort()).toEqual([
      'account_expiry', 'invoice_due', 'invoice_issued', 'invoice_past_due', 'invoice_reminder', 'magic_link', 'new_conversation',
      'payment_failed', 'payment_received', 'payment_success', 'subscription_cancelled', 'subscription_free_fallback',
      'subscription_renewed', 'subscription_restored', 'system_alert', 'task_assigned', 'wallet_autopay_insufficient', 'welcome',
    ]);
    for (const entry of LEGACY) {
      expect(isSentTemplate(entry.slug)).toBe(false);
      expect(templateVariables(entry)).toEqual(['{brand}', '{year}', '{support_email}']);
      expect(sampleTemplateData(entry.slug, { edition: 'iran', locale: 'fa', appUrl: '' })).toEqual({ data: {} });
    }
    expect(catalogEntry('no_such_template')).toBeNull();
  });

  it('sends the saved card\'s mails in the International edition only', () => {
    const card = SENT.filter((e) => e.slug.startsWith('billing_card_')).map((e) => e.slug).sort();
    expect(card).toEqual(['billing_card_payment_failed', 'billing_card_removed', 'billing_card_renewed']);
    for (const entry of SENT) {
      expect([...entry.editions], entry.slug).toEqual(card.includes(entry.slug) ? ['international'] : ['iran', 'international']);
    }
    const iran = catalogView('iran');
    expect(iran.filter((v) => v.status === 'sent' && !v.sentInEdition).map((v) => v.slug).sort()).toEqual(card);
    expect(catalogView('international').filter((v) => v.status === 'sent' && !v.sentInEdition)).toEqual([]);
  });

  it('writes the operator notices\' placeholders with double braces, every other one with single', () => {
    for (const entry of SENT) {
      const operator = entry.slug.startsWith('operator_');
      for (const v of templateVariables(entry)) expect(v, entry.slug).toMatch(operator ? /^\{\{[a-z_]+\}\}$/ : /^\{[a-z_]+\}$/);
      expect(templateVariables(entry).slice(-3), entry.slug).toEqual(CORE_TEMPLATE_KEYS.map((k) => (operator ? `{{${k}}}` : `{${k}}`)));
    }
  });

  it('gives a notification its unsubscribe line\'s type, and service mail none', () => {
    for (const entry of SENT) {
      const notice = entry.slug.startsWith('operator_') || entry.slug.startsWith('offline_');
      expect(entry.footer !== null, entry.slug).toBe(notice);
      expect(entry.kind, entry.slug).toBe(entry.slug === 'operator_product_update' ? 'marketing' : notice ? 'notification' : 'transactional');
    }
  });

  it('has a name and a description for every template in en, fa and tr', () => {
    for (const [name, locale] of Object.entries(LOCALES)) {
      for (const entry of EMAIL_TEMPLATE_CATALOG) {
        expect(resolves(locale, `admin.brandingPage.emailTemplates.slugs.${entry.slug}`), `${name} ${entry.slug}`).toBe(true);
        expect(resolves(locale, entry.descriptionKey), `${name} ${entry.descriptionKey}`).toBe(true);
      }
    }
    const persian = EMAIL_TEMPLATE_CATALOG.map((e) => e.descriptionKey.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], fa));
    expect(persian.join('\n')).not.toMatch(/[يك]/);
  });

  it('sends the Super Admin to the Providers menu by the name the menu has', () => {
    for (const [name, locale] of Object.entries(LOCALES)) {
      const said = locale.admin.brandingPage.emailTemplates.descriptions.email_test;
      expect(said, name).toContain(locale.admin.nav.providers);
    }
  });
});

describe('the sample values', () => {
  const NOW = new Date('2026-10-30T10:24:00Z');
  const cases = (['iran', 'international'] as const).flatMap((edition) => (['fa', 'en', 'tr'] as const).map((locale) => ({ edition, locale })));

  it('are exactly the keys each sender fills, in every language of both editions', () => {
    for (const { edition, locale } of cases) {
      for (const entry of SENT) {
        const sample = sampleTemplateData(entry.slug, { edition, locale, appUrl: 'https://app.example.com', now: NOW });
        const at = `${edition}/${locale}/${entry.slug}`;
        expect(Object.keys(sample.data).sort(), at).toEqual([...entry.keys].sort());
        for (const key of Object.keys(sample.htmlData ?? {})) expect(entry.keys, `${at} htmlData.${key}`).toContain(key);
        for (const [key, value] of Object.entries(sample.data)) {
          // The visitor's own words reach the offline notice's HTML part only (offlineNotice.ts).
          if (entry.slug === 'offline_message_received' && /^(contact_|message_body)/.test(key)) {
            expect(value, `${at} ${key}`).toBe('');
            expect(sample.htmlData?.[key], `${at} htmlData.${key}`).toBeTruthy();
            continue;
          }
          expect(value, `${at} ${key}`).toBeTruthy();
        }
      }
    }
  });

  it('name no brand: the core fills {brand}, and the links are on the platform\'s own address', () => {
    for (const { edition, locale } of cases) {
      for (const entry of SENT) {
        const sample = sampleTemplateData(entry.slug, { edition, locale, appUrl: 'https://app.example.com', now: NOW });
        const all = JSON.stringify(sample);
        expect(all, entry.slug).not.toMatch(/webyar|respok|وب.?یار|رسپاک/i);
        for (const url of all.match(/https?:\/\/[^"\s\\<]+/g) ?? []) expect(url, entry.slug).toMatch(/^https:\/\/app\.example\.com\//);
      }
    }
  });

  it('are the edition\'s own: Toman and the Persian calendar in the Iranian edition, dollars in the International one', () => {
    const iran = sampleTemplateData('billing_payment_receipt', { edition: 'iran', locale: 'fa', appUrl: '', now: NOW }).data;
    expect(iran.amount).toMatch(/تومان$/);
    const intl = sampleTemplateData('billing_payment_receipt', { edition: 'international', locale: 'en', appUrl: '', now: NOW }).data;
    expect(intl.amount).toBe('$50.00');
    expect(intl.receipt_url).toBe('/blue-store/billing/receipts/R-7001');
    const date = sampleTemplateData('billing_trial_ending', { edition: 'iran', locale: 'fa', appUrl: '', now: NOW }).data.trial_end;
    expect(date).toMatch(/آبان|آذر/);
    // A code no real one can be, as the Verification preview says.
    expect(sampleTemplateData('verification_code', { edition: 'iran', locale: 'fa', appUrl: '' }).data.code).toBe('123456');
  });

  it('build the transcripts with the senders\' own rows', () => {
    const visitor = sampleTemplateData('visitor_conversation_transcript', { edition: 'international', locale: 'en', appUrl: '', now: NOW });
    expect(visitor.htmlData?.transcript).toMatch(/^<div class="msg msg-visitor"><div class="meta">You · [^<]+<\/div><div class="bubble" dir="auto">/);
    expect(visitor.htmlData?.transcript).toContain('<div class="msg msg-agent">');
    expect(visitor.data.transcript).toContain('You · ');
    const operator = sampleTemplateData('operator_conversation_transcript', { edition: 'iran', locale: 'fa', appUrl: '', now: NOW });
    // The dispatcher's rows: a notice (no bubble), then the customer's and the team's lines.
    expect(operator.htmlData?.transcript).toMatch(/^<div class="msg msg-agent"><div class="meta">[^<]+<\/div><\/div><div class="msg msg-visitor">/);
    expect(operator.data.name).toBe('سارا محمدی');
  });

  it('escape the HTML part\'s values', () => {
    const sample = sampleTemplateData('offline_message_received', { edition: 'international', locale: 'en', appUrl: '', now: NOW });
    expect(sample.htmlData?.message_body).toContain('hasn’t arrived yet.<br>Could you');
  });
});
