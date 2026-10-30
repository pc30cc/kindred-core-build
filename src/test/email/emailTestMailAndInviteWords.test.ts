// @vitest-environment node
/**
 * The values two senders fill that depend on the language of the mail:
 *
 *   - the test mail (template `email_test`, server/services/email/testMail.ts)
 *     that Super Admin → Providers → Email and a workspace's test button send:
 *     {provider}, and {slot} and {sent_at} in every language, with the
 *     compiled text only for a missing template;
 *   - the invitation's {role} (server/services/invitations/
 *     notificationTemplates.ts), the role's name as the panel shows it in
 *     each language, never the key; and its {expiry}, the end date, or the
 *     panel's words for an invitation that never expires (which is stored a
 *     century ahead), never a date in 2126.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { formatSentAt, testMailRequest } from '../../../server/services/email/testMail';
import { renderInviteExpiry, renderRoleLabel } from '../../../server/services/invitations/notificationTemplates';

const AT = new Date('2026-10-30T10:24:00Z');

describe('the test mail', () => {
  it('is the email_test template, with the provider, and the slot and time in every language', () => {
    const mail = testMailRequest({ slot: 'notification', provider: 'smtp', at: AT, edition: 'iran', locale: 'fa' });
    expect(mail.templateSlug).toBe('email_test');
    expect(mail.templateData.provider).toBe('smtp');
    expect(Object.keys(mail.localizedData).sort()).toEqual(['en', 'fa', 'tr']);
    expect(mail.localizedData.fa.slot).toBe('سرویس ایمیل اعلان‌ها');
    expect(mail.localizedData.en.slot).toBe('the notification email provider');
    expect(mail.localizedData.tr.slot).toBe('bildirim e-posta sağlayıcısı');
    // The Iranian edition: the Persian calendar and Tehran's clock, the zone said.
    expect(mail.localizedData.fa.sent_at).toContain('۱۴۰۵');
    expect(mail.localizedData.fa.sent_at).toContain('۱۳:۵۴');
    expect(mail.localizedData.en.sent_at).toContain('01:54 PM');
    // The fallback is in the admin's own language and says the same.
    expect(mail.subject).toBe('ایمیل آزمایشی');
    expect(mail.text).toContain('سرویس ایمیل اعلان‌ها (smtp)');
    expect(mail.html).toBe(mail.text.split('\n\n').map((p) => `<p>${p}</p>`).join(''));
  });

  it('the International edition counts in the Gregorian calendar and UTC', () => {
    expect(formatSentAt(AT, 'fa', 'international')).toContain('۲۰۲۶');
    expect(formatSentAt(AT, 'en', 'international')).toBe('October 30, 2026 at 10:24 AM UTC');
    expect(formatSentAt(AT, 'tr', null)).toContain('30 Ekim 2026');
  });

  it('a value a provider name could hold is escaped in the fallback\'s HTML', () => {
    const mail = testMailRequest({ slot: 'default', provider: '<b>x</b>', at: AT, edition: 'international', locale: 'en' });
    expect(mail.html).toContain('(&lt;b&gt;x&lt;/b&gt;)');
    expect(mail.text).toContain('(<b>x</b>)');
  });

  it('both test buttons send it through the template, never a bare body', () => {
    for (const file of ['server/routes/adminEmailProviders.ts', 'server/routes/email.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toMatch(/testMailRequest\(\{/);
      expect(source, file).not.toMatch(/html: `<div dir=/);
    }
  });
});

describe('the invitation\'s role and end date', () => {
  const panel = { en, fa, tr } as unknown as Record<'en' | 'fa' | 'tr', { invitations: { roles: Record<string, string> } }>;

  it.each(['en', 'fa', 'tr'] as const)('%s: every role as the panel names it', (locale) => {
    for (const [role, label] of Object.entries(panel[locale].invitations.roles)) {
      expect(renderRoleLabel(locale, role), `${locale} ${role}`).toBe(label);
    }
  });

  it('an unknown role shows as it is; an unknown language reads English', () => {
    expect(renderRoleLabel('fa', 'custom_role')).toBe('custom_role');
    expect(renderRoleLabel('de', 'agent')).toBe('Operator');
  });

  it('the end date in the reader\'s calendar, or that there is none', () => {
    expect(renderInviteExpiry('fa', '2026-11-06T10:00:00Z', 'UTC', 'jalali', AT)).toContain('۱۴۰۵');
    expect(renderInviteExpiry('en', null)).toBe('No expiry');
    expect(renderInviteExpiry('tr', 'not a date')).toBe('Süresiz');
  });

  it.each(['en', 'fa', 'tr'] as const)('%s: an invitation that never expires (stored a century ahead) says so in the panel\'s words', (locale) => {
    const words = (panel[locale] as unknown as { invitations: { noExpiry: string } }).invitations.noExpiry;
    const century = new Date(AT.getTime() + 100 * 365 * 24 * 3600 * 1000).toISOString();
    expect(renderInviteExpiry(locale, century, 'UTC', 'jalali', AT)).toBe(words);
    expect(renderInviteExpiry(locale, null, 'UTC', 'jalali', AT)).toBe(words);
    // An end within the coming years is still a date (an invitation ends within 30 days).
    const soon = new Date(AT.getTime() + 30 * 24 * 3600 * 1000).toISOString();
    expect(renderInviteExpiry(locale, soon, 'UTC', 'gregorian', AT)).not.toBe(words);
    expect(renderInviteExpiry(locale, soon, 'UTC', 'gregorian', AT)).toMatch(/2026|۲۰۲۶/);
  });
});
