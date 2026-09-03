/**
 * Generic Verification Core v1 — fa/tr/en email + SMS templates.
 *
 * Compiled-in (not DB rows), mirroring Workspace Invitations v5.1's own
 * `notificationTemplates.ts` rationale: keeps translation completeness
 * statically verifiable (src/test/verification/templateCompleteness.test.ts)
 * without depending on a `email_templates` DB row existing for every
 * locale. NOT wired to any consumer — nothing in this codebase renders or
 * sends these yet.
 */
import type { VerificationLocale } from './types.js';

export interface RenderedMessage {
  subject?: string; // SMS has none
  text: string;
  html?: string;    // SMS has none
}

const DIRECTION: Record<VerificationLocale, 'rtl' | 'ltr'> = { fa: 'rtl', tr: 'ltr', en: 'ltr' };

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrapHtml(locale: VerificationLocale, inner: string): string {
  const dir = DIRECTION[locale];
  return `<!doctype html><html lang="${locale}" dir="${dir}"><body style="font-family:sans-serif;direction:${dir}">${inner}</body></html>`;
}

const EMAIL_OTP: Record<VerificationLocale, (code: string, minutes: number) => RenderedMessage> = {
  fa: (code, minutes) => ({
    subject: 'کد تأیید شما',
    text: `کد تأیید: ${code}\nاین کد تا ${minutes} دقیقه دیگر معتبر است.`,
    html: wrapHtml('fa', `<p>کد تأیید شما: <b>${esc(code)}</b></p><p>این کد تا ${minutes} دقیقه دیگر معتبر است.</p>`),
  }),
  tr: (code, minutes) => ({
    subject: 'Doğrulama kodunuz',
    text: `Doğrulama kodu: ${code}\nBu kod ${minutes} dakika geçerlidir.`,
    html: wrapHtml('tr', `<p>Doğrulama kodunuz: <b>${esc(code)}</b></p><p>Bu kod ${minutes} dakika geçerlidir.</p>`),
  }),
  en: (code, minutes) => ({
    subject: 'Your verification code',
    text: `Verification code: ${code}\nThis code expires in ${minutes} minutes.`,
    html: wrapHtml('en', `<p>Your verification code: <b>${esc(code)}</b></p><p>This code expires in ${minutes} minutes.</p>`),
  }),
};

const SMS_OTP: Record<VerificationLocale, (code: string, minutes: number) => RenderedMessage> = {
  fa: (code, minutes) => ({ text: `کد تأیید: ${code} (تا ${minutes} دقیقه معتبر)` }),
  tr: (code, minutes) => ({ text: `Doğrulama kodu: ${code} (${minutes} dk geçerli)` }),
  en: (code, minutes) => ({ text: `Verification code: ${code} (valid ${minutes} min)` }),
};

export function renderOtpEmail(locale: VerificationLocale, code: string, ttlSeconds: number): RenderedMessage {
  return EMAIL_OTP[locale](code, Math.round(ttlSeconds / 60));
}

export function renderOtpSms(locale: VerificationLocale, code: string, ttlSeconds: number): RenderedMessage {
  return SMS_OTP[locale](code, Math.round(ttlSeconds / 60));
}

export const SUPPORTED_TEMPLATE_LOCALES: readonly VerificationLocale[] = ['fa', 'tr', 'en'];
