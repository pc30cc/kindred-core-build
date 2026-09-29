// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { verifyPushAuth } from '../../../server/routes/gmailPush.js';

const audience = 'https://api.webyar.ai/webhooks/gmail/push';
const identity = 'gmail-push@webyar-de9b1.iam.gserviceaccount.com';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('authenticated Gmail Pub/Sub push', () => {
  it('fails closed when the push identity is not configured', async () => {
    vi.stubEnv('GMAIL_PUBSUB_PUSH_AUDIENCE', audience);
    vi.stubEnv('GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL', '');
    expect(await verifyPushAuth('Bearer token')).toEqual({
      ok: false,
      reason: 'GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL is not configured',
    });
  });

  it('accepts only the configured, verified push identity', async () => {
    vi.stubEnv('GMAIL_PUBSUB_PUSH_AUDIENCE', audience);
    vi.stubEnv('GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL', identity);
    const verify = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken');
    verify.mockResolvedValue({ getPayload: () => ({ email: identity, email_verified: true }) } as any);
    expect((await verifyPushAuth('Bearer token')).ok).toBe(true);
    expect(verify).toHaveBeenCalledWith({ idToken: 'token', audience });

    verify.mockResolvedValue({ getPayload: () => ({ email: 'gmail-api-push@system.gserviceaccount.com', email_verified: true }) } as any);
    expect((await verifyPushAuth('Bearer token')).ok).toBe(false);

    verify.mockResolvedValue({ getPayload: () => ({ email: identity, email_verified: false }) } as any);
    expect((await verifyPushAuth('Bearer token')).ok).toBe(false);
  });
});
