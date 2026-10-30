// @vitest-environment node
/**
 * Every platform mail wears the layout, wrapped by the email core at send
 * time (server/services/email/index.ts, composeMessage):
 *
 *   - a row's content, a caller's own text when the row is missing (written
 *     as a whole document or not), a request with no template at all; only a
 *     row that is a whole document of its own (a Super Admin's hand-made
 *     design, or an old row) goes as it is;
 *   - the brand is read when the mail is sent: the logo from the one
 *     brand-asset resolver, the name in the template's language, the legal
 *     line, the app's address;
 *   - the caller's closing line (the unsubscribe line) sits inside the
 *     designed footer;
 *   - the text part is the row's own, else the content as text with the
 *     footer's lines;
 *   - values that depend on the language follow the language the template is
 *     actually sent in (localizedData), which is how the auth mails' {brand}
 *     and {expiry_time} stopped reading English in a Persian mail;
 *   - with no edition, nothing goes out (which brand's look cannot be told);
 *   - Super Admin's preview renders exactly what is sent.
 *
 * The database is an in-memory stand-in; the Resend adapter is the real one,
 * over a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
interface Template { edition: string; slug: string; locale: string; subject: string; html_body: string; text_body: string | null }

const db = vi.hoisted(() => ({
  edition: 'international' as string | null,
  locales: ['en', 'fa', 'tr'] as string[],
  templates: [] as Template[],
  branding: {} as Record<string, Row>,
  domains: { app_base_url: 'https://app.respok.app', canonical_base_url: 'https://respok.app' } as Row | null,
}));

const client = vi.hoisted(() => () => ({
  from(table: string) {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: () => builder,
      update: () => builder,
      upsert: () => builder,
      delete: () => builder,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      neq: () => builder,
      is: () => builder,
      in: () => builder,
      lt: () => builder,
      lte: () => builder,
      gt: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      single: async () => ({ data: { id: 'token-1', created_at: '2026-10-30T10:00:00.000000+00:00' }, error: null }),
      maybeSingle: async () => {
        if (table === 'app_runtime_config') {
          return filters.key === 'default_email_provider'
            ? { data: { value: { provider_name: 'resend', config: { api_key: 're_test', from_email: 'noreply@respok.app' } } }, error: null }
            : { data: null, error: null };
        }
        if (table === 'email_templates') {
          const row = db.templates.find((t) => t.edition === filters.edition && t.slug === filters.slug && t.locale === filters.locale);
          return { data: row ? { subject: row.subject, html_body: row.html_body, text_body: row.text_body } : null, error: null };
        }
        if (table === 'platform_branding_localized') return { data: db.branding[filters.locale as string] ?? null, error: null };
        if (table === 'platform_domains') return { data: db.domains, error: null };
        return { data: null, error: null };
      },
    };
    return builder;
  },
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: client }));
vi.mock('../../../server/lib/serviceClient.js', () => ({ serviceClientFor: client }));
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformEditionOrNull: async () => db.edition,
  getPlatformAllowedLocales: async () => db.locales,
}));

const { sendEmail, sendPlatformEmail, renderEmailForPreview, templateContentProblems } = await import('../../../server/services/email/index.js');
const { issueVerificationEmail } = await import('../../../server/services/auth-email.js');
const { mailTextLines, sendOfflineNoticeTest } = await import('../../../server/services/widget/offlineNotice.js');
const { renderOtpEmail: renderVerificationOtp } = await import('../../../server/services/verification/templates.js');
const { renderOtpEmail: renderInviteOtp, renderInviteEmail } = await import('../../../server/services/invitations/notificationTemplates.js');
const { testMailRequest } = await import('../../../server/services/email/testMail.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'], deliveryDiagnosticsLoggingEnabled: false } as never;
const YEAR = String(new Date().getUTCFullYear());

let fetchMock: ReturnType<typeof vi.fn>;
const sent = (call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body as string) as { html: string; text: string; subject: string; from: string };

const RECEIPT: Template = {
  edition: 'international', slug: 'billing_payment_receipt', locale: 'en',
  subject: 'Payment receipt {receipt_number} — {brand}',
  html_body: '<div class="preheader">We received your payment.</div><h1>Payment receipt</h1><p>Thanks.</p><table class="details"><tr><th>Receipt</th><td>{receipt_number}</td></tr></table><p class="action"><a href="{billing_url}">View receipt</a></p>',
  text_body: null,
};

beforeEach(() => {
  db.edition = 'international';
  db.locales = ['en', 'fa', 'tr'];
  db.templates = [structuredClone(RECEIPT)];
  db.branding = { en: { platform_name: 'RESPOK' }, fa: { platform_name: 'رسپاک' } };
  db.domains = { app_base_url: 'https://app.respok.app', canonical_base_url: 'https://respok.app' };
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'msg_1' }), text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.RESEND_API_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const receipt = (over: Record<string, unknown> = {}) =>
  sendEmail(CONFIG, {
    workspaceId: null,
    to: 'owner@example.com',
    templateSlug: 'billing_payment_receipt',
    templateData: { receipt_number: 'R-7001', billing_url: 'https://app.respok.app/acme/billing' },
    locale: 'en',
    ...over,
  } as never);

describe('a row\'s content wears the layout, with the brand as it is now', () => {
  it('the document, the kit logo from the one resolver, the name, the links and the legal line', async () => {
    expect((await receipt()).success).toBe(true);
    const mail = sent();
    expect(mail.subject).toBe('Payment receipt R-7001 — RESPOK');
    expect(mail.html).toMatch(/^<!DOCTYPE html>\n<html lang="en" dir="ltr"/);
    expect(mail.html).toContain('<title>Payment receipt R-7001 — RESPOK</title>');
    expect(mail.html).toContain('src="https://app.respok.app/brand/intl/email/respok-logo-dark.png"');
    expect(mail.html).toContain('<a href="https://respok.app" style="display:inline-block;text-decoration:none;">');
    expect(mail.html).toContain('>app.respok.app</a>');
    expect(mail.html).toContain('href="mailto:support@respok.app"');
    expect(mail.html).toContain(`>© ${YEAR} RESPOK</td>`);
    expect(mail.html).toContain('class="action x-btnt"');
    // The From name falls back to the same name the mail prints.
    expect(mail.from).toBe('RESPOK <noreply@respok.app>');
  });

  it('the text part is the content as text with the footer\'s lines, never the preheader or the layout', async () => {
    await receipt();
    expect(sent().text).toBe(
      `Payment receipt\n\nThanks.\n\nReceipt: R-7001\n\nView receipt (https://app.respok.app/acme/billing)\n\nThis is a service email from RESPOK.\nRESPOK · app.respok.app · support@respok.app\n© ${YEAR} RESPOK`,
    );
  });

  it('a row with its own text part sends that, the caller\'s closing line under it', async () => {
    db.templates[0].text_body = 'Receipt {receipt_number}';
    await receipt({ footer: { html: '<p>Why. <a href="https://u.example/x">Unsubscribe</a></p>', text: 'Why.\nUnsubscribe: https://u.example/x' } });
    expect(sent().text).toBe('Receipt R-7001\n\nWhy.\nUnsubscribe: https://u.example/x');
  });

  it('the legal line is the Super Admin\'s own footer text in that language', async () => {
    db.branding.en = { platform_name: 'RESPOK', footer_company_text: '© 2026 RESPOK Inc. All rights reserved.' };
    await receipt();
    expect(sent().html).toContain('>© 2026 RESPOK Inc. All rights reserved.</td>');
  });

  it('with no app address known, the name stands in for the logo', async () => {
    db.domains = null;
    await receipt();
    expect(sent().html).not.toContain('<img');
    expect(sent().html).toMatch(/color:#FFFFFF;">RESPOK<\/span>/);
  });
});

describe('the caller\'s closing line sits inside the designed footer', () => {
  it('in place of the why line, before the brand line, its words and link kept', async () => {
    await receipt({
      category: 'notification',
      footer: { html: '<p dir="ltr" style="margin-top:24px;border-top:1px solid #e5e7eb">You get this because receipts are on. <a href="https://app.respok.app/u/t" style="color:#6b7280">Unsubscribe</a></p>', text: 'You get this because receipts are on.\nUnsubscribe: https://app.respok.app/u/t' },
    });
    const { html, text } = sent();
    const unsubscribe = html.indexOf('>Unsubscribe</a>');
    expect(unsubscribe).toBeGreaterThan(html.indexOf('View receipt'));
    expect(unsubscribe).toBeLessThan(html.indexOf('>RESPOK</strong>'));
    expect(html).not.toContain('border-top:1px solid #e5e7eb');
    expect(html).not.toContain('This is a service email');
    expect(text).toContain('You get this because receipts are on.\nUnsubscribe: https://app.respok.app/u/t\nRESPOK · app.respok.app');
  });
});

describe('a visitor\'s message keeps its lines', () => {
  it('in the HTML part (a <br>) and in the text part derived from it (a line break), as the offline notice sends it', async () => {
    // offline_message_received as 291 writes it: no text part of its own, the message in a quote.
    db.templates = [{
      edition: 'international', slug: 'offline_message_received', locale: 'en', subject: 'New offline message',
      html_body: '<div class="preheader">A visitor left a message.</div><h1>New offline message</h1><table class="details"><tr><th>Name</th><td>{contact_name}</td></tr></table><blockquote>{message_body}</blockquote><p class="action"><a href="{action_url}">Reply in the inbox</a></p>',
      text_body: null,
    }];
    const message = 'Hello,\nmy order 1234\r\nhas not arrived.\n\nThanks <3';
    await sendEmail(CONFIG, {
      workspaceId: null, to: 'owner@example.com', subject: 'New offline message', html: '', text: '',
      templateSlug: 'offline_message_received',
      templateData: { contact_name: '', message_body: '', action_url: 'https://app.respok.app/acme/inbox?c=1' },
      htmlData: { contact_name: 'Ali', message_body: mailTextLines(message) },
      locale: 'en', category: 'notification',
    } as never);
    const { html, text } = sent();
    expect(html).toMatch(/<td class="x-quote"[^>]*>Hello,<br>my order 1234<br>has not arrived\.<br><br>Thanks &lt;3<\/td>/);
    expect(text).toContain('Name: Ali\n\nHello,\nmy order 1234\nhas not arrived.\n\nThanks <3\n\nReply in the inbox (https://app.respok.app/acme/inbox?c=1)');
  });
});

describe('a content is checked when it is sent', () => {
  it('what runs code never goes out; the problems are logged by their codes, once per template, never the content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A slug of its own: the log is once per template, edition and language in a process.
    db.templates = [{
      ...RECEIPT, slug: 'billing_trial_ending',
      html_body: '<h1>Receipt</h1><p style="display:none">secret words</p><script>steal()</script><p><a href="https://evil.example/pay">Pay</a> {receipt_number}</p>',
    }];
    await receipt({ templateSlug: 'billing_trial_ending' });
    await receipt({ templateSlug: 'billing_trial_ending' });
    expect(sent(0).html).not.toContain('<script');
    expect(sent(0).html).not.toContain('steal');
    expect(sent(1).html).toContain('R-7001');
    const lines = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.startsWith('[email] billing_trial_ending'));
    expect(lines).toEqual(['[email] billing_trial_ending (international, en): hidden_element, forbidden_element:script, foreign_link']);
    expect(lines[0]).not.toMatch(/secret|steal|evil|R-7001/);
  });

  it('a clean row logs nothing, and Super Admin\'s save check reads the same brand hosts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.templates = [{ ...RECEIPT, slug: 'billing_payment_failed' }];
    await receipt({ templateSlug: 'billing_payment_failed' });
    expect(sent().html).toContain('View receipt');
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[email]'))).toEqual([]);
    const check = (html_body: string) => templateContentProblems(CONFIG, { edition: 'international', locale: 'en', html_body });
    expect(await check(RECEIPT.html_body)).toEqual([]);
    expect(await check('<p><a href="https://respok.app/pricing">Plans</a> <a href="mailto:support@respok.app">Write</a></p>')).toEqual([]);
    expect(await check('<p><a href="https://evil.example">x</a></p><iframe></iframe>')).toEqual(['foreign_link', 'forbidden_element:iframe']);
    // A whole document of its own is checked by its body.
    expect(await check('<!doctype html><html><head><meta charset="utf-8"></head><body><p>ok</p></body></html>')).toEqual([]);
  });
});

describe('a row that is a whole document of its own goes as it is', () => {
  it('no layout around it; the closing line before its </body>', async () => {
    db.templates[0].html_body = '<!doctype html><html><body><p>Own design {receipt_number}</p></body></html>';
    await receipt({ footer: { html: '<p>F</p>', text: 'F' } });
    expect(sent().html).toBe('<!doctype html><html><body><p>Own design R-7001</p><p>F</p></body></html>');
    expect(sent().text).toBe('Own design R-7001\n\nF');
  });
});

describe('a caller\'s own text wears the layout too', () => {
  it('when the row is missing', async () => {
    db.templates = [];
    await receipt({ subject: 'Fallback', html: '<p>Own words</p>', text: '' });
    expect(sent().html).toMatch(/^<!DOCTYPE html>/);
    expect(sent().html).toMatch(/<p class="x-ink" style="margin:0 0 0px;[^"]*">Own words<\/p>/);
    expect(sent().text).toContain('Own words\n\nThis is a service email from RESPOK.');
  });

  it('a fallback written as a whole document gives its body', async () => {
    db.templates = [];
    await receipt({ subject: 'Code', html: '<!doctype html><html lang="en"><body style="font-family:sans-serif"><p>Code: <b>123456</b></p></body></html>', text: 'Code: 123456' });
    expect(sent().html).not.toContain('font-family:sans-serif');
    expect(sent().html).toContain('Code: <b style="font-weight:700">123456</b>');
    expect(sent().text).toBe('Code: 123456');
  });

  it('in the language it is written in, when the platform writes that language', async () => {
    db.templates = [];
    await receipt({ subject: 'کد', html: '<p>کد شما</p>', locale: 'fa' });
    expect(sent().html).toContain('<html lang="fa" dir="rtl"');
    expect(sent().html).toContain('این ایمیل خدماتی از طرف رسپاک است.');
  });

  it('a request with no template at all, and one with only text', async () => {
    await sendPlatformEmail(CONFIG, { to: 'a@example.com', subject: 'S', html: '<p>Bare</p>' });
    expect(sent().html).toMatch(/^<!DOCTYPE html>[\s\S]*>Bare<\/p>/);
    await sendPlatformEmail(CONFIG, { to: 'a@example.com', subject: 'S', text: 'Line one\nline two\n\n<b>Not markup</b>' });
    expect(sent(1).html).toContain('>Line one<br>line two</p>');
    expect(sent(1).html).toContain('>&lt;b&gt;Not markup&lt;/b&gt;</p>');
  });
});

describe('every compiled fallback wears the layout, as the row it stands in for would', () => {
  // The senders' own fallbacks for a missing row, built by their own code.
  const FALLBACKS: Array<[string, () => Record<string, unknown>, string]> = [
    ['verification_code', () => ({ templateSlug: 'verification_code', locale: 'fa', ...renderVerificationOtp('fa', '482917', 600) }), '482917'],
    ['invite_otp', () => ({ templateSlug: 'invite_otp', locale: 'tr', ...renderInviteOtp('tr', '731904') }), '731904'],
    ['invite_member', () => ({
      templateSlug: 'invite_member', locale: 'en',
      ...renderInviteEmail('en', { firstName: 'Sam', workspaceName: 'Acme', link: 'https://app.respok.app/invite#t=1' }),
    }), 'Accept the invitation'],
    ['email_test', () => ({ locale: 'en', ...testMailRequest({ slot: 'default', provider: 'smtp', at: new Date('2026-10-30T10:00:00Z'), edition: 'international', locale: 'en' }) }), '(smtp)'],
  ];

  it.each(FALLBACKS)('%s', async (_slug, build, words) => {
    db.templates = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await sendEmail(CONFIG, { workspaceId: null, to: 'owner@example.com', ...build() } as never)).success).toBe(true);
    const { html } = sent();
    expect(html).toMatch(/^<!DOCTYPE html>\n<html lang="(fa|en|tr)"/);
    expect(html).toContain('class="x-card x-ink x-line x-pad"');
    expect(html).toContain('src="https://app.respok.app/brand/intl/email/respok-logo-dark.png"');
    expect(html).toContain(words);
    // One document: a fallback written as a whole one gives its body.
    expect(html.match(/<html\b/g)).toHaveLength(1);
  });

  it('offline_message_received: the notice the panel tests', async () => {
    db.templates = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await sendOfflineNoticeTest(CONFIG, { workspaceId: 'ws-1', to: 'owner@example.com', locale: 'en' });
    const { html } = sent();
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('class="x-card x-ink x-line x-pad"');
    expect(html).toContain('this is a test message confirming your offline notification pipeline works.');
  });
});

describe('words follow the language the template is sent in', () => {
  const VERIFY = (locale: string, subject: string): Template => ({
    edition: 'iran', slug: 'email_verify', locale, subject,
    html_body: '<h1>{brand}</h1><p>{expiry_time}</p><p class="action"><a href="{action_url}">Go</a></p><p>© {year}</p>', text_body: null,
  });

  beforeEach(() => {
    db.edition = 'iran';
    db.locales = ['fa'];
    db.branding = { en: { platform_name: 'Webyar' }, fa: { platform_name: 'وب‌یار' } };
    db.domains = { app_base_url: 'https://app.webyar.ai' };
    db.templates = [VERIFY('fa', 'تأیید ایمیل — {brand}'), VERIFY('en', 'Verify — {brand}')];
  });

  it('an English request on a Persian-only platform gets the Persian template and Persian words', async () => {
    const result = await issueVerificationEmail(CONFIG, { userId: 'u-1', email: 'new@example.com', fullName: 'Sara', locale: 'en' });
    expect(result).toEqual({ success: true });
    const mail = sent();
    expect(mail.subject).toBe('تأیید ایمیل — وب‌یار');
    expect(mail.html).toContain('>۲۴ ساعت</p>');
    expect(mail.html).toContain('>وب‌یار</h1>');
    expect(mail.html).toContain('>© ۱۴۰۵</p>'.replace('۱۴۰۵', new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', timeZone: 'UTC' }).format(new Date())));
    expect(mail.html).not.toContain('24 hours');
    expect(mail.html).toContain('src="https://app.webyar.ai/brand/webyar/email/webyar-logo-dark.png"');
    expect(mail.html).toContain('href="mailto:info@webyar.ai"');
  });

  it('when the Persian row is missing, the English one goes with the English words', async () => {
    db.templates = [VERIFY('en', 'Verify — {brand}')];
    await issueVerificationEmail(CONFIG, { userId: 'u-1', email: 'new@example.com', fullName: 'Sara', locale: 'fa' });
    const mail = sent();
    expect(mail.subject).toBe('Verify — Webyar');
    expect(mail.html).toContain('>24 hours</p>');
    expect(mail.html).toContain('<html lang="en" dir="ltr"');
  });
});

describe('no edition, no mail', () => {
  it('a transient failure, even with the caller\'s own text: which brand\'s look cannot be told', async () => {
    db.edition = null;
    const result = await receipt({ subject: 'Fallback', html: '<p>Own</p>' });
    expect(result).toMatchObject({ success: false, errorCode: 'edition_unavailable', permanent: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Super Admin\'s preview is the mail', () => {
  const row = { slug: RECEIPT.slug, locale: 'en', subject: RECEIPT.subject, html_body: RECEIPT.html_body, text_body: null };
  const data = { receipt_number: 'R-7001', billing_url: 'https://app.respok.app/acme/billing' };

  it('renders exactly what is sent', async () => {
    await receipt();
    const preview = await renderEmailForPreview(CONFIG, { ...row, data });
    expect(preview).toEqual({ subject: sent().subject, html: sent().html, text: sent().text });
  });

  it('a forced dark scheme shows the dark palette, in any viewer', async () => {
    const preview = await renderEmailForPreview(CONFIG, { ...row, data, scheme: 'dark' });
    expect(preview.html).toContain('<meta name="color-scheme" content="dark">');
    expect(preview.html).toContain('bgcolor="#0B0A15"');
  });

  it('a notification with its closing line, as its sender passes them', async () => {
    const preview = await renderEmailForPreview(CONFIG, { ...row, data, category: 'notification', footer: { html: '<p>Why. <a href="https://u.example">Stop</a></p>', text: 'Why.' } });
    expect(preview.html).toContain('>Stop</a>');
    expect(preview.text).toContain('\n\nWhy.\nRESPOK');
  });

  it('refuses to guess an edition', async () => {
    db.edition = null;
    await expect(renderEmailForPreview(CONFIG, { ...row, data })).rejects.toMatchObject({ code: 'EDITION_UNAVAILABLE' });
  });
});
