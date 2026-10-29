/**
 * ONE CLICK, AND THIS KIND OF MAIL STOPS.
 *
 * Every operator notification email (the digest, a transcript, a payment
 * notice, the weekly summary, an announcement) is mail a person can decline,
 * so every one carries a way to decline it without signing in:
 *
 *   - `List-Unsubscribe` with its one-click partner (RFC 8058, added by the
 *     email core from EmailRequest.listUnsubscribe): the mailbox's own
 *     "Unsubscribe" button POSTs to the link, and that type is off;
 *   - a visible line under the mail's own text, in the recipient's language,
 *     with the same link, which opens a page that asks before it turns
 *     anything off (a link scanner that follows it changes nothing).
 *
 * The link carries a token, not a session: the user, the one type it turns
 * off, and when it stops working (180 days: long enough for a mail kept in
 * an archive, never forever), signed with a key derived from the server's
 * own signing secret (PLATFORM_SIGNING_SECRET, lib/platformSecret.ts) and
 * nothing new. It can only turn that one type off for that one person, which
 * is what the person holding the mail may do anyway.
 *
 * The words are a copy of the dashboard's (`notifications.*` in
 * src/i18n/locales/{fa,en,tr}.ts), which the server image does not carry, as
 * operatorSystemText.ts does: src/test/notifications/unsubscribeCopy.test.ts
 * holds them equal.
 */
import crypto from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { platformSigningSecret } from '../../lib/platformSecret.js';
import { resolveApiBaseUrl } from '../calls/rtcResolver.js';
import type { OperatorLocale } from '../operatorLocale.js';
import { isNotificationEmailType, type NotificationEmailType } from './types.js';

/** Where the link points, under the API's own base. */
export const UNSUBSCRIBE_PATH = '/api/notifications/email/unsubscribe';

/** How long a link works. */
export const UNSUBSCRIBE_TOKEN_TTL_MS = 180 * 24 * 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token key: the signing secret's, derived for this one use; null without a secret. */
function tokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const root = platformSigningSecret(env);
  if (!root) return null;
  return crypto.createHash('sha256').update(`notification-email-unsubscribe:${root}`).digest();
}

function signature(key: Buffer, body: string): string {
  return crypto.createHmac('sha256', key).update(body).digest('base64url');
}

/** A link's token for this user and type, or null when the server has no signing secret. */
export function signUnsubscribeToken(
  userId: string,
  type: NotificationEmailType,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const key = tokenKey(env);
  if (!key || !UUID.test(userId)) return null;
  const expires = Math.floor((now.getTime() + UNSUBSCRIBE_TOKEN_TTL_MS) / 1000);
  const body = Buffer.from(JSON.stringify({ v: 1, u: userId, t: type, x: expires })).toString('base64url');
  return `${body}.${signature(key, body)}`;
}

export type UnsubscribeTokenCheck =
  | { ok: true; userId: string; type: NotificationEmailType }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'unavailable' };

/** What a token says, once its signature and its date hold. */
export function verifyUnsubscribeToken(
  token: unknown,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): UnsubscribeTokenCheck {
  const key = tokenKey(env);
  if (!key) return { ok: false, reason: 'unavailable' };
  if (typeof token !== 'string' || token.length > 512) return { ok: false, reason: 'malformed' };
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(signature(key, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'signature' };
  }

  let claims: { v?: unknown; u?: unknown; t?: unknown; x?: unknown };
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.v !== 1 || typeof claims.u !== 'string' || !UUID.test(claims.u) || !isNotificationEmailType(claims.t)) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.x !== 'number' || claims.x * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, userId: claims.u, type: claims.t };
}

/**
 * The API's https base for the links, or null when there is none: the core
 * leaves out a List-Unsubscribe that is not https, and the visible line then
 * points at the settings page instead.
 */
export async function unsubscribeBaseUrl(config: ServerConfig): Promise<string | null> {
  try {
    const base = await resolveApiBaseUrl(config);
    if (!base) return null;
    const url = new URL(base);
    return url.protocol === 'https:' ? url.origin + url.pathname.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/** The one-click link for this user and type under `base`, or null. */
export function unsubscribeUrl(base: string | null, userId: string, type: NotificationEmailType): string | null {
  if (!base) return null;
  const token = signUnsubscribeToken(userId, type);
  return token ? `${base}${UNSUBSCRIBE_PATH}/${token}` : null;
}

// ─── The words ────────────────────────────────────────────────────────────

/** Each type's name, as the operator's own settings page shows it. */
const TYPE_LABEL_KEYS: Record<NotificationEmailType, string> = {
  unread_messages: 'notifications.emailUnreadMessages',
  transcripts: 'notifications.emailTranscripts',
  paid_invoices: 'notifications.emailPaidInvoices',
  weekly_summary: 'notifications.emailWeeklySummary',
  product_updates: 'notifications.emailProductUpdates',
};

export const UNSUBSCRIBE_STRINGS: Record<OperatorLocale, Record<string, string>> = {
  fa: {
    'notifications.emailUnreadMessages': 'گفتگوهایی که هنوز منتظرند',
    'notifications.emailTranscripts': 'متن گفتگوهایی که خودم رسیدگی کردم',
    'notifications.emailPaidInvoices': 'پرداخت‌های دریافت‌شده',
    'notifications.emailWeeklySummary': 'خلاصه‌ی هفتگی',
    'notifications.emailProductUpdates': 'اعلان‌های محصول',
    'notifications.emailFooter': 'این ایمیل را دریافت می‌کنید چون «{{label}}» در اعلان‌های ایمیلی شما روشن است.',
    'notifications.emailFooterUnsubscribe': 'لغو اشتراک',
    'notifications.emailFooterSettings': 'تغییر اعلان‌های ایمیلی',
    'notifications.emailUnsubscribeTitle': 'اعلان‌های ایمیلی',
    'notifications.emailUnsubscribeQuestion': 'ایمیل‌های «{{label}}» دیگر فرستاده نشود؟',
    'notifications.emailUnsubscribeConfirm': 'لغو اشتراک',
    'notifications.emailUnsubscribeDone': 'انجام شد. دیگر ایمیل «{{label}}» برایتان فرستاده نمی‌شود.',
    'notifications.emailUnsubscribeInvalid': 'این پیوند منقضی شده یا معتبر نیست. اعلان‌های ایمیلی را می‌توانید در تنظیمات تغییر دهید.',
    'notifications.emailUnsubscribeFailed': 'انجام نشد. چند دقیقه‌ی دیگر دوباره امتحان کنید.',
  },
  en: {
    'notifications.emailUnreadMessages': 'Conversations still waiting',
    'notifications.emailTranscripts': 'Transcripts of conversations I handled',
    'notifications.emailPaidInvoices': 'Payments received',
    'notifications.emailWeeklySummary': 'A weekly summary',
    'notifications.emailProductUpdates': 'Product announcements',
    'notifications.emailFooter': 'You get this email because “{{label}}” is on in your email notifications.',
    'notifications.emailFooterUnsubscribe': 'Unsubscribe',
    'notifications.emailFooterSettings': 'Change your email notifications',
    'notifications.emailUnsubscribeTitle': 'Email notifications',
    'notifications.emailUnsubscribeQuestion': 'Stop “{{label}}” emails?',
    'notifications.emailUnsubscribeConfirm': 'Unsubscribe',
    'notifications.emailUnsubscribeDone': 'Done. You will not get “{{label}}” emails any more.',
    'notifications.emailUnsubscribeInvalid': 'This link has expired or is not valid. You can change your email notifications in your settings.',
    'notifications.emailUnsubscribeFailed': 'That did not work. Please try again in a few minutes.',
  },
  tr: {
    'notifications.emailUnreadMessages': 'Hâlâ bekleyen sohbetler',
    'notifications.emailTranscripts': 'İlgilendiğim sohbetlerin dökümü',
    'notifications.emailPaidInvoices': 'Alınan ödemeler',
    'notifications.emailWeeklySummary': 'Haftalık özet',
    'notifications.emailProductUpdates': 'Ürün duyuruları',
    'notifications.emailFooter': 'Bu e-postayı, e-posta bildirimlerinizde “{{label}}” açık olduğu için alıyorsunuz.',
    'notifications.emailFooterUnsubscribe': 'Abonelikten çık',
    'notifications.emailFooterSettings': 'E-posta bildirimlerini değiştir',
    'notifications.emailUnsubscribeTitle': 'E-posta bildirimleri',
    'notifications.emailUnsubscribeQuestion': '“{{label}}” e-postaları durdurulsun mu?',
    'notifications.emailUnsubscribeConfirm': 'Abonelikten çık',
    'notifications.emailUnsubscribeDone': 'Tamam. Artık “{{label}}” e-postaları gönderilmeyecek.',
    'notifications.emailUnsubscribeInvalid': 'Bu bağlantının süresi dolmuş ya da geçersiz. E-posta bildirimlerinizi ayarlardan değiştirebilirsiniz.',
    'notifications.emailUnsubscribeFailed': 'Olmadı. Lütfen birkaç dakika sonra yeniden deneyin.',
  },
};

/** One string in `locale`, its {{label}} filled in. */
export function unsubscribeText(locale: OperatorLocale, key: string, type?: NotificationEmailType): string {
  const strings = UNSUBSCRIBE_STRINGS[locale] ?? UNSUBSCRIBE_STRINGS.en;
  const text = strings[`notifications.${key}`] ?? UNSUBSCRIBE_STRINGS.en[`notifications.${key}`] ?? '';
  const label = type ? strings[TYPE_LABEL_KEYS[type]] ?? '' : '';
  return text.replace(/\{\{label\}\}/g, () => label);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The visible line under a notification email, in the recipient's
 * language: why it came, and the link that stops this type (else the
 * operator's settings page, when there is no https link to give).
 */
export function notificationFooter(
  locale: OperatorLocale,
  type: NotificationEmailType,
  links: { unsubscribe: string | null; settings: string | null },
): { html: string; text: string } {
  const why = unsubscribeText(locale, 'emailFooter', type);
  const target = links.unsubscribe ?? links.settings;
  const action = unsubscribeText(locale, links.unsubscribe ? 'emailFooterUnsubscribe' : 'emailFooterSettings');
  const dir = locale === 'fa' ? 'rtl' : 'ltr';
  const style = 'margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.6';
  const link = target ? ` <a href="${escapeHtml(target)}" style="color:#6b7280">${escapeHtml(action)}</a>` : '';
  return {
    html: `<p dir="${dir}" style="${style}">${escapeHtml(why)}${link}</p>`,
    text: target ? `${why}\n${action}: ${target}` : why,
  };
}
