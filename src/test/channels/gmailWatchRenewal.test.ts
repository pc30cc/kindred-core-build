// @vitest-environment node
/**
 * The Gmail watch renewal ticker and a grant Google no longer honours.
 *
 * WebYar's own mailbox showed "connected" for two weeks while every 6-hour
 * renewal failed: Google's token endpoint answers invalid_grant with a 400,
 * which the client reports as a provider error, and the ticker only wrote
 * gmail_watch_renewal_failed. Nothing asked anyone to reconnect. The ticker
 * now marks such a mailbox errored, as the live inbox already did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailError, isGmailGrantRevoked } from '../../../server/services/channels/gmail/types.js';

const updateIntegration = vi.fn(async () => undefined);
const getGmailAccessToken = vi.fn();
const watchMailbox = vi.fn(async () => ({ historyId: '42', expiration: String(Date.now() + 7 * 86_400_000) }));
let rows: Array<Record<string, unknown>> = [];

vi.mock('../../../server/services/channels/gmail/oauthConfig.js', () => ({
  getGmailOAuthConfig: () => ({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://app.example/cb' }),
}));
vi.mock('../../../server/services/channels/gmail/oauth.js', () => ({
  getGmailPubSubTopic: () => 'projects/p/topics/gmail',
  getGmailAccessToken: (...a: unknown[]) => getGmailAccessToken(...a),
}));
vi.mock('../../../server/services/observability/tickerLease.js', () => ({
  acquireTickerLease: async () => true,
  releaseTickerLease: async () => undefined,
}));
vi.mock('../../../server/services/observability/metrics.js', () => ({ emitLog: () => undefined }));
vi.mock('../../../server/services/channels/integrations.js', () => ({
  updateIntegration: (...a: unknown[]) => updateIntegration(...(a as [])),
}));
vi.mock('../../../server/supabase.js', () => {
  const query = {
    select: () => query,
    eq: () => query,
    limit: async () => ({ data: rows, error: null }),
  };
  return { getServiceClient: () => ({ from: () => query }) };
});
vi.mock('../../../channels/mail/gmail/client.js', () => ({
  createGmailAdapter: () => ({ watchMailbox: (...a: unknown[]) => watchMailbox(...(a as [])) }),
}));

const { startGmailWatchRenewalTicker, __stopGmailWatchRenewalTickerForTests } = await import(
  '../../../server/services/channels/gmail/watchRenewalTicker.js'
);

/** What the client throws for Google's 400 invalid_grant (the `!res.ok` branch). */
const invalidGrant400 = () =>
  new GmailError(
    'gmail_provider_error',
    undefined,
    'Gmail 400 @ https://oauth2.googleapis.com/token — { "error": "invalid_grant", "error_description": "Bad Request" }',
  );

const config = {} as never;

async function runFirstTick() {
  startGmailWatchRenewalTicker(config);
  await vi.advanceTimersByTimeAsync(90_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  updateIntegration.mockClear();
  getGmailAccessToken.mockReset();
  rows = [{ id: 'int-1', workspace_id: 'ws-1', installation_id: 'inst-1', provider: 'gmail', metadata: {} }];
});

afterEach(() => {
  __stopGmailWatchRenewalTickerForTests();
  vi.useRealTimers();
});

describe('Gmail watch renewal', () => {
  it('marks a mailbox whose grant Google refuses as needing a reconnect', async () => {
    getGmailAccessToken.mockRejectedValue(invalidGrant400());
    await runFirstTick();
    expect(updateIntegration).toHaveBeenCalledTimes(1);
    expect(updateIntegration.mock.calls[0]).toMatchObject([
      config,
      'int-1',
      { status: 'error', last_error_code: 'gmail_token_revoked' },
    ]);
  });

  it('keeps a mailbox connected on a failure a retry can fix', async () => {
    getGmailAccessToken.mockRejectedValue(new GmailError('gmail_timeout'));
    await runFirstTick();
    const patch = (updateIntegration.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(patch).toMatchObject({ last_error_code: 'gmail_watch_renewal_failed' });
    expect(patch).not.toHaveProperty('status');
  });

  it('renews and clears the error when the token works', async () => {
    getGmailAccessToken.mockResolvedValue('access-token');
    await runFirstTick();
    expect(watchMailbox).toHaveBeenCalled();
    expect((updateIntegration.mock.calls[0] as unknown[])[2]).toMatchObject({
      last_error_code: null,
      metadata: { gmail_history_id: '42' },
    });
  });
});

describe('isGmailGrantRevoked', () => {
  it('is true for a refused grant, however the client reported it', () => {
    expect(isGmailGrantRevoked(invalidGrant400())).toBe(true);
    expect(isGmailGrantRevoked(new GmailError('gmail_token_revoked'))).toBe(true);
    expect(isGmailGrantRevoked(new GmailError('gmail_insufficient_scope'))).toBe(true);
    expect(isGmailGrantRevoked(new GmailError('gmail_not_connected'))).toBe(true);
  });

  /** A reconnect would not fix these, so they must not ask the user for one. */
  it('is false for platform-side and transient failures', () => {
    const invalidClient = new GmailError(
      'gmail_provider_error',
      undefined,
      'Gmail 401 @ https://oauth2.googleapis.com/token — { "error": "invalid_client" }',
    );
    expect(isGmailGrantRevoked(invalidClient)).toBe(false);
    expect(isGmailGrantRevoked(new GmailError('gmail_timeout'))).toBe(false);
    expect(isGmailGrantRevoked(new GmailError('gmail_provider_error', undefined, 'Gmail 500 @ https://gmail.googleapis.com/x'))).toBe(false);
    expect(isGmailGrantRevoked(new Error('invalid_grant oauth2.googleapis.com/token'))).toBe(false);
  });
});
