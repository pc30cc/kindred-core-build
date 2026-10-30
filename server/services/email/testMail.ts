/**
 * The test mail (template `email_test`): what Super Admin → Providers →
 * Email's "Send test email" fills it with. It is the platform's own test (it
 * names that menu and the provider), never a workspace's.
 *
 *   {provider}  the provider that sends it (smtp, resend, sendgrid);
 *   {slot}      which of the platform's providers that is, in words;
 *   {sent_at}   when, as the reader's calendar and clock say it.
 *
 * {slot} and {sent_at} are words, so each language gets its own
 * (EmailRequest.localizedData): the template is chosen at send time and may
 * not be in the language asked for. The compiled text below is only what is
 * sent if the template itself is missing; the layout wraps it like any mail.
 */
import { editionDefaultTimeZone, type Edition } from '../../../shared/edition.js';

export type TestMailSlot = 'default' | 'notification';
type TestMailLocale = 'en' | 'fa' | 'tr';

const LOCALES: readonly TestMailLocale[] = ['en', 'fa', 'tr'];

const SLOT_LABELS: Record<TestMailLocale, Record<TestMailSlot, string>> = {
  en: { default: 'the platform email provider', notification: 'the notification email provider' },
  fa: { default: 'سرویس ایمیل پلتفرم', notification: 'سرویس ایمیل اعلان‌ها' },
  tr: { default: 'platform e-posta sağlayıcısı', notification: 'bildirim e-posta sağlayıcısı' },
};

/** The fallback, in the admin's own language (fa/en/tr), as plain as the rest of the platform's mail. */
const FALLBACK: Record<TestMailLocale, { subject: string; body: (slot: string, provider: string, at: string) => string }> = {
  en: {
    subject: 'Test email',
    body: (slot, provider, at) => `This test email was sent from Super Admin → Providers → Email through ${slot} (${provider}) at ${at}.\n\nIf you can read it, the provider delivered it. Nothing else needs to be done.`,
  },
  fa: {
    subject: 'ایمیل آزمایشی',
    body: (slot, provider, at) => `این ایمیل آزمایشی از سوپر ادمین ← سرویس‌دهنده‌ها ← ایمیل، با ${slot} (${provider}) در ${at} فرستاده شد.\n\nاگر آن را می‌خوانید، سرویس آن را رسانده است. کار دیگری لازم نیست.`,
  },
  tr: {
    subject: 'Test e-postası',
    body: (slot, provider, at) => `Bu test e-postası Süper Yönetici → Sağlayıcılar → E-posta bölümünden ${slot} (${provider}) ile ${at} tarihinde gönderildi.\n\nOkuyabiliyorsanız sağlayıcı teslim etti. Başka bir şey yapmanız gerekmiyor.`,
  },
};

/**
 * A moment as a reader in that language reads it: the Persian calendar in a
 * Persian mail of the Iranian edition (the Gregorian one in the
 * International edition's), the edition's clock (Tehran, else UTC), and the
 * zone said, so nobody has to guess it.
 */
export function formatSentAt(at: Date, locale: string, edition: Edition | null): string {
  const tag = locale === 'fa' ? (edition === 'international' ? 'fa-IR-u-ca-gregory' : 'fa-IR-u-ca-persian') : locale === 'tr' ? 'tr-TR' : 'en-US';
  try {
    return new Intl.DateTimeFormat(tag, {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: editionDefaultTimeZone(edition ?? 'international'), timeZoneName: 'short',
    }).format(at);
  } catch {
    return at.toISOString();
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/**
 * Everything a test send passes to the email core: the template's values
 * (the language-free one in templateData, the words per language in
 * localizedData) and the fallback in the admin's own language.
 */
export function testMailRequest(input: {
  slot: TestMailSlot;
  provider: string;
  at: Date;
  edition: Edition | null;
  locale: string;
}): {
  templateSlug: 'email_test';
  templateData: Record<string, string>;
  localizedData: Record<string, Record<string, string>>;
  subject: string;
  text: string;
  html: string;
} {
  const own = (LOCALES as readonly string[]).includes(input.locale) ? (input.locale as TestMailLocale) : 'en';
  const localizedData = Object.fromEntries(
    LOCALES.map((lc) => [lc, { slot: SLOT_LABELS[lc][input.slot], sent_at: formatSentAt(input.at, lc, input.edition) }]),
  );
  const copy = FALLBACK[own];
  const text = copy.body(SLOT_LABELS[own][input.slot], input.provider, localizedData[own].sent_at);
  return {
    templateSlug: 'email_test',
    templateData: { provider: input.provider, ...localizedData[own] },
    localizedData,
    subject: copy.subject,
    text,
    html: text.split('\n\n').map((p) => `<p>${escapeHtml(p)}</p>`).join(''),
  };
}
