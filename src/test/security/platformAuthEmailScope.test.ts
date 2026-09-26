/**
 * C5 — platform auth mail (verification, password reset) is never attributed
 * to a tenant workspace. It used to be pinned to `workspaces.limit(1)`, so the
 * reset link (with its raw token) landed in a stranger's email_logs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const tablesQueried: string[] = [];
const sendEmail = vi.fn();

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      tablesQueried.push(table);
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: () => builder,
        insert: () => Promise.resolve({ data: null, error: null }),
        eq: () => builder,
        is: () => builder,
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
        limit: () => builder,
        maybeSingle: async () => {
          if (table === 'platform_domains') return { data: { app_base_url: 'https://app.example.com' }, error: null };
          if (table === 'workspaces') return { data: { id: 'tenant-ws' }, error: null };
          return { data: null, error: null };
        },
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

const CONFIG = { corsOrigins: ['*'] } as never;

describe('auth emails are platform-scoped', () => {
  beforeEach(() => {
    tablesQueried.length = 0;
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ success: true, provider: 'resend' });
  });

  it('password reset: workspaceId is null and no workspace is looked up', async () => {
    const { issueRecoveryEmail } = await import('../../../server/services/auth-email');
    const res = await issueRecoveryEmail(CONFIG, { userId: 'u1', email: 'a@example.com' });
    expect(res.success).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][1].workspaceId).toBeNull();
    expect(tablesQueried).not.toContain('workspaces');
  });

  it('email verification: workspaceId is null and no workspace is looked up', async () => {
    const { issueVerificationEmail } = await import('../../../server/services/auth-email');
    const res = await issueVerificationEmail(CONFIG, { userId: 'u1', email: 'a@example.com' });
    expect(res.success).toBe(true);
    expect(sendEmail.mock.calls[0][1].workspaceId).toBeNull();
    expect(tablesQueried).not.toContain('workspaces');
  });
});
