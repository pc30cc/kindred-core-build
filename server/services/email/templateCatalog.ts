/**
 * THE EMAIL TEMPLATE CATALOG — every template the platform keeps, named once.
 *
 * The owner's rule (2026-10-30): every email the platform sends has a
 * template, every template can be seen in Super Admin → Branding → Email
 * templates, and no email goes out without one. This list is what makes that
 * checkable:
 *
 *   - every slug a sender names is here as `sent`, with the placeholders that
 *     sender fills (src/test/email/emailTemplateCatalog.test.ts reads the
 *     senders and fails on a slug, or a way of naming one, missing here), and
 *     the migration chain must seed it for both editions in fa, en and tr
 *     (emailTemplatesRedesign291.pg.test.ts takes its list from here);
 *   - every other slug the table still holds — the hosted seed's six
 *     placeholders and billing v2's twelve mails, which nothing sends — is
 *     here as `legacy`, so the tab lists it as no longer sent instead of
 *     hiding it;
 *   - a `sent` slug's row may be edited but never deleted or switched off
 *     (server/routes/adminManagement.ts), so no mail can lose its template
 *     from the Super Admin's side.
 *
 * The sample values the tab's preview and its "Send me a test" fill a
 * template with are built here too, with the senders' own helpers (the
 * billing formatters, the chat transcript rows, the notification
 * dispatcher's values, the invitation's labels), so a preview reads like the
 * mail a person gets. They stay on the server and reach the panel only
 * through the API: the frontend bundle of one brand may not carry the other
 * brand's words (scripts/build/brandAudit.mjs), and the samples name no brand
 * at all ({brand} is the email core's).
 */

import type { Edition } from '../../../shared/edition.js';
import { EDITION_PROFILE, editionDefaultTimeZone } from '../../../shared/edition.js';
import type { EmailCategory } from './providers/types.js';
import { testMailRequest } from './testMail.js';
import { expiryLabels } from '../auth-email.js';
import { buildInviteUrl } from '../invitations/tokens.js';
import { renderInviteExpiry, renderRoleLabel } from '../invitations/notificationTemplates.js';
import { transcriptRow } from '../transcriptEmailRows.js';
import { escapeMailText, mailTextLines, OFFLINE_NOTICE_WINDOW_SECONDS } from '../widget/offlineNotice.js';
import { templateValues } from '../notificationEmail/dispatcher.js';
import { escapeHtml } from '../notificationEmail/unsubscribe.js';
import {
  NOTIFICATION_EMAILS,
  NOTIFICATION_EMAIL_TYPES,
  OFFLINE_MESSAGES_EMAIL,
  type EmailPreferenceType,
  type NotificationEmailType,
} from '../notificationEmail/types.js';
import { billingIntervalLabel, formatBillingDate, formatBillingMoney, formatBillingNumber } from '../billing/account/notify.js';
import { REMOVED_REASONS, cardLabel, failureText } from '../billing/account/card.js';
import { lockedSummary } from '../billing/locks/retention.js';
import { FAKE_PREVIEW_CODE } from '../verification/templatePreview.js';

/** The tab's groups (admin.brandingPage.emailTemplates.categories). */
export type EmailTemplateCategory = 'auth' | 'transactional' | 'notification' | 'billing';
/** Sent by the code today, or kept in the table with nothing sending it. */
export type EmailTemplateStatus = 'sent' | 'legacy';

export interface EmailTemplateCatalogEntry {
  slug: string;
  category: EmailTemplateCategory;
  status: EmailTemplateStatus;
  /** What the email core calls the mail (email_logs, a provider's tag, the footer's "why" line). */
  kind: EmailCategory;
  /** The keys the sender fills, the core's ({brand}, {year}, {support_email}) not counted. */
  keys: readonly string[];
  /** How its rows write a placeholder: the operator notices keep `{{key}}` (migration 206). */
  braces: 'single' | 'double';
  /** The editions that send it. */
  editions: readonly Edition[];
  /** Its one line in the tab (en, fa and tr). */
  descriptionKey: string;
  /** The operator's switch a notification's unsubscribe line names, or null for service mail. */
  footer: EmailPreferenceType | null;
}

/** What the email core fills in every template (index.ts coreData). */
export const CORE_TEMPLATE_KEYS = ['brand', 'year', 'support_email'] as const;

const BOTH: readonly Edition[] = ['iran', 'international'];
const DESCRIPTION = 'admin.brandingPage.emailTemplates.descriptions';

function sent(
  slug: string,
  category: EmailTemplateCategory,
  keys: readonly string[],
  opts: { kind?: EmailCategory; editions?: readonly Edition[]; footer?: EmailPreferenceType; braces?: 'single' | 'double' } = {},
): EmailTemplateCatalogEntry {
  return {
    slug,
    category,
    status: 'sent',
    kind: opts.kind ?? 'transactional',
    keys,
    braces: opts.braces ?? 'single',
    editions: opts.editions ?? BOTH,
    descriptionKey: `${DESCRIPTION}.${slug}`,
    footer: opts.footer ?? null,
  };
}

/** A row nothing sends: only the core would fill it, and only if something sent it again. */
function legacy(slug: string, category: EmailTemplateCategory, description = slug): EmailTemplateCatalogEntry {
  return {
    slug,
    category,
    status: 'legacy',
    kind: category === 'notification' ? 'notification' : 'transactional',
    keys: [],
    braces: 'single',
    editions: [],
    descriptionKey: `${DESCRIPTION}.${description}`,
    footer: null,
  };
}

/**
 * The keys each operator notice's payload carries, plus {{name}}, which the
 * dispatcher adds (notificationEmail/producers.ts, dispatcher.ts
 * templateValues). Typed by the registry, so a type added there needs its
 * keys here before this compiles.
 */
const OPERATOR_KEYS: Record<NotificationEmailType, readonly string[]> = {
  unread_messages: ['name', 'count', 'minutes', 'workspace', 'list', 'action_url'],
  transcripts: ['name', 'subject', 'contact', 'workspace', 'resolved_at', 'transcript', 'action_url'],
  paid_invoices: ['name', 'workspace', 'amount', 'invoice_label', 'action_url'],
  weekly_summary: ['name', 'workspace', 'conversations', 'resolved', 'messages', 'action_url'],
  product_updates: ['name', 'title', 'body'],
};

/** sendBillingEmail adds these to every billing mail (billing/account/notify.ts). */
const BILLING = ['workspace', 'billing_url'];
/** The saved card renews in the International edition only (migration 262). */
const CARD_EDITIONS: readonly Edition[] = ['international'];

export const EMAIL_TEMPLATE_CATALOG: readonly EmailTemplateCatalogEntry[] = [
  // auth-email.ts (both links: AUTH_LINKS), verification/service.ts.
  sent('email_verify', 'auth', ['name', 'action_url', 'email', 'expiry_time']),
  sent('verification_code', 'auth', ['code', 'minutes']),
  sent('password_reset', 'auth', ['name', 'action_url', 'email', 'expiry_time']),
  // invitations/worker.ts, email/testMail.ts, visitorTranscript.ts.
  sent('invite_member', 'transactional', ['name', 'workspace', 'inviter', 'role', 'action_url', 'expiry']),
  sent('invite_otp', 'transactional', ['code', 'expiry_minutes']),
  sent('email_test', 'transactional', ['provider', 'slot', 'sent_at']),
  sent('visitor_conversation_transcript', 'transactional', ['workspace', 'workspace_name', 'date', 'transcript', 'transcript_text']),
  // The operator notification emails, from their registry, then the
  // owners' offline-message notices (widget/offlineNotice.ts).
  ...NOTIFICATION_EMAIL_TYPES.map((type) => sent(NOTIFICATION_EMAILS[type].slug, 'notification', OPERATOR_KEYS[type], {
    kind: NOTIFICATION_EMAILS[type].category,
    footer: type,
    braces: 'double',
  })),
  sent('offline_message_received', 'notification', ['conversation_id', 'action_url', 'contact_name', 'contact_email', 'contact_phone', 'message_body'], {
    kind: 'notification',
    footer: OFFLINE_MESSAGES_EMAIL,
  }),
  sent('offline_messages_summary', 'notification', ['count', 'minutes', 'action_url'], {
    kind: 'notification',
    footer: OFFLINE_MESSAGES_EMAIL,
  }),
  // The billing mails (billing/account/notify.ts BillingEmailSlug).
  sent('billing_renewal_reminder', 'billing', [...BILLING, 'plan_name', 'new_plan_name', 'amount', 'balance', 'period_end', 'days_left']),
  sent('billing_renewed', 'billing', [...BILLING, 'plan_name', 'old_plan_name', 'amount', 'balance', 'period_start', 'period_end']),
  sent('billing_expired', 'billing', [...BILLING, 'plan_name', 'expired_at']),
  sent('billing_plan_changed', 'billing', [...BILLING, 'plan_name', 'old_plan_name', 'amount', 'balance', 'period_start', 'period_end']),
  sent('billing_change_scheduled', 'billing', [...BILLING, 'plan_name', 'new_plan_name', 'effective_at']),
  sent('billing_payment_receipt', 'billing', [...BILLING, 'receipt_url', 'receipt_number', 'amount', 'balance']),
  sent('billing_plan_activated', 'billing', [...BILLING, 'plan_name', 'period_end', 'amount', 'balance']),
  sent('billing_trial_ending', 'billing', [...BILLING, 'trial_end', 'days_left']),
  sent('billing_trial_ended', 'billing', [...BILLING]),
  sent('billing_card_renewed', 'billing', [...BILLING, 'plan_name', 'old_plan_name', 'amount', 'balance', 'period_start', 'period_end', 'card'], { editions: CARD_EDITIONS }),
  sent('billing_card_payment_failed', 'billing', [...BILLING, 'plan_name', 'amount', 'card', 'failure_reason', 'due_at'], { editions: CARD_EDITIONS }),
  sent('billing_card_removed', 'billing', [...BILLING, 'card', 'reason', 'plan_name', 'period_end'], { editions: CARD_EDITIONS }),
  sent('billing_locked_data_deletion', 'billing', [...BILLING, 'plan_name', 'days_left', 'deletion_date', 'locked_summary', 'export_url']),
  sent('billing_ai_pack_purchased', 'billing', [...BILLING, 'pack_name', 'credit', 'amount', 'balance', 'ai_balance']),
  // Nothing sends these. The hosted seed's placeholders (239)…
  legacy('magic_link', 'auth'),
  legacy('welcome', 'auth'),
  legacy('new_conversation', 'notification'),
  legacy('task_assigned', 'notification'),
  legacy('account_expiry', 'notification'),
  legacy('system_alert', 'notification'),
  // …and billing v2's mails, retired with it (267, 268).
  ...[
    'invoice_issued', 'invoice_reminder', 'invoice_due', 'invoice_past_due',
    'payment_success', 'payment_failed', 'payment_received',
    'subscription_renewed', 'subscription_cancelled', 'subscription_restored', 'subscription_free_fallback',
    'wallet_autopay_insufficient',
  ].map((slug) => legacy(slug, 'billing', 'billingV2')),
];

const BY_SLUG = new Map(EMAIL_TEMPLATE_CATALOG.map((entry) => [entry.slug, entry]));

export function catalogEntry(slug: string): EmailTemplateCatalogEntry | null {
  return BY_SLUG.get(slug) ?? null;
}

/** A slug the platform sends: its rows are edited, never deleted or switched off. */
export function isSentTemplate(slug: string): boolean {
  return BY_SLUG.get(slug)?.status === 'sent';
}

/**
 * The placeholders as a row writes them, the sender's first, then the core's
 * (`{name}`, or `{{name}}` in the operator notices). A legacy slug gets the
 * core's alone: nothing else would be filled.
 */
export function templateVariables(entry: EmailTemplateCatalogEntry): string[] {
  const wrap = (key: string) => (entry.braces === 'double' ? `{{${key}}}` : `{${key}}`);
  return [...entry.keys, ...CORE_TEMPLATE_KEYS].map(wrap);
}

/** One template as Super Admin's tab reads it (GET …/email-templates/catalog). */
export interface EmailTemplateCatalogView {
  slug: string;
  category: EmailTemplateCategory;
  status: EmailTemplateStatus;
  kind: EmailCategory;
  variables: string[];
  editions: readonly Edition[];
  /** False for a mail the running edition never sends (the saved card's, in the Iranian edition). */
  sentInEdition: boolean;
  descriptionKey: string;
}

export function catalogView(edition: Edition): EmailTemplateCatalogView[] {
  return EMAIL_TEMPLATE_CATALOG.map((entry) => ({
    slug: entry.slug,
    category: entry.category,
    status: entry.status,
    kind: entry.kind,
    variables: templateVariables(entry),
    editions: entry.editions,
    sentInEdition: entry.status === 'sent' && entry.editions.includes(edition),
    descriptionKey: entry.descriptionKey,
  }));
}

// ─── Sample values ────────────────────────────────────────────────────────

type SampleLocale = 'fa' | 'en' | 'tr';

/** What a sender passes the email core: templateData, and the HTML part's own values. */
export interface TemplateSample {
  data: Record<string, string>;
  htmlData?: Record<string, string>;
}

interface SampleWords {
  /** The operator or account the mail is to. */
  name: string;
  fullName: string;
  email: string;
  workspace: string;
  inviter: string;
  /** A visitor, and what they wrote. */
  contact: string;
  contactEmail: string;
  contactPhone: string;
  message: string;
  /** The visitor's word for themselves in their copy of the chat. */
  you: string;
  /** A chat, the customer's lines and the team's ("←", "→"), and a notice. */
  chat: Array<['visitor' | 'agent', string]>;
  joined: string;
  subjects: string[];
  plan: string;
  newPlan: string;
  pack: string;
  title: string;
  body: string;
}

const WORDS: Record<SampleLocale, SampleWords> = {
  en: {
    name: 'Sara',
    fullName: 'Sara Miller',
    email: 'sara@example.com',
    workspace: 'Blue Store',
    inviter: 'Maria Lopez',
    contact: 'Daniel Brooks',
    contactEmail: 'daniel@example.com',
    contactPhone: '+1 415 555 0100',
    message: 'Hi, I ordered a blue jacket last week and it hasn’t arrived yet.\nCould you check where it is?',
    you: 'You',
    chat: [
      ['visitor', 'Hi, I ordered a blue jacket last week and it hasn’t arrived yet.'],
      ['agent', 'Hi Daniel, sorry for the wait. Let me check your order.'],
      ['agent', 'It left our warehouse yesterday and should reach you by Thursday.'],
      ['visitor', 'Great, thank you.'],
    ],
    joined: 'Sara joined the conversation',
    subjects: ['Where is my order?', 'Discount code not working', 'Change of delivery address'],
    plan: 'Pro',
    newPlan: 'Business',
    pack: 'AI credit pack',
    title: 'A faster inbox',
    body: 'The inbox now opens conversations faster and keeps your place when you come back.\nThere is nothing you need to change.',
  },
  fa: {
    name: 'سارا',
    fullName: 'سارا محمدی',
    email: 'sara@example.com',
    workspace: 'فروشگاه آبی',
    inviter: 'مریم احمدی',
    contact: 'دانیال رضایی',
    contactEmail: 'daniel@example.com',
    contactPhone: '+98 912 000 0000',
    message: 'سلام، هفتهٔ پیش یک کاپشن آبی سفارش دادم و هنوز نرسیده.\nمی‌شود بررسی کنید کجاست؟',
    you: 'شما',
    chat: [
      ['visitor', 'سلام، هفتهٔ پیش یک کاپشن آبی سفارش دادم و هنوز نرسیده.'],
      ['agent', 'سلام، ببخشید که منتظر ماندید. الان سفارشتان را بررسی می‌کنم.'],
      ['agent', 'سفارش دیروز از انبار فرستاده شده و تا پنجشنبه به دستتان می‌رسد.'],
      ['visitor', 'عالی است، ممنون.'],
    ],
    joined: 'سارا وارد گفتگو شد',
    subjects: ['سفارشم کجاست؟', 'کد تخفیف کار نمی‌کند', 'تغییر نشانی ارسال'],
    plan: 'حرفه‌ای',
    newPlan: 'تجاری',
    pack: 'بستهٔ اعتبار هوش مصنوعی',
    title: 'صندوق ورودی سریع‌تر',
    body: 'صندوق ورودی حالا گفتگوها را سریع‌تر باز می‌کند و وقتی برمی‌گردید، جای قبلی‌تان را نگه می‌دارد.\nلازم نیست چیزی را تغییر دهید.',
  },
  tr: {
    name: 'Selin',
    fullName: 'Selin Kaya',
    email: 'selin@example.com',
    workspace: 'Mavi Mağaza',
    inviter: 'Ayşe Demir',
    contact: 'Deniz Yılmaz',
    contactEmail: 'deniz@example.com',
    contactPhone: '+90 532 000 00 00',
    message: 'Merhaba, geçen hafta mavi bir mont sipariş ettim ama hâlâ gelmedi.\nNerede olduğuna bakabilir misiniz?',
    you: 'Siz',
    chat: [
      ['visitor', 'Merhaba, geçen hafta mavi bir mont sipariş ettim ama hâlâ gelmedi.'],
      ['agent', 'Merhaba Deniz, beklettiğimiz için kusura bakmayın. Siparişinize hemen bakıyorum.'],
      ['agent', 'Siparişiniz dün depomuzdan çıktı, perşembeye kadar elinizde olur.'],
      ['visitor', 'Harika, teşekkürler.'],
    ],
    joined: 'Selin konuşmaya katıldı',
    subjects: ['Siparişim nerede?', 'İndirim kodu çalışmıyor', 'Teslimat adresi değişikliği'],
    plan: 'Pro',
    newPlan: 'İşletme',
    pack: 'Yapay zekâ kredi paketi',
    title: 'Daha hızlı gelen kutusu',
    body: 'Gelen kutusu artık konuşmaları daha hızlı açıyor ve geri döndüğünüzde kaldığınız yeri hatırlıyor.\nSizin bir şey değiştirmeniz gerekmiyor.',
  },
};

/** The sample workspace's address in the panel (resolveWorkspaceAppUrl's shape). */
const SAMPLE_WORKSPACE_SLUG = 'blue-store';
const SAMPLE_CONVERSATION_ID = '5b7e2c1a-9d4f-4e8b-a3c6-0f1d2e3b4c5d';
const SAMPLE_RECEIPT = 'R-7001';
const DAY_MS = 86_400_000;

export interface SampleContext {
  edition: Edition;
  locale: string;
  /** The panel's address (platform_domains.app_base_url), '' when unknown: links are then relative. */
  appUrl: string;
  /** The moment the sample is "sent" (dates are counted from it). */
  now?: Date;
}

function sampleLocale(locale: string): SampleLocale {
  const base = String(locale || '').toLowerCase().split('-')[0];
  return base === 'fa' || base === 'tr' ? base : 'en';
}

/** Persian outside the Iranian edition keeps the Gregorian calendar, as the transcript does. */
function clockLocale(edition: Edition, locale: SampleLocale): string {
  if (locale === 'fa') return edition === 'iran' ? 'fa-IR-u-ca-persian' : 'fa-IR-u-ca-gregory';
  return locale === 'tr' ? 'tr-TR' : 'en-US';
}

/** The HTML part's copy of every value, escaped, as sendBillingEmail makes it. */
function escapedCopy(data: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, escapeHtml(value)]));
}

/**
 * An amount in the edition's currency: written in cents and scaled to Rial
 * in the Iranian edition, so 2,900 is $29.00 there and 2,900,000 Toman here.
 */
function sampleMoney(ctx: Required<SampleContext>, locale: SampleLocale, cents: number): string {
  return ctx.edition === 'iran'
    ? formatBillingMoney(ctx.edition, locale, 'IRR', cents * 10_000)
    : formatBillingMoney(ctx.edition, locale, 'USD', cents);
}

/** The visitor's copy of a chat, built as visitorTranscript.ts builds it. */
function visitorTranscript(words: SampleWords, ctx: Required<SampleContext>, locale: SampleLocale) {
  const timeZone = editionDefaultTimeZone(ctx.edition);
  const tag = clockLocale(ctx.edition, locale);
  const clock = new Intl.DateTimeFormat(tag, { timeStyle: 'short', timeZone });
  const rows: string[] = [];
  const texts: string[] = [];
  words.chat.forEach(([side, text], i) => {
    const who = side === 'visitor' ? words.you : words.name;
    const meta = `${who} · ${clock.format(new Date(ctx.now.getTime() - (12 - i * 3) * 60_000))}`;
    rows.push(transcriptRow(side, meta, text));
    texts.push(`${meta}\n${text}`);
  });
  return {
    html: rows.join(''),
    text: texts.join('\n\n'),
    date: new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone }).format(ctx.now),
  };
}

type Builder = (words: SampleWords, ctx: Required<SampleContext>, locale: SampleLocale) => TemplateSample;

/** The operator notices: the payload a producer queues, through the dispatcher's own fill. */
function operatorSample(build: (words: SampleWords, ctx: Required<SampleContext>, locale: SampleLocale) => Record<string, unknown>): Builder {
  return (words, ctx, locale) => {
    const { templateData, htmlData } = templateValues(build(words, ctx, locale), words.fullName, locale);
    return { data: templateData, htmlData };
  };
}

interface BillingFormat {
  money: (cents: number) => string;
  date: (daysFromNow: number) => string;
  number: (value: number) => string;
  link: (path: string) => string;
}

/** A billing mail: the values its sender builds with the edition's formatters, plus {workspace} and {billing_url}. */
function billingSample(build: (f: BillingFormat, words: SampleWords, locale: SampleLocale) => Record<string, string>, extra: { receipt?: boolean } = {}): Builder {
  return (words, ctx, locale) => {
    const f: BillingFormat = {
      money: (cents) => sampleMoney(ctx, locale, cents),
      date: (days) => formatBillingDate(ctx.edition, locale, new Date(ctx.now.getTime() + days * DAY_MS).toISOString()),
      number: (value) => formatBillingNumber(ctx.edition, locale, value),
      link: (path) => workspaceLink(ctx, path),
    };
    const data: Record<string, string> = {
      workspace: words.workspace,
      billing_url: f.link('/billing'),
      ...build(f, words, locale),
    };
    if (extra.receipt) data.receipt_url = f.link(`/billing/receipts/${SAMPLE_RECEIPT}`);
    return { data, htmlData: escapedCopy(data) };
  };
}

function workspaceLink(ctx: Required<SampleContext>, path: string): string {
  return `${ctx.appUrl}/${SAMPLE_WORKSPACE_SLUG}${path}`;
}

const SAMPLES: Record<string, Builder> = {
  email_verify: (words, ctx, locale) => ({
    data: {
      name: words.name,
      action_url: `${ctx.appUrl}/auth/email-confirmed?token=preview`,
      email: words.email,
      ...expiryLabels(24)[locale],
    },
  }),
  password_reset: (words, ctx, locale) => ({
    data: {
      name: words.name,
      action_url: `${ctx.appUrl}/auth/reset-password?token=preview`,
      email: words.email,
      ...expiryLabels(24)[locale],
    },
  }),
  // A fixed code that no real one can be (verification/templatePreview.ts).
  verification_code: () => ({ data: { code: FAKE_PREVIEW_CODE, minutes: '10' } }),
  invite_otp: () => ({ data: { code: FAKE_PREVIEW_CODE, expiry_minutes: '10' } }),
  invite_member: (words, ctx, locale) => ({
    data: {
      name: words.name,
      workspace: words.workspace,
      inviter: words.inviter,
      role: renderRoleLabel(locale, 'agent'),
      action_url: buildInviteUrl(ctx.appUrl, 'preview', 'email_claim'),
      expiry: renderInviteExpiry(
        locale,
        new Date(ctx.now.getTime() + 7 * DAY_MS).toISOString(),
        editionDefaultTimeZone(ctx.edition),
        EDITION_PROFILE[ctx.edition].calendar,
      ),
    },
  }),
  email_test: (_words, ctx, locale) => ({
    data: testMailRequest({ slot: 'default', provider: 'smtp', at: ctx.now, edition: ctx.edition, locale }).templateData,
  }),
  visitor_conversation_transcript: (words, ctx, locale) => {
    const transcript = visitorTranscript(words, ctx, locale);
    return {
      data: {
        workspace: words.workspace,
        workspace_name: words.workspace,
        date: transcript.date,
        transcript: transcript.text,
        transcript_text: transcript.text,
      },
      htmlData: { transcript: transcript.html },
    };
  },
  // A visitor's words reach the HTML part only, escaped (offlineNotice.ts).
  offline_message_received: (words, ctx) => {
    const inbox = workspaceLink(ctx, `/inbox?c=${SAMPLE_CONVERSATION_ID}`);
    return {
      data: { conversation_id: SAMPLE_CONVERSATION_ID, action_url: inbox, contact_name: '', contact_email: '', contact_phone: '', message_body: '' },
      htmlData: {
        contact_name: escapeMailText(words.contact),
        contact_email: escapeMailText(words.contactEmail),
        contact_phone: escapeMailText(words.contactPhone),
        message_body: mailTextLines(words.message),
        action_url: escapeMailText(inbox),
      },
    };
  },
  offline_messages_summary: (_words, ctx, locale) => {
    const inbox = workspaceLink(ctx, '/inbox');
    return {
      data: {
        count: formatBillingNumber(ctx.edition, locale, 3),
        minutes: formatBillingNumber(ctx.edition, locale, OFFLINE_NOTICE_WINDOW_SECONDS / 60),
        action_url: inbox,
      },
      htmlData: { action_url: escapeMailText(inbox) },
    };
  },
  // The payloads carry numbers, as their producers queue them.
  operator_unread_digest: operatorSample((words, ctx) => ({
    count: 3,
    minutes: 15,
    workspace: words.workspace,
    list: words.subjects.join(' · '),
    action_url: workspaceLink(ctx, '/inbox'),
  })),
  operator_conversation_transcript: operatorSample((words, ctx) => ({
    subject: words.subjects[0],
    contact: words.contact,
    workspace: words.workspace,
    resolved_at: ctx.now.toISOString(),
    transcript_lines: [`· ${words.joined}`, ...words.chat.map(([side, text]) => `${side === 'visitor' ? '←' : '→'} ${text}`)],
    action_url: workspaceLink(ctx, `/inbox?c=${SAMPLE_CONVERSATION_ID}`),
  })),
  operator_invoice_paid: operatorSample((words, ctx, locale) => ({
    workspace: words.workspace,
    amount: sampleMoney(ctx, locale, 2_900),
    invoice_label: ` (${SAMPLE_RECEIPT})`,
    action_url: workspaceLink(ctx, '/billing'),
  })),
  operator_weekly_summary: operatorSample((words, ctx) => ({
    workspace: words.workspace,
    conversations: 42,
    resolved: 37,
    messages: 318,
    action_url: workspaceLink(ctx, '/inbox'),
  })),
  operator_product_update: operatorSample((words) => ({ title: words.title, body: words.body })),
  billing_renewal_reminder: billingSample((f, words, locale) => ({
    plan_name: words.plan,
    new_plan_name: `${words.plan} (${billingIntervalLabel('monthly', locale)})`,
    amount: f.money(2_900),
    balance: f.money(3_500),
    period_end: f.date(3),
    days_left: f.number(3),
  })),
  billing_renewed: billingSample((f, words) => ({
    plan_name: words.plan,
    old_plan_name: words.plan,
    amount: f.money(2_900),
    balance: f.money(600),
    period_start: f.date(0),
    period_end: f.date(30),
  })),
  billing_expired: billingSample((f, words) => ({ plan_name: words.plan, expired_at: f.date(0) })),
  billing_plan_changed: billingSample((f, words) => ({
    plan_name: words.newPlan,
    old_plan_name: words.plan,
    amount: f.money(7_900),
    balance: f.money(1_100),
    period_start: f.date(0),
    period_end: f.date(30),
  })),
  billing_change_scheduled: billingSample((f, words) => ({ plan_name: words.plan, new_plan_name: words.newPlan, effective_at: f.date(12) })),
  billing_payment_receipt: billingSample((f) => ({ receipt_number: SAMPLE_RECEIPT, amount: f.money(5_000), balance: f.money(8_500) }), { receipt: true }),
  billing_plan_activated: billingSample((f, words) => ({ plan_name: words.plan, period_end: f.date(30), amount: f.money(2_900), balance: f.money(2_100) })),
  billing_trial_ending: billingSample((f) => ({ trial_end: f.date(3), days_left: f.number(3) })),
  billing_trial_ended: billingSample(() => ({})),
  billing_card_renewed: billingSample((f, words, locale) => ({
    plan_name: words.plan,
    old_plan_name: words.plan,
    amount: f.money(2_900),
    balance: f.money(0),
    period_start: f.date(0),
    period_end: f.date(30),
    card: cardLabel('visa', '4242', locale),
  })),
  billing_card_payment_failed: billingSample((f, words, locale) => ({
    plan_name: words.plan,
    amount: f.money(2_900),
    card: cardLabel('visa', '4242', locale),
    failure_reason: failureText('card_declined', locale),
    due_at: f.date(2),
  })),
  billing_card_removed: billingSample((f, words, locale) => ({
    card: cardLabel('visa', '4242', locale),
    reason: (REMOVED_REASONS[locale] ?? REMOVED_REASONS.en).removed,
    plan_name: words.plan,
    period_end: f.date(18),
  })),
  billing_locked_data_deletion: billingSample((f, words, locale) => ({
    plan_name: words.plan,
    days_left: f.number(7),
    deletion_date: f.date(7),
    locked_summary: lockedSummary({ kb_article: 12, contact: 340 }, locale, f.number),
    // The export is on the billing page (locks/retention.ts).
    export_url: f.link('/billing'),
  })),
  billing_ai_pack_purchased: billingSample((f, words) => ({
    pack_name: words.pack,
    credit: f.money(1_000),
    amount: f.money(1_000),
    balance: f.money(2_400),
    ai_balance: f.money(1_250),
  })),
};

/**
 * The values a template of `slug` is filled with in Super Admin's preview and
 * test, in `locale` and the edition's own way (Toman and the Persian calendar
 * in the Iranian edition): exactly the keys its sender fills, built as the
 * sender builds them. A legacy or unknown slug gets nothing: only the core's
 * values, so the rest of its placeholders show as written.
 */
export function sampleTemplateData(slug: string, context: SampleContext): TemplateSample {
  const build = isSentTemplate(slug) ? SAMPLES[slug] : undefined;
  if (!build) return { data: {} };
  const ctx: Required<SampleContext> = { ...context, appUrl: context.appUrl.replace(/\/+$/, ''), now: context.now ?? new Date() };
  const locale = sampleLocale(context.locale);
  return build(WORDS[locale], ctx, locale);
}
