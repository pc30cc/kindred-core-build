/**
 * The invitation e-mail as the worker builds it, and what it does with the
 * result (server/services/invitations/worker.ts). No database: the RPCs and
 * sendEmail are stood in for; the real lifecycle and fault semantics are in
 * the integration suites.
 *
 *   - the subject and the text part get each value as typed and the HTML
 *     part its escaped copy (htmlData): "A&B" in a subject, and the link's
 *     "&p=e" in the text part, used to read "A&amp;B" and "&amp;p=e";
 *   - {brand} is left to the email service (the platform's own name): the
 *     workspace's name never stands in for the brand of a mail sent From the
 *     platform;
 *   - {inviter} is the inviter's name, or "a team member" in the mail's
 *     language, never blank;
 *   - a failure that can only repeat ends the job at once (unconfigured, or
 *     permanently_failed); one that can pass is retried on the email
 *     outbox's schedule (a minute after the first attempt).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  jobHanded: false,
  completions: [] as Array<Record<string, unknown>>,
  inviter: 'Dana Admin' as string | null,
  locale: 'en',
  workspaceName: 'A&B "Co" <x>',
  sendEmail: vi.fn(),
}));

vi.mock('../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'claim_invitation_jobs') {
        const channels = args._channels as string[];
        if (!channels.includes('email') || h.jobHanded) return { data: [], error: null };
        h.jobHanded = true;
        return {
          data: [{
            id: 'job-1', claim_token: 'claim-1', channel: 'email', invitation_id: 'inv-1', locale: h.locale,
            attempt_count: 1, max_attempts: 8, derivation_key_version: 1, notification_generation: 1, email_token_generation: 1,
          }],
          error: null,
        };
      }
      if (fn === 'wi_prepare_invitation_job') {
        return {
          data: {
            cancelled: false, email: 'invitee@example.org', phone: '', first_name: 'Sam\nLee', workspace_name: h.workspaceName,
            workspace_id: 'ws-1', role: 'agent', locale: h.locale, expires_at: null, time_zone: null,
          },
          error: null,
        };
      }
      if (fn === 'wi_job_still_sendable') return { data: true, error: null };
      if (fn === 'wi_complete_invitation_job') {
        h.completions.push(args);
        return { data: { applied: true }, error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === 'workspace_invitations') return { data: { created_by: 'user-1' }, error: null };
          if (table === 'profiles') return { data: { full_name: h.inviter }, error: null };
          return { data: null, error: null };
        },
      };
      return builder;
    },
  }),
}));
vi.mock('../../server/services/email/index.js', () => ({ sendEmail: h.sendEmail }));
vi.mock('../../server/services/platformRegion.js', () => ({ getPlatformEditionOrNull: async () => 'international' }));
vi.mock('../../server/services/invitations/tokens.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/services/invitations/tokens.js')>()),
  currentKeyVersion: () => 1,
  hasDerivationKey: () => true,
  deriveEmailToken: () => 'tok123',
  resolveAppBaseUrl: async () => 'https://app.example.com',
}));

const worker = await import('../../server/services/invitations/worker.js');
const CONFIG = {} as never;

async function runOnce(result: Record<string, unknown>) {
  h.sendEmail.mockResolvedValue(result);
  await worker.drainInvitationJobs(CONFIG, { runMaintenance: false });
  return { request: h.sendEmail.mock.calls[0]?.[1] as Record<string, Record<string, string>>, completion: h.completions[0] };
}

beforeEach(() => {
  h.jobHanded = false;
  h.completions.length = 0;
  h.inviter = 'Dana Admin';
  h.locale = 'en';
  h.sendEmail.mockReset();
});

describe('the invitation e-mail', () => {
  it('raw values for the subject and text, escaped copies for the HTML, and the platform\'s own brand', async () => {
    const { request } = await runOnce({ success: true, provider: 'smtp', id: 'q1' });
    expect(request.templateData).toEqual({
      name: 'Sam Lee',
      workspace: 'A&B "Co" <x>',
      inviter: 'Dana Admin',
      role: 'agent',
      action_url: 'https://app.example.com/invite#token=tok123&p=e',
    });
    expect(request.htmlData).toEqual({
      name: 'Sam Lee',
      workspace: 'A&amp;B &quot;Co&quot; &lt;x&gt;',
      inviter: 'Dana Admin',
      role: 'agent',
      action_url: 'https://app.example.com/invite#token=tok123&amp;p=e',
    });
    expect(request.templateData).not.toHaveProperty('brand');
  });

  it('names "a team member" in the mail\'s language when the inviter has no name', async () => {
    h.inviter = null;
    h.locale = 'fa';
    const { request } = await runOnce({ success: true, provider: 'smtp' });
    expect(request.templateData.inviter).toBe('یکی از اعضای تیم');
  });
});

describe('what the worker does with the result', () => {
  it('accepted by the provider', async () => {
    const { completion } = await runOnce({ success: true, provider: 'smtp', id: 'q1' });
    expect(completion).toMatchObject({ _outcome: 'provider_accepted', _provider_name: 'smtp', _provider_message_id: 'q1' });
  });

  it('a provider missing its settings is unconfigured at once, whatever its name', async () => {
    const { completion } = await runOnce({ success: false, provider: 'smtp', errorCode: 'unconfigured', permanent: true, error: 'unconfigured: from_email is missing' });
    expect(completion).toMatchObject({ _outcome: 'unconfigured', _error_code: 'EMAIL_PROVIDER_UNCONFIGURED' });
  });

  it('a refused or suppressed address ends the job at once instead of using up its attempts', async () => {
    const { completion } = await runOnce({ success: false, provider: 'smtp', errorCode: 'suppressed', permanent: true, error: 'suppressed: bounced' });
    expect(completion).toMatchObject({ _outcome: 'permanently_failed', _error_code: 'EMAIL_SEND_FAILED' });
  });

  it('a failure that can pass is retried on the outbox schedule', async () => {
    const { completion } = await runOnce({ success: false, provider: 'smtp', errorCode: 'timeout', permanent: false, error: 'timeout: no answer' });
    expect(completion).toMatchObject({ _outcome: 'retry', _error_code: 'EMAIL_SEND_FAILED', _retry_in_seconds: 60 });
  });
});
