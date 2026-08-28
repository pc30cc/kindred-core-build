/**
 * Telegram connect lifecycle under PROVIDER NETWORK ISOLATION.
 *
 * Core no longer talks to Telegram: it stages the credential, decides
 * ownership against the DB, and commits the result the Channels Worker
 * reports. These tests drive the real Core services with a fake DB (the
 * production unique index + ownership RPCs) and a scripted "worker" that
 * plays the provider half, so the invariants that cannot regress stay pinned:
 *
 *  1. Core performs ZERO provider network I/O — enforced statically too;
 *  2. one bot belongs to exactly one workspace, decided by the DB and BEFORE
 *     any provider mutation happens;
 *  3. replacing a token is atomic — a failed attempt never destroys the
 *     working credential or the connected state, and the worker is told to
 *     roll the provider back.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChannelsDb } from './fakeChannelsDb.js';

const db = new FakeChannelsDb();

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => db.client(),
  getAnonClient: () => db.client(),
}));

/** In-memory provider-operation store + job queue (no DB, no network). */
const ops = new Map<string, any>();
let opSeq = 0;

vi.mock('../../../server/services/channels/operations.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    requestProviderOperation: async (_config: any, input: any) => {
      const operation = {
        id: `op-${++opSeq}`,
        provider: input.provider,
        operation: input.operation,
        workspace_id: input.workspaceId,
        integration_id: input.integrationId ?? null,
        installation_id: input.installationId ?? null,
        status: 'pending',
        request: input.request ?? {},
        result: null,
        error_code: null,
        error_message: null,
      };
      ops.set(operation.id, operation);
      return operation;
    },
    getOperation: async (_config: any, id: string) => ops.get(id) ?? null,
    completeOperation: async (_config: any, id: string, outcome: any) => {
      const operation = ops.get(id);
      if (!operation) return;
      operation.status = outcome.status;
      operation.result = outcome.result ?? null;
      operation.error_code = outcome.errorCode ?? null;
      operation.error_message = outcome.errorMessage ?? null;
    },
  };
});

const setup = await import('../../../server/services/channels/telegram/setup.js');
const { TelegramConnectError } = setup;
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

/** What the fake provider currently believes, so rollbacks are observable. */
const telegram = { webhooks: new Map<string, string>() };

function makeIntegration(suffix: string) {
  return db.newIntegration({
    id: `int_${suffix}`,
    public_integration_id: `pub_${suffix}`,
    workspace_id: `ws_${suffix}`,
    installation_id: `inst_${suffix}`,
  }) as any;
}

type WorkerScript = {
  /** Provider rejects setWebhook. */
  failSetWebhook?: boolean;
  /** getWebhookInfo reports this URL instead of the requested one. */
  reportUrl?: string;
};

/**
 * Plays the Channels Worker: identity → preflight → webhook → verify →
 * report, including the provider-side rollback Core asks for.
 */
async function runWorkerConnect(
  integration: any,
  token: string,
  script: WorkerScript = {},
): Promise<{ ok: boolean; code?: string }> {
  const operation = await setup.requestTelegramConnect(config, integration, token);
  const botId = token.split(':')[0];

  let preflight;
  try {
    preflight = await setup.connectPreflight(config, { operationId: operation.id, botId });
  } catch (err: any) {
    await setup.applyConnectFailure(config, ops.get(operation.id), {
      errorCode: err.code ?? 'preflight_failed',
      errorMessage: err.message,
    });
    return { ok: false, code: err.code };
  }

  const restorePrevious = async () => {
    if (!preflight!.hasPreviousToken) return;
    const live = await readPluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_KEY);
    if (live) telegram.webhooks.set(live, preflight!.webhookUrl);
  };

  if (script.failSetWebhook) {
    await setup.applyConnectFailure(config, ops.get(operation.id), {
      errorCode: 'set_webhook_failed',
      errorMessage: 'Telegram rejected the webhook',
    });
    await restorePrevious();
    return { ok: false, code: 'set_webhook_failed' };
  }
  telegram.webhooks.set(token, preflight.webhookUrl);

  if (script.reportUrl && script.reportUrl !== preflight.webhookUrl) {
    await setup.applyConnectFailure(config, ops.get(operation.id), {
      errorCode: 'webhook_url_mismatch',
      errorMessage: 'Telegram reports a different webhook URL',
    });
    telegram.webhooks.delete(token);
    await restorePrevious();
    return { ok: false, code: 'webhook_url_mismatch' };
  }

  const outcome = await setup.applyConnectSuccess(config, ops.get(operation.id), {
    botId: Number(botId),
    username: `bot${botId}`,
    firstName: `Bot ${botId}`,
    webhookUrl: preflight.webhookUrl,
  });

  if (outcome.ok !== true) {
    telegram.webhooks.delete(token);
    await restorePrevious();
    return { ok: false, code: (outcome as any).errorCode };
  }
  return { ok: true };
}

beforeEach(() => {
  db.integrations = [];
  db.secrets = [];
  db.failNextUpdate = null;
  ops.clear();
  opSeq = 0;
  telegram.webhooks.clear();
});

describe('provider network isolation', () => {
  it('Core-side setup imports no provider client at all', () => {
    const source = readFileSync('server/services/channels/telegram/setup.ts', 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*(import|export .*from)\b/.test(line));
    expect(imports.join('\n')).not.toMatch(/channels\/providers\//);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('api.telegram.org');
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it('a connect request only stages the credential and queues one operation', async () => {
    const one = makeIntegration('one');
    const operation = await setup.requestTelegramConnect(config, one, TOKEN_A);

    expect(operation.operation).toBe('connect');
    // Live slot untouched; the payload carries no credential.
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_KEY)).toBeUndefined();
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeDefined();
    expect(JSON.stringify(operation.request)).not.toContain(TOKEN_A);
    expect(db.integration('int_one')!.status).not.toBe('connected');
  });
});

describe('cross-workspace bot ownership', () => {
  it('lets the first workspace own the bot', async () => {
    const one = makeIntegration('one');
    const result = await runWorkerConnect(one, TOKEN_A);

    expect(result.ok).toBe(true);
    expect(db.integration('int_one')!.status).toBe('connected');
    expect(db.integration('int_one')!.external_account_id).toBe('111');
  });

  it('rejects a second workspace connecting the same bot, with NO provider mutation', async () => {
    const one = makeIntegration('one');
    await runWorkerConnect(one, TOKEN_A);
    telegram.webhooks.clear();

    const two = makeIntegration('two');
    const result = await runWorkerConnect(two, TOKEN_A);
    expect(result.code).toBe('duplicate_bot');

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

    const results = await Promise.all([runWorkerConnect(one, TOKEN_A), runWorkerConnect(two, TOKEN_A)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)!.code).toBe('duplicate_bot');
    expect(db.integrations.filter((r) => r.external_account_id === '111')).toHaveLength(1);
  });

  it('a different bot in another workspace is unaffected', async () => {
    const one = makeIntegration('one');
    const two = makeIntegration('two');
    await runWorkerConnect(one, TOKEN_A);
    await runWorkerConnect(two, TOKEN_B);

    expect(db.integration('int_two')!.status).toBe('connected');
    expect(db.integration('int_two')!.external_account_id).toBe('222');
  });
});

describe('atomic token replacement', () => {
  async function connected() {
    const row = makeIntegration('one');
    await runWorkerConnect(row, TOKEN_A);
    return db.integration('int_one') as any;
  }

  it('promotes the new token only after the worker confirms verification', async () => {
    const live = await connected();
    const result = await runWorkerConnect(live, TOKEN_A2);

    expect(result.ok).toBe(true);
    await expect(readPluginSecret(config, 'inst_one', TELEGRAM_BOT_TOKEN_KEY)).resolves.toBe(TOKEN_A2);
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeUndefined();
    expect(db.integration('int_one')!.status).toBe('connected');
  });

  it('keeps the working credential when the provider rejects the new webhook', async () => {
    const live = await connected();
    const result = await runWorkerConnect(live, TOKEN_A2, { failSetWebhook: true });

    expect(result.code).toBe('set_webhook_failed');
    await expect(readPluginSecret(config, 'inst_one', TELEGRAM_BOT_TOKEN_KEY)).resolves.toBe(TOKEN_A);
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeUndefined();
    expect(db.integration('int_one')!.status).toBe('connected');
    expect(db.integration('int_one')!.last_error_code).toBe('set_webhook_failed');
  });

  it('restores the old bot webhook when verification reports a different URL', async () => {
    const live = await connected();
    const result = await runWorkerConnect(live, TOKEN_A2, { reportUrl: 'https://evil.example.com/hook' });

    expect(result.code).toBe('webhook_url_mismatch');
    expect(telegram.webhooks.has(TOKEN_A2)).toBe(false);
    expect(telegram.webhooks.get(TOKEN_A)).toContain('/pub_one');
    await expect(readPluginSecret(config, 'inst_one', TELEGRAM_BOT_TOKEN_KEY)).resolves.toBe(TOKEN_A);
  });

  it('rolls the credential back when the final state transition fails', async () => {
    const live = await connected();
    db.failNextUpdate = 'channel_integrations';

    const result = await runWorkerConnect(live, TOKEN_A2);

    expect(result.code).toBe('state_transition_failed');
    await expect(readPluginSecret(config, 'inst_one', TELEGRAM_BOT_TOKEN_KEY)).resolves.toBe(TOKEN_A);
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeUndefined();
  });

  it('a first-time connect that fails leaves no credential behind', async () => {
    const fresh = makeIntegration('fresh');
    const result = await runWorkerConnect(fresh, TOKEN_B, { failSetWebhook: true });

    expect(result.ok).toBe(false);
    expect(db.secret('inst_fresh', TELEGRAM_BOT_TOKEN_KEY)).toBeUndefined();
    expect(db.secret('inst_fresh', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeUndefined();
    expect(db.integration('int_fresh')!.status).toBe('error');
    // Ownership is released so a retry (or another workspace) can claim it.
    expect(db.integration('int_fresh')!.external_account_id).toBeNull();
  });

  it('never leaks the token into an operation record or an error', async () => {
    const fresh = makeIntegration('fresh');
    await runWorkerConnect(fresh, TOKEN_B, { failSetWebhook: true });
    expect(JSON.stringify(Array.from(ops.values()))).not.toContain(TOKEN_B);
  });

  it('is idempotent when reconnecting the very same bot in the same workspace', async () => {
    const live = await connected();
    await expect(runWorkerConnect(live, TOKEN_A)).resolves.toMatchObject({ ok: true });
    expect(db.integration('int_one')!.status).toBe('connected');
  });

  it('unused staged credentials never survive a failure', async () => {
    const live = await connected();
    await storePluginSecret(config, 'inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY, 'stale');
    await runWorkerConnect(live, TOKEN_A2, { failSetWebhook: true });
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_PENDING_KEY)).toBeUndefined();
  });
});

describe('disconnect', () => {
  it('stops accepting ingest immediately, before the provider is reachable', async () => {
    const one = makeIntegration('one');
    await runWorkerConnect(one, TOKEN_A);

    const { operation } = await setup.requestTelegramDisconnect(config, 'inst_one');

    expect(db.integration('int_one')!.status).toBe('disconnected');
    expect(db.integration('int_one')!.external_account_id).toBeNull();
    // Credential still present: only the worker can remove the webhook.
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_KEY)).toBeDefined();
    expect(operation?.operation).toBe('disconnect');

    await setup.applyDisconnectResult(config, ops.get(operation!.id), { webhookRemoved: true });
    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_KEY)).toBeUndefined();
  });

  it('destroys the credential even when the provider webhook could not be removed', async () => {
    const one = makeIntegration('one');
    await runWorkerConnect(one, TOKEN_A);
    const { operation } = await setup.requestTelegramDisconnect(config, 'inst_one');

    await setup.applyDisconnectResult(config, ops.get(operation!.id), {
      webhookRemoved: false,
      errorCode: 'telegram_401',
      errorMessage: 'unauthorized',
    });

    expect(db.secret('inst_one', TELEGRAM_BOT_TOKEN_KEY)).toBeUndefined();
  });
});
