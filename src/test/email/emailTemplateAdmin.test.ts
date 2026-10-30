// @vitest-environment node
/**
 * Super Admin → Branding → Email templates sees and tries a template as it
 * is sent (server/services/email/templateAdmin.ts):
 *
 *   - the preview is the email core's own render: the catalog's sample
 *     values filled in the edition's way, the layout, the brand, the closing
 *     line a notification's sender adds, either colour scheme, and the
 *     content's problems as codes;
 *   - the test goes through the core's send with the template as given (the
 *     text being edited, never the stored row), in its own language even
 *     where the platform sends another, as platform mail: no workspace's log,
 *     no one-click unsubscribe header, a closing line that switches nothing
 *     off, and no content-check line in the stored row's name; an operator
 *     notice through the provider its real ones take.
 *
 * The database is an in-memory stand-in; the Resend adapter is the real one,
 * over a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
interface Template { edition: string; slug: string; locale: string; subject: string; html_body: string; text_body: string | null }

const db = vi.hoisted(() => ({
  edition: 'iran' as string | null,
  locales: ['fa'] as string[],
  templates: [] as Template[],
  inserts: [] as string[],
  branding: {} as Record<string, Row>,
  domains: { app_base_url: 'https://app.example.com', canonical_base_url: 'https://example.com' } as Row | null,
  /** app_runtime_config's email providers, by key. */
  providers: {} as Record<string, Row>,
  notificationSettings: null as Row | null,
}));

const client = vi.hoisted(() => () => ({
  from(table: string) {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: () => {
        db.inserts.push(table);
        return builder;
      },
      update: () => builder,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      is: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      maybeSingle: async () => {
        if (table === 'app_runtime_config') {
          const value = db.providers[filters.key as string];
          return { data: value ? { value } : null, error: null };
        }
        if (table === 'notification_email_settings') return { data: db.notificationSettings, error: null };
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

const { sendEmail } = await import('../../../server/services/email/index.js');
const { invalidateNotificationEmailSettingsCache } = await import('../../../server/services/notificationEmail/settings.js');
const { previewPlatformTemplate, sendPlatformTemplateTest } = await import('../../../server/services/email/templateAdmin.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'], deliveryDiagnosticsLoggingEnabled: true } as never;

let fetchMock: ReturnType<typeof vi.fn>;
const sent = (call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body as string) as {
  html: string; text: string; subject: string; to: string | string[]; headers?: Record<string, string>;
};

const RECEIPT = {
  subject: 'رسید پرداخت {receipt_number} — {brand}',
  html_body: '<div class="preheader">پرداخت شما رسید.</div><h1>رسید پرداخت</h1><p>{workspace}</p><table class="details"><tr><th>مبلغ</th><td>{amount}</td></tr></table><p class="action"><a href="{receipt_url}">مشاهدهٔ رسید</a></p>',
  text_body: 'مبلغ: {amount}',
};
const DIGEST = {
  subject: '{{count}} conversations waiting in {{workspace}}',
  html_body: '<div class="preheader">Waiting for more than {{minutes}} minutes.</div><h1>Conversations waiting</h1><p>Hi {{name}},</p><table class="details"><tr><th>Subjects</th><td>{{list}}</td></tr></table><p class="action"><a href="{{action_url}}">Open the inbox</a></p>',
  text_body: null,
};

beforeEach(() => {
  db.edition = 'iran';
  db.locales = ['fa'];
  db.templates = [];
  db.inserts = [];
  db.branding = { fa: { platform_name: 'پلتفرم' }, en: { platform_name: 'Platform One' } };
  db.domains = { app_base_url: 'https://app.example.com', canonical_base_url: 'https://example.com' };
  db.providers = { default_email_provider: { provider_name: 'resend', config: { api_key: 're_test', from_email: 'noreply@example.com' } } };
  db.notificationSettings = null;
  invalidateNotificationEmailSettingsCache();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'msg_1' }), text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.RESEND_API_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a template given in place of the stored row (EmailRequest.template)', () => {
  it('is sent as given, in its own language, even where the platform sends another', async () => {
    db.templates = [{ edition: 'iran', slug: 'billing_trial_ended', locale: 'fa', subject: 'Stored row', html_body: '<h1>Stored</h1>', text_body: null }];
    const result = await sendEmail(CONFIG, {
      workspaceId: null,
      to: 'admin@example.com',
      templateSlug: 'billing_trial_ended',
      template: { subject: 'Your trial ended — {brand}', html_body: '<h1>Your trial ended</h1><p>{workspace}</p>', text_body: null, locale: 'en' },
      templateData: { workspace: 'Blue & Co' },
      locale: 'en',
    });
    expect(result.success).toBe(true);
    const mail = sent();
    expect(mail.subject).toBe('Your trial ended — Platform One');
    expect(mail.html).toContain('Your trial ended');
    expect(mail.html).toContain('Blue &amp; Co');
    expect(mail.html).not.toContain('Stored');
    expect(mail.html).toMatch(/<html[^>]*lang="en"[^>]*dir="ltr"|<html[^>]*dir="ltr"[^>]*lang="en"/);
  });
});

describe('the preview', () => {
  it('renders the catalog\'s sample values in the edition\'s way, through the layout, with the content\'s problems', async () => {
    const preview = await previewPlatformTemplate(CONFIG, {
      edition: 'iran', slug: 'billing_payment_receipt', locale: 'fa', scheme: 'light',
      content: { ...RECEIPT, html_body: `${RECEIPT.html_body}<p><a href="https://elsewhere.example.net/x">x</a></p>` },
    });
    expect(preview.subject).toBe('رسید پرداخت R-7001 — پلتفرم');
    expect(preview.html).toMatch(/<html[^>]*dir="rtl"/);
    expect(preview.html).toContain('فروشگاه آبی');
    expect(preview.html).toMatch(/[۰-۹٬]+ تومان/);
    expect(preview.html).toContain('https://app.example.com/blue-store/billing/receipts/R-7001');
    expect(preview.text).toMatch(/^مبلغ: [۰-۹٬]+ تومان/);
    expect(preview.problems).toEqual(['foreign_link']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forces the dark palette when asked, and the light one otherwise', async () => {
    const input = { edition: 'iran' as const, slug: 'billing_payment_receipt', locale: 'fa', content: RECEIPT };
    const light = await previewPlatformTemplate(CONFIG, { ...input, scheme: 'light' });
    const dark = await previewPlatformTemplate(CONFIG, { ...input, scheme: 'dark' });
    expect(dark.html).not.toBe(light.html);
    expect(light.problems).toEqual([]);
  });

  it('gives a notification the closing line its sender adds, linking to the settings, never a personal unsubscribe link', async () => {
    const preview = await previewPlatformTemplate(CONFIG, {
      edition: 'international', slug: 'operator_unread_digest', locale: 'en', scheme: 'light', content: DIGEST,
    });
    expect(preview.subject).toBe('3 conversations waiting in Blue Store');
    expect(preview.html).toContain('Sara Miller');
    expect(preview.html).toContain('https://app.example.com/app/settings/notifications');
    expect(preview.html).not.toContain('/api/notifications/email/unsubscribe/');
    expect(preview.text).toContain('https://app.example.com/app/settings/notifications');
  });

  it('fills a legacy template with the core\'s values only', async () => {
    const preview = await previewPlatformTemplate(CONFIG, {
      edition: 'iran', slug: 'welcome', locale: 'fa', scheme: 'light',
      content: { subject: 'Welcome {name} — {brand}', html_body: '<h1>Welcome {name}</h1>', text_body: null },
    });
    expect(preview.subject).toBe('Welcome {name} — پلتفرم');
  });
});

describe('the test', () => {
  it('goes through the core to the given address as platform mail, with the sample values', async () => {
    const result = await sendPlatformTemplateTest(CONFIG, {
      edition: 'iran', slug: 'billing_payment_receipt', locale: 'fa', content: RECEIPT, to: 'admin@example.com',
    });
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const mail = sent();
    expect(mail.to).toEqual(['admin@example.com']);
    expect(mail.subject).toBe('رسید پرداخت R-7001 — پلتفرم');
    expect(mail.html).toMatch(/[۰-۹٬]+ تومان/);
    expect(mail.text).toMatch(/^مبلغ: [۰-۹٬]+ تومان/);
    expect(mail.headers?.['Auto-Submitted']).toBe('auto-generated');
    // Platform mail: never in a workspace's email log.
    expect(db.inserts).not.toContain('email_logs');
  });

  it('gives a notification its closing line and no one-click unsubscribe header', async () => {
    await sendPlatformTemplateTest(CONFIG, {
      edition: 'international', slug: 'operator_unread_digest', locale: 'en', content: DIGEST, to: 'admin@example.com',
    });
    const mail = sent();
    expect(mail.html).toContain('https://app.example.com/app/settings/notifications');
    expect(Object.keys(mail.headers ?? {})).not.toContain('List-Unsubscribe');
  });

  it('sends an operator notice through the provider its real ones take, and every other mail through the default', async () => {
    db.providers.notification_email_provider = { provider_name: 'resend', config: { api_key: 're_notice', from_email: 'alerts@example.com' } };
    db.notificationSettings = { enabled: true, provider_override: 'resend' };
    const from = (call: number) => String((sent(call) as unknown as { from: string }).from);
    const key = (call: number) => String((fetchMock.mock.calls[call][1].headers as Record<string, string>).Authorization);
    await sendPlatformTemplateTest(CONFIG, {
      edition: 'international', slug: 'operator_unread_digest', locale: 'en', content: DIGEST, to: 'admin@example.com',
    });
    expect(from(0)).toContain('alerts@example.com');
    expect(key(0)).toBe('Bearer re_notice');
    // The owners' offline-message notices and service mail go the default way, as theirs do.
    for (const slug of ['offline_messages_summary', 'billing_payment_receipt']) {
      await sendPlatformTemplateTest(CONFIG, { edition: 'iran', slug, locale: 'fa', content: RECEIPT, to: 'admin@example.com' });
    }
    expect([from(1), from(2)].every((f) => f.includes('noreply@example.com'))).toBe(true);
    expect([key(1), key(2)]).toEqual(['Bearer re_test', 'Bearer re_test']);

    // A notification provider chosen but not set up: the notices, and their test, take the default.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.notificationSettings = { enabled: true, provider_override: 'sendgrid' };
    invalidateNotificationEmailSettingsCache();
    await sendPlatformTemplateTest(CONFIG, {
      edition: 'international', slug: 'operator_unread_digest', locale: 'en', content: DIGEST, to: 'admin@example.com',
    });
    expect(key(3)).toBe('Bearer re_test');
  });

  it('leaves the stored row\'s content check to the stored row: a draft\'s problem is not logged against it', async () => {
    // The core logs a template's content problems once per template and
    // language in a process: that line is how a hand-edited row with a
    // foreign link is found (EMAIL.md). A test of a draft is neither that
    // row nor a mail anybody gets, and the Super Admin sees its problems in
    // the preview.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await sendPlatformTemplateTest(CONFIG, {
      edition: 'iran', slug: 'password_reset', locale: 'fa', to: 'admin@example.com',
      content: { subject: 'بازیابی — {brand}', html_body: '<h1>بازیابی</h1><p><a href="https://phish.example.org/login">ورود</a></p>', text_body: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join('\n')).not.toContain('password_reset');

    db.templates = [{
      edition: 'iran', slug: 'password_reset', locale: 'fa', subject: 'بازیابی — {brand}', text_body: null,
      html_body: '<h1>بازیابی</h1><p><a href="https://phish.example.org/login">ورود</a></p><div style="display:none">x</div>',
    }];
    await sendEmail(CONFIG, {
      workspaceId: null, to: 'user@example.com', templateSlug: 'password_reset', locale: 'fa',
      templateData: { name: 'سارا', action_url: 'https://app.example.com/auth/reset-password?token=t', email: 'user@example.com' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[email] password_reset (iran, fa): foreign_link, hidden_element');
  });

  it('is never sent to a suppressed or malformed address', async () => {
    const result = await sendPlatformTemplateTest(CONFIG, {
      edition: 'iran', slug: 'billing_payment_receipt', locale: 'fa', content: RECEIPT, to: 'a@example.com, b@example.com',
    });
    expect(result).toMatchObject({ success: false, errorCode: 'invalid_recipient' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
