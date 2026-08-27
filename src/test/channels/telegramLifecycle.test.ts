/**
 * Telegram connect lifecycle: cross-workspace ownership + atomic replace.
 *
 * These are behavioural tests against the real service code with a fake DB
 * that re-implements the production unique index and ownership RPCs, plus a
 * fake Telegram API. They pin down the two invariants that cannot regress:
 *
 *  1. one bot belongs to exactly one workspace, decided by the DB and BEFORE
 *     any provider mutation happens;
 *  2. replacing a token is atomic — a failed attempt never destroys the
 *     working credential, the provider webhook, or the connected state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChannelsDb } from './fakeChannelsDb.js';

const db = new FakeChannelsDb();

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => db.client(),
  getAnonClient: () => db.client(),
}));

const telegram = {
  webhooks: new Map<string, string>(),
  failSetWebhook: false,
  reportUrl: null as string | null,
};

vi.mock('../../../server/services/channels/telegram/client.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getMe: vi.fn(async (token: string) => ({
      id: Number(token.split(':')[0]),
      username: `bot${token.split(':')[0]}`,
      firstName: `Bot ${token.split(':')[0]}`,
    })),
    setWebhook: vi.fn(async (token: string, url: string) => {
      if (telegram.failSetWebhook) throw new Error('Telegram rejected the webhook');
      telegram.webhooks.set(token, url);
    }),
    deleteWebhook: vi.fn(async (token: string) => {
      telegram.webhooks.delete(token);
    }),
    getWebhookInfo: vi.fn(async (token: string) => ({
      url: telegram.reportUrl ?? telegram.webhooks.get(token) ?? '',
      pending_update_count: 0,
      last_error_message: null,
      last_error_date: null,
    })),
  };
});

const { connectTelegramBot, TelegramConnectError } = await import(
  '../../../server/services/channels/telegram/setup.js'
);
const { TELEGRAM_BOT_TOKEN_KEY, TELEGRAM_BOT_TOKEN_PENDING_KEY, readPluginSecret, storePluginSecret } = await import(
  '../../../server/services/plugins/secrets.js'
);

const config: any = {
  channelsWebhookSigningKey: 'a'.repeat(64),
  pluginSecretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
  publicChannelsBaseUrl: 'https://channels.example.com',
};

const TOKEN_A = '111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_A2 = '111:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'; // same bot id, rotated
const TOKEN_B = '222:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function makeIntegration(suffix: string) {
  return db.newIntegration({
    id: `int_${suffix}`,
    public_integration_id: `pub_${suffix}`,
    workspace_id: `ws_${suffix}`,
    installation_id: `inst_${suffix}`,
  }) as any;
}

beforeEach(() => {
  db.integrations = [];
  db.secrets = [];
  db.failNextUpdate = null;
  telegram.webhooks.clear();
  telegram.failSetWebhook = false;
  telegram.reportUrl = null;
});

describe('cross-workspace bot ownership', () => {
  it('lets the first workspace own the bot', async () => {
    const one = makeIntegration('one');
    const result = await connectTelegramBot(config, one, TOKEN_A);

    expect(result.bot.id).toBe(111);
    expect(db.integration('int_one')!.status).toBe('connected');
    expect(db.integration('int_one')!.external_account_id).toBe('111');
  });

  it('rejects a second workspace connecting the same bot, with NO provider mutation', async () => {
    const one = makeIntegration('one');
    await connectTelegramBot(config, one, TOKEN_A);
    telegram.webhooks.clear();

    const two = makeIntegration('two');
    await expect(connectTelegramBot(config, two, TOKEN_A)).rejects.toMatchObject({ code: 'duplicate_bot' });

    // The loser never touched Telegram and never stole the credential slot.
    expect(telegram.webhooks.size).toBe(0);
    expect(db.integration('int_two')!.status).toBe('error');
    expect(db.integration('int_two')!.external_account_id).toBeNull();
    expect(db.secret('inst_two', TELEGRAM_BOT_TOKEN_KEY)).toBeUndefined();
    // The rightful owner is untouched.
    expect(db.integration('int_one')!.status).toBe('connected');
  });

  it('only one of two concurrent connects of the same bot can win', async () => {
    const one = makeIntegration('one');
    const two = makeIntegration('two');

    const results = await Promise.allSettled([
      connectTelegramBot(config, one, TOKEN_A),
      connectTelegramBot(config, two, TOKEN_A),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as any).code).toBe('duplicate_bot');
    expect(db.integrations.filter((r) => r.external_account_id === '111')).toHaveLength(1);
  });

  it('a different bot in another workspace is unaffected', async () => {
    const one = makeIntegration('one');
    const two = makeIntegration('two');
    await connectTelegramBot(config, one, TOKEN_A);
    await connectTelegramBot(config, two, TOKEN_B);

    expect(db.integration('int_two')!.status).toBe('connected');
    expect(db.integration('int_two')!.external_account_id).toBe('222');
  });
});

describe('atomic token replacement', () => {
  async function connected() {
    const row = makeIntegration('one');
    await connectTelegramBot(config, row, TOKEN_A);
    return db.integration('int_one') as any;
  }

  it('promotes the new token only after full verification', async () => {
    const live = await connected();
    const result = await connectTelegramBot(config, live, TOKEN_A2);

    expect(result.replacedPreviousToken).toBe(true);
    await expect(readPluginSecret(config, 'inst_one', TELEGRAM_BOT_TOKEN_KEY)).resolves.toBe(TOKEN_A2);
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeUndefined();
    expect(db.integration('int_one')!.status).toBe('connected');
  });

  it('keeps the working credential when the provider rejects the new webhook', async () => {
    const live = await connected();
    telegram.failSetWebhook = true;

    await expect(connectTelegramBot(config, live, TOKEN_A2)).rejects.toMatchObject({ code: 'set_webhook_failed' });

    await expect(readPluginSecret(config, 'inst_one', TELEGRAM_BOT_TOKEN_KEY)).resolves.toBe(TOKEN_A);
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeUndefined();
    expect(db.integration('int_one')!.status).toBe('connected');
    expect(db.integration('int_one')!.last_error_code).toBe('set_webhook_failed');
  });

  it('restores the old bot webhook when verification reports a different URL', async () => {
    const live = await connected();
    telegram.reportUrl = 'https://evil.example.com/hook';

    await expect(connectTelegramBot(config, live, TOKEN_A2)).rejects.toMatchObject({ code: 'webhook_url_mismatch' });

    // The rejected token's webhook is removed, the previous one re-registered.
    expect(telegram.webhooks.has(TOKEN_A2)).toBe(false);
    expect(telegram.webhooks.get(TOKEN_A)).toContain('/pub_one');
    await expect(readPluginSecret(config, 'inst_one', TELEGRAM_BOT_TOKEN_KEY)).resolves.toBe(TOKEN_A);
  });

  it('rolls the credential back when the final state transition fails', async () => {
    const live = await connected();
    db.failNextUpdate = 'channel_integrations';

    await expect(connectTelegramBot(config, live, TOKEN_A2)).rejects.toMatchObject({
      code: 'state_transition_failed',
    });

    await expect(readPluginSecret(config, 'inst_one', TELEGRAM_BOT_TOKEN_KEY)).resolves.toBe(TOKEN_A);
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeUndefined();
  });

  it('a first-time connect that fails leaves no credential behind', async () => {
    const fresh = makeIntegration('fresh');
    telegram.failSetWebhook = true;

    await expect(connectTelegramBot(config, fresh, TOKEN_B)).rejects.toBeInstanceOf(TelegramConnectError);

    expect(db.secret('inst_fresh', TELEGRAM_BOT_TOKEN_KEY)).toBeUndefined();
    expect(db.secret('inst_fresh', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeUndefined();
    expect(db.integration('int_fresh')!.status).toBe('error');
    // Ownership is released so a retry (or another workspace) can claim it.
    expect(db.integration('int_fresh')!.external_account_id).toBeNull();
  });

  it('never leaks the token into error messages', async () => {
    const fresh = makeIntegration('fresh');
    telegram.failSetWebhook = true;
    const err = await connectTelegramBot(config, fresh, TOKEN_B).catch((e) => e);
    expect(String(err.message)).not.toContain(TOKEN_B);
  });

  it('is idempotent when reconnecting the very same bot in the same workspace', async () => {
    const live = await connected();
    await expect(connectTelegramBot(config, live, TOKEN_A)).resolves.toMatchObject({ replacedPreviousToken: true });
    expect(db.integration('int_one')!.status).toBe('connected');
  });

  it('unused staged credentials never survive a failure', async () => {
    const live = await connected();
    await storePluginSecret(config, 'inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY, 'stale');
    telegram.failSetWebhook = true;
    await connectTelegramBot(config, live, TOKEN_A2).catch(() => {});
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeUndefined();
  });
});
