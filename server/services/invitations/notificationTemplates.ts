/**
 * WORKSPACE INVITATIONS v5.1 — server-side notification localization.
 *
 * Single source of truth for every user-facing string the invitation worker
 * sends. Persian (fa), Turkish (tr) and English (en) are all first-class:
 * there is no English fallback body, only an English TEMPLATE selected when
 * the resolved locale is `en` (or unknown, per the documented last-resort).
 *
 * Locale resolution never inspects Accept-Language. The worker uses the
 * locale that was resolved and persisted at invitation creation time.
 */

export type NotificationLocale = 'fa' | 'tr' | 'en';

export const SUPPORTED_NOTIFICATION_LOCALES: NotificationLocale[] = ['fa', 'tr', 'en'];
export const LAST_RESORT_NOTIFICATION_LOCALE: NotificationLocale = 'en';

/** Validate/normalize an arbitrary locale value to a supported locale. */
export function normalizeNotificationLocale(value: unknown): NotificationLocale {
  const tag = String(value ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_NOTIFICATION_LOCALES as string[]).includes(tag)
    ? (tag as NotificationLocale)
    : LAST_RESORT_NOTIFICATION_LOCALE;
}

export const NOTIFICATION_DIRECTION: Record<NotificationLocale, 'rtl' | 'ltr'> = {
  fa: 'rtl',
  tr: 'ltr',
  en: 'ltr',
};

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[c] || c);
}

function wrap(locale: NotificationLocale, inner: string): string {
  const dir = NOTIFICATION_DIRECTION[locale];
  return `<div dir="${dir}" lang="${locale}" style="font-family:system-ui,sans-serif">${inner}</div>`;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

// ── OTP e-mail ────────────────────────────────────────────────────────────

const OTP: Record<NotificationLocale, (code: string, minutes: number) => RenderedEmail> = {
  fa: (code, minutes) => ({
    subject: 'کد تأیید شما',
    text: `کد تأیید: ${code}\nاین کد تا ${minutes} دقیقه دیگر معتبر است.`,
    html: wrap('fa', `<p>کد تأیید: <strong>${esc(code)}</strong></p><p>این کد تا ${minutes} دقیقه دیگر معتبر است.</p>`),
  }),
  tr: (code, minutes) => ({
    subject: 'Doğrulama kodunuz',
    text: `Doğrulama kodu: ${code}\nBu kodun geçerlilik süresi ${minutes} dakikadır.`,
    html: wrap('tr', `<p>Doğrulama kodu: <strong>${esc(code)}</strong></p><p>Bu kodun geçerlilik süresi ${minutes} dakikadır.</p>`),
  }),
  en: (code, minutes) => ({
    subject: 'Your verification code',
    text: `Verification code: ${code}\nIt expires in ${minutes} minutes.`,
    html: wrap('en', `<p>Verification code: <strong>${esc(code)}</strong></p><p>It expires in ${minutes} minutes.</p>`),
  }),
};

export function renderOtpEmail(locale: unknown, code: string, minutes = 10): RenderedEmail {
  return OTP[normalizeNotificationLocale(locale)](code, minutes);
}

// ── Invitation e-mail ─────────────────────────────────────────────────────

export interface InviteEmailInput {
  firstName: string;
  workspaceName: string;
  link: string;
  /** ISO instant; rendered in the recipient locale's calendar. */
  expiresAt?: string | null;
  /** IANA timezone of the workspace/site; the environment zone when absent. */
  timeZone?: string | null;
}

const CALENDAR_TAG: Record<NotificationLocale, string> = {
  fa: 'fa-IR-u-ca-persian',
  tr: 'tr-TR',
  en: 'en-US',
};

/**
 * Locale-correct expiry wording. The CALENDAR follows the locale (Jalali for
 * Persian); the CLOCK follows the configured timezone, never the language.
 */
export function formatExpiry(locale: unknown, iso?: string | null, timeZone?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tag = CALENDAR_TAG[normalizeNotificationLocale(locale)];
  try {
    return new Intl.DateTimeFormat(tag, {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

export function renderInviteEmail(locale: unknown, input: InviteEmailInput): RenderedEmail {
  const lc = normalizeNotificationLocale(locale);
  const expiry = formatExpiry(lc, input.expiresAt, input.timeZone);
  const name = input.firstName;
  const ws = input.workspaceName;
  const link = input.link;

  if (lc === 'fa') {
    return {
      subject: `دعوت به ${ws}`,
      text: `سلام ${name}،\n\nشما برای پیوستن به «${ws}» دعوت شده‌اید.\nبرای پذیرش دعوت این پیوند را باز کنید:\n${link}\n`
        + (expiry ? `\nاعتبار این دعوت تا ${expiry} است.\n` : ''),
      html: wrap('fa',
        `<p>سلام ${esc(name)}،</p>`
        + `<p>شما برای پیوستن به <strong>${esc(ws)}</strong> دعوت شده‌اید.</p>`
        + `<p><a href="${esc(link)}">پذیرش دعوت</a></p>`
        + (expiry ? `<p>اعتبار این دعوت تا ${esc(expiry)} است.</p>` : '')),
    };
  }
  if (lc === 'tr') {
    return {
      subject: `${ws} ekibine davet edildiniz`,
      text: `Merhaba ${name},\n\n"${ws}" ekibine katılmaya davet edildiniz.\nKabul etmek için bu bağlantıyı açın:\n${link}\n`
        + (expiry ? `\nBu davet ${expiry} tarihine kadar geçerlidir.\n` : ''),
      html: wrap('tr',
        `<p>Merhaba ${esc(name)},</p>`
        + `<p><strong>${esc(ws)}</strong> ekibine katılmaya davet edildiniz.</p>`
        + `<p><a href="${esc(link)}">Daveti kabul et</a></p>`
        + (expiry ? `<p>Bu davet ${esc(expiry)} tarihine kadar geçerlidir.</p>` : '')),
    };
  }
  return {
    subject: `You are invited to ${ws}`,
    text: `Hello ${name},\n\nYou were invited to join ${ws}.\nOpen this link to accept:\n${link}\n`
      + (expiry ? `\nThis invitation is valid until ${expiry}.\n` : ''),
    html: wrap('en',
      `<p>Hello ${esc(name)},</p>`
      + `<p>You were invited to join <strong>${esc(ws)}</strong>.</p>`
      + `<p><a href="${esc(link)}">Accept the invitation</a></p>`
      + (expiry ? `<p>This invitation is valid until ${esc(expiry)}.</p>` : '')),
  };
}

// ── Invitation SMS (never carries a token) ────────────────────────────────

export function renderInviteSms(locale: unknown, workspaceName: string, email: string): string {
  switch (normalizeNotificationLocale(locale)) {
    case 'fa':
      return `${workspaceName}: برای عضویت در تیم دعوت شده‌اید. برای پذیرش، ایمیل ${email} را بررسی کنید.`;
    case 'tr':
      return `${workspaceName}: ekibe davet edildiniz. Kabul etmek için ${email} e-postasını kontrol edin.`;
    default:
      return `${workspaceName}: you were invited to join the team. Check your email (${email}) to accept.`;
  }
}

// ── Provider-failure wording shown to owners ──────────────────────────────

export type DeliveryFailureCode =
  | 'EMAIL_PROVIDER_UNCONFIGURED'
  | 'EMAIL_SEND_FAILED'
  | 'OTP_SEND_FAILED'
  | 'SMS_SEND_FAILED'
  | 'DERIVATION_KEY_UNAVAILABLE';

const FAILURES: Record<NotificationLocale, Record<DeliveryFailureCode, string>> = {
  fa: {
    EMAIL_PROVIDER_UNCONFIGURED: 'ارائه‌دهنده ایمیل پیکربندی نشده است؛ دعوت ارسال نشد.',
    EMAIL_SEND_FAILED: 'ارسال ایمیل دعوت ناموفق بود.',
    OTP_SEND_FAILED: 'ارسال کد تأیید ناموفق بود.',
    SMS_SEND_FAILED: 'ارسال پیامک اطلاع‌رسانی ناموفق بود.',
    DERIVATION_KEY_UNAVAILABLE: 'کلید امنیتی در دسترس نیست؛ پیوند دعوت ساخته نشد.',
  },
  tr: {
    EMAIL_PROVIDER_UNCONFIGURED: 'E-posta sağlayıcısı yapılandırılmadı; davet gönderilemedi.',
    EMAIL_SEND_FAILED: 'Davet e-postası gönderilemedi.',
    OTP_SEND_FAILED: 'Doğrulama kodu gönderilemedi.',
    SMS_SEND_FAILED: 'Bilgilendirme SMS’i gönderilemedi.',
    DERIVATION_KEY_UNAVAILABLE: 'Güvenlik anahtarı kullanılamıyor; davet bağlantısı oluşturulamadı.',
  },
  en: {
    EMAIL_PROVIDER_UNCONFIGURED: 'No email provider is configured; the invitation was not sent.',
    EMAIL_SEND_FAILED: 'The invitation email could not be sent.',
    OTP_SEND_FAILED: 'The verification code could not be sent.',
    SMS_SEND_FAILED: 'The notification SMS could not be sent.',
    DERIVATION_KEY_UNAVAILABLE: 'The security key is unavailable; no invitation link was created.',
  },
};

/** Localized, provider-detail-free failure wording for the owner surface. */
export function renderDeliveryFailure(locale: unknown, code: DeliveryFailureCode): string {
  return FAILURES[normalizeNotificationLocale(locale)][code]
    ?? FAILURES[LAST_RESORT_NOTIFICATION_LOCALE][code];
}
