/**
 * Section E — server-side notification localization guard.
 *
 * The invitation worker must never contain a hardcoded user-facing string:
 * every subject/body/SMS/failure message comes from the fa/tr/en template
 * module, and each template family must exist in all three languages.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  renderOtpEmail,
  renderInviteEmail,
  renderInviteSms,
  renderDeliveryFailure,
  normalizeNotificationLocale,
  SUPPORTED_NOTIFICATION_LOCALES,
} from '../../server/services/invitations/notificationTemplates';

const WORKER = readFileSync('server/services/invitations/worker.ts', 'utf8');

const FORBIDDEN = [
  'Your verification code',
  'Verification code:',
  'You are invited to',
  'You were invited to join',
  'Accept the invitation',
  'no email provider configured',
  'send failed',
];

describe('invitation worker has no hardcoded user-facing text', () => {
  for (const needle of FORBIDDEN) {
    it(`does not contain "${needle}"`, () => {
      expect(WORKER.includes(needle)).toBe(false);
    });
  }

  it('uses the localized template module', () => {
    expect(WORKER).toMatch(/from '\.\/notificationTemplates\.js'/);
    expect(WORKER).toMatch(/renderOtpEmail\(/);
    expect(WORKER).toMatch(/renderInviteEmail\(/);
    expect(WORKER).toMatch(/renderInviteSms\(/);
    expect(WORKER).toMatch(/renderDeliveryFailure\(/);
    expect(WORKER).toMatch(/templateSlug:\s*'invite_member'/);
    expect(WORKER).toMatch(/templateSlug:\s*'invite_otp'/);
  });
});

describe('every notification exists in fa, tr and en', () => {
  for (const locale of SUPPORTED_NOTIFICATION_LOCALES) {
    it(`${locale} OTP email is complete and distinct`, () => {
      const mail = renderOtpEmail(locale, '123456');
      expect(mail.subject.trim().length).toBeGreaterThan(3);
      expect(mail.text).toContain('123456');
      expect(mail.html).toContain(`lang="${locale}"`);
      expect(mail.html).toContain(locale === 'fa' ? 'dir="rtl"' : 'dir="ltr"');
    });

    it(`${locale} invitation email is complete`, () => {
      const mail = renderInviteEmail(locale, {
        firstName: 'Ali',
        workspaceName: 'Acme',
        link: 'https://example.test/invite',
        expiresAt: '2026-01-01T10:00:00Z',
        timeZone: 'Europe/Istanbul',
      });
      expect(mail.subject).toContain('Acme');
      expect(mail.text).toContain('https://example.test/invite');
      expect(mail.html).toContain(locale === 'fa' ? 'dir="rtl"' : 'dir="ltr"');
    });

    it(`${locale} SMS carries no token`, () => {
      const sms = renderInviteSms(locale, 'Acme', 'a@b.test');
      expect(sms).toContain('Acme');
      expect(sms).not.toMatch(/token|#token|https?:\/\//i);
    });

    it(`${locale} provider-failure messages are localized`, () => {
      const msg = renderDeliveryFailure(locale, 'EMAIL_PROVIDER_UNCONFIGURED');
      expect(msg.trim().length).toBeGreaterThan(5);
      if (locale === 'fa') expect(msg).toMatch(/[\u0600-\u06FF]/);
      if (locale === 'en') expect(msg).toMatch(/email provider/i);
    });
  }

  it('the Persian and Turkish bodies are never the English body', () => {
    const en = renderInviteEmail('en', { firstName: 'A', workspaceName: 'W', link: 'L' });
    for (const locale of ['fa', 'tr'] as const) {
      const other = renderInviteEmail(locale, { firstName: 'A', workspaceName: 'W', link: 'L' });
      expect(other.text).not.toEqual(en.text);
      expect(other.subject).not.toEqual(en.subject);
    }
  });

  it('unsupported or absent locales resolve to the documented last resort', () => {
    expect(normalizeNotificationLocale(undefined)).toBe('en');
    expect(normalizeNotificationLocale('de')).toBe('en');
    expect(normalizeNotificationLocale('fa-IR')).toBe('fa');
    expect(normalizeNotificationLocale('TR')).toBe('tr');
  });
});

describe('calendar and timezone are independent', () => {
  it('Persian uses the Jalali calendar but honours the given timezone', () => {
    const istanbul = renderInviteEmail('fa', {
      firstName: 'A', workspaceName: 'W', link: 'L',
      expiresAt: '2026-01-01T10:00:00Z', timeZone: 'Europe/Istanbul',
    }).text;
    const tehran = renderInviteEmail('fa', {
      firstName: 'A', workspaceName: 'W', link: 'L',
      expiresAt: '2026-01-01T10:00:00Z', timeZone: 'Asia/Tehran',
    }).text;
    // Same instant, Jalali calendar in both, but different wall clocks.
    expect(istanbul).not.toEqual(tehran);
  });
});
