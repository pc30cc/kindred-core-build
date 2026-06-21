/**
 * Email Surface Split — channel gate verification.
 *
 * Verifies the canonical split:
 *   - sendChannelEmail() denies via checkChannelAccess when the email
 *     channel is not available on the workspace plan.
 *   - sendChannelEmail() proceeds to sendEmail() when the channel is
 *     allowed.
 *   - The platform sendEmail() path is never gated by the channel
 *     entitlement (auth/reset/invitations stay reachable).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const channelState: { allowed: boolean } = { allowed: true };
const sendCalls: any[] = [];

vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkChannelAccess: async (_u: string, _k: string, _w: string, channel: string) => {
    return { allowed: channelState.allowed, reason: channelState.allowed ? 'plan' : 'plan_forbidden', channel };
  },
}));

vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: async (_cfg: any, req: any) => {
    sendCalls.push(req);
    return { success: true, provider: 'stub' };
  },
}));

const cfg = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'svc' } as any;

beforeEach(() => {
  sendCalls.length = 0;
  channelState.allowed = true;
});

describe('email surface split', () => {
  it('denies channel-email when email channel is not on plan', async () => {
    channelState.allowed = false;
    const { sendChannelEmail } = await import('../../../server/services/email/sendChannelEmail.js');
    const r = await sendChannelEmail(cfg, { workspaceId: 'w1', to: 'a@b.c', subject: 's', html: '<p>x</p>' });
    expect(r.success).toBe(false);
    expect(r.upgrade_required).toBe(true);
    expect(sendCalls.length).toBe(0);
  });

  it('allows channel-email when email channel is on plan', async () => {
    channelState.allowed = true;
    const { sendChannelEmail } = await import('../../../server/services/email/sendChannelEmail.js');
    const r = await sendChannelEmail(cfg, { workspaceId: 'w1', to: 'a@b.c', subject: 's', html: '<p>x</p>' });
    expect(r.success).toBe(true);
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0].workspaceId).toBe('w1');
  });

  it('platform sendEmail is not coupled to the channel entitlement', async () => {
    // Direct sendEmail() (auth/reset/invitations path) does not call checkChannelAccess.
    channelState.allowed = false;
    const { sendEmail } = await import('../../../server/services/email/index.js');
    const r = await sendEmail(cfg, { workspaceId: 'w1', to: 'a@b.c', subject: 'auth', html: '<p>auth</p>' } as any);
    expect(r.success).toBe(true);
    expect(sendCalls.length).toBe(1);
  });
});