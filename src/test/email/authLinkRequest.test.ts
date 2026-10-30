// @vitest-environment node
/**
 * The request a verification or reset link goes out with
 * (server/services/auth-email.ts), as the email outbox keeps it for a day of
 * retries: {expiry_time} in every language the template may be sent in
 * (localizedData, which the core picks from at send time), and in the
 * request's own language in templateData too, so a core that reads no
 * localizedData (a backend rolled back while a retry waits) still fills it
 * rather than printing the placeholder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queued = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../../../server/services/email/outbox.js', () => ({
  sendEmailWithRetry: async (_config: unknown, request: Record<string, unknown>) => {
    queued.push(request);
    return { success: true, provider: 'resend' };
  },
}));

const client = vi.hoisted(() => () => {
  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: () => builder,
    update: () => builder,
    eq: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: { app_base_url: 'https://app.webyar.ai' }, error: null }),
    single: async () => ({ data: { id: 'token-1', created_at: '2026-10-30T10:00:00.000000+00:00' }, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
  };
  return { from: () => builder };
});
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: client }));

const { issueVerificationEmail, issueRecoveryEmail } = await import('../../../server/services/auth-email.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: [] } as never;

/** The fill of a core that knows no localizedData: each {key} from templateData, an unknown one left as written. */
const oldFill = (text: string, data: Record<string, string>) => text.replace(/\{(\w+)\}/g, (m, key: string) => data[key] ?? m);

beforeEach(() => {
  queued.length = 0;
});

describe('an auth link\'s request', () => {
  it.each([
    ['fa', '۲۴ ساعت'],
    ['fa-IR', '۲۴ ساعت'],
    ['en', '24 hours'],
    ['tr', '24 saat'],
    ['de', '24 hours'],
  ])('asked in %s, carries its expiry in that language for any core, and in every language for this one', async (locale, label) => {
    await issueVerificationEmail(CONFIG, { userId: 'u-1', email: 'new@example.com', fullName: 'Sara', locale });
    const request = queued[0] as { templateData: Record<string, string>; localizedData: Record<string, Record<string, string>> };
    expect(request.templateData.expiry_time).toBe(label);
    expect(request.localizedData).toEqual({ fa: { expiry_time: '۲۴ ساعت' }, en: { expiry_time: '24 hours' }, tr: { expiry_time: '24 saat' } });
    expect(oldFill('The link works for {expiry_time}.', request.templateData)).not.toContain('{');
  });

  it('a reset link the same way', async () => {
    await issueRecoveryEmail(CONFIG, { userId: 'u-1', email: 'new@example.com', locale: 'en' });
    expect((queued[0] as { templateSlug: string; templateData: Record<string, string> })).toMatchObject({
      templateSlug: 'password_reset',
      templateData: { expiry_time: '24 hours', email: 'new@example.com' },
    });
  });
});
