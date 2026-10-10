/**
 * The webhook route with a saved card's events (server/routes/billing.ts,
 * simple billing phase 3b). Paddle's subscription events and the
 * transactions a subscription makes arrive as `card_event`:
 *
 *   - whose they are comes from OUR records only (cardEventOwner: our card
 *     row, or our card checkout), never the workspace their copied
 *     custom_data names (P6). One that is not ours is acknowledged and
 *     nothing happens: never claimed, never handled, never cancelled;
 *   - ours is claimed (event type card_event, the owner's workspace),
 *     handled (handleCardEvent) and finalized; a replay is acknowledged as a
 *     duplicate, a failure answers 500 and is marked failed so Paddle retries;
 *   - a card event never reaches the account-payment branch or the invoice
 *     path, whatever intent or workspace it carries;
 *   - two verifying configs are ambiguous (400); a workspace's own config
 *     only verifies that workspace's cards;
 *   - an event of another kind naming only a subscription finds its
 *     workspace through the card of that subscription.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const CARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const h = vi.hoisted(() => ({
  verifyWebhook: vi.fn(),
  claim: vi.fn(),
  finalize: vi.fn(async (..._a: unknown[]) => undefined),
  processWebhookEvent: vi.fn(async (..._a: unknown[]) => undefined),
  cardEventOwner: vi.fn(),
  handleCardEvent: vi.fn(),
  accountWebhook: vi.fn(async (..._a: unknown[]) => 'settled'),
  readAccountPayment: vi.fn(async (..._a: unknown[]) => null as unknown),
  /** Workspace-scoped provider configs (provider_configs rows). */
  workspaceConfigs: [] as Array<{ workspace_id: string; config: Record<string, unknown> }>,
  platformConfig: { provider: 'paddle_sandbox', webhook_secret: 'pdl_ntfset_x' } as Record<string, unknown> | null,
  /** billing_account_cards rows the route may look a subscription up in. */
  cards: [] as Array<Record<string, unknown>>,
  tables: [] as string[],
}));

function fakeClient() {
  return {
    from(table: string) {
      h.tables.push(table);
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'in']) b[m] = () => b;
      b.eq = (col: string, value: unknown) => {
        filters[col] = value;
        return b;
      };
      b.maybeSingle = async () => {
        if (table === 'billing_account_cards') {
          const row = h.cards.find((c) => c.provider === filters.provider && c.subscription_id === filters.subscription_id);
          return { data: row ?? null, error: null };
        }
        return { data: null, error: null };
      };
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'provider_configs' ? h.workspaceConfigs : [], error: null });
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../../server/services/billing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/index.js')>()),
  getProvider: (name: string) =>
    name === 'paddle_sandbox' ? { name, capabilities: {}, verifyWebhook: h.verifyWebhook } : null,
  resolvePlatformBillingConfig: async () => h.platformConfig,
  claimBillingWebhookEvent: h.claim,
  finalizeBillingWebhookEvent: h.finalize,
  processWebhookEvent: h.processWebhookEvent,
}));
vi.mock('../../../../server/services/billing/account/card.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/card.js')>()),
  cardEventOwner: h.cardEventOwner,
  handleCardEvent: h.handleCardEvent,
}));
vi.mock('../../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/index.js')>()),
  readAccountPayment: h.readAccountPayment,
  findAccountPaymentByProviderPayment: async () => null,
  handleAccountPaymentWebhook: h.accountWebhook,
}));

const { billingWebhookRouter } = await import('../../../../server/routes/billing.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use('/api/billing/webhook', billingWebhookRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function post(body: unknown = { event_id: 'evt' }): Promise<{ status: number; json: Record<string, unknown> }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/billing/webhook/paddle_sandbox', method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(data || '{}') }));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** A card event as providers/paddle.ts maps it. */
function cardEvent(over: Record<string, unknown> = {}) {
  return {
    type: 'card_event',
    providerEventId: 'evt_card_1',
    providerSubscriptionId: 'sub_1',
    providerPaymentId: 'txn_renewal_1',
    workspaceId: WS,
    card: { eventType: 'transaction.paid', entity: 'transaction', subscriptionId: 'sub_1', customData: { workspace_id: WS } },
    raw: { event_id: 'evt_card_1' },
    ...over,
  };
}

const OWNER = { workspaceId: WS, cardId: CARD, setupPaymentId: null };

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.verifyWebhook.mockReset();
  h.claim.mockReset().mockResolvedValue({ claimed: true, eventRowId: 'row-1' });
  h.finalize.mockClear();
  h.processWebhookEvent.mockClear();
  h.cardEventOwner.mockReset().mockResolvedValue(OWNER);
  h.handleCardEvent.mockReset().mockResolvedValue('handled');
  h.accountWebhook.mockClear();
  h.readAccountPayment.mockReset().mockResolvedValue(null);
  h.workspaceConfigs = [];
  h.platformConfig = { provider: 'paddle_sandbox', webhook_secret: 'pdl_ntfset_x' };
  h.cards = [];
  h.tables.length = 0;
  warn?.mockRestore();
  error?.mockRestore();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('card events: ours', () => {
  it('claimed for the card owner, handled, finalized', async () => {
    h.verifyWebhook.mockResolvedValue(cardEvent());
    const res = await post();
    expect(res).toEqual({ status: 200, json: { received: true } });
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.claim.mock.calls[0][2]).toMatchObject({
      providerName: 'paddle_sandbox', providerEventId: 'evt_card_1', workspaceId: WS, eventType: 'card_event',
    });
    expect(h.handleCardEvent).toHaveBeenCalledTimes(1);
    expect(h.handleCardEvent.mock.calls[0][1]).toMatchObject({ providerName: 'paddle_sandbox', owner: OWNER });
    expect(h.finalize).toHaveBeenCalledWith('http://db', 'k', 'row-1', 'success');
    // Claimed before it was handled.
    expect(h.claim.mock.invocationCallOrder[0]).toBeLessThan(h.handleCardEvent.mock.invocationCallOrder[0]);
  });

  it('never goes down the account-payment branch or the invoice path, even naming an intent', async () => {
    h.verifyWebhook.mockResolvedValue(cardEvent({ intentId: 'acct-pay-1' }));
    h.readAccountPayment.mockResolvedValue({ id: 'acct-pay-1', workspace_id: WS, provider: 'paddle_sandbox', status: 'succeeded' });
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.accountWebhook).not.toHaveBeenCalled();
    expect(h.processWebhookEvent).not.toHaveBeenCalled();
    expect(h.readAccountPayment).not.toHaveBeenCalled();
    expect(h.handleCardEvent).toHaveBeenCalledTimes(1);
  });

  it('is handled for the card owner when its custom_data names another workspace (logged REVIEW)', async () => {
    h.verifyWebhook.mockResolvedValue(cardEvent({ workspaceId: OTHER_WS }));
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.claim.mock.calls[0][2]).toMatchObject({ workspaceId: WS });
    expect(h.handleCardEvent.mock.calls[0][1].event.workspaceId).toBe(WS);
    expect(error.mock.calls.flat().join(' ')).toMatch(/REVIEW .*names workspace 2222/);
  });

  it('the card checkout that created a subscription owns it before its card is registered', async () => {
    const setupOwner = { workspaceId: WS, cardId: null, setupPaymentId: 'pay-setup' };
    h.cardEventOwner.mockResolvedValue(setupOwner);
    h.verifyWebhook.mockResolvedValue(cardEvent({ card: { eventType: 'subscription.created', entity: 'subscription', subscriptionId: 'sub_1', transactionId: 'txn_checkout', customData: {} } }));
    expect((await post()).status).toBe(200);
    expect(h.handleCardEvent.mock.calls[0][1]).toMatchObject({ owner: setupOwner });
  });

  it('a replay is acknowledged as a duplicate and not handled again', async () => {
    h.claim.mockResolvedValue({ claimed: false });
    h.verifyWebhook.mockResolvedValue(cardEvent());
    const res = await post();
    expect(res).toEqual({ status: 200, json: { received: true, duplicate: true } });
    expect(h.handleCardEvent).not.toHaveBeenCalled();
  });

  it('a delivery still being handled elsewhere is not acknowledged (409): Paddle retries it', async () => {
    h.claim.mockResolvedValue({ claimed: false, inFlight: true });
    h.verifyWebhook.mockResolvedValue(cardEvent());
    expect((await post()).status).toBe(409);
    expect(h.handleCardEvent).not.toHaveBeenCalled();
  });

  it('a failure (Paddle not reachable) answers 500 and is marked failed, so the retry handles it', async () => {
    h.handleCardEvent.mockRejectedValue(new Error('Paddle subscription sub_1: timeout'));
    h.verifyWebhook.mockResolvedValue(cardEvent());
    const res = await post();
    expect(res.status).toBe(500);
    expect(h.finalize).toHaveBeenCalledWith('http://db', 'k', 'row-1', 'failed');
    expect(h.finalize).not.toHaveBeenCalledWith('http://db', 'k', 'row-1', 'success');
  });

  it('a failed claim answers 500 and handles nothing', async () => {
    h.claim.mockRejectedValue(new Error('db down'));
    h.verifyWebhook.mockResolvedValue(cardEvent());
    expect((await post()).status).toBe(500);
    expect(h.handleCardEvent).not.toHaveBeenCalled();
  });

  it('an event without a stable id is refused', async () => {
    h.verifyWebhook.mockResolvedValue(cardEvent({ providerEventId: '' }));
    expect((await post()).status).toBe(400);
    expect(h.cardEventOwner).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });
});

describe('card events: not ours', () => {
  it('a subscription this database never saw is acknowledged and left alone, even naming one of our workspaces', async () => {
    h.cardEventOwner.mockResolvedValue(null);
    h.verifyWebhook.mockResolvedValue(cardEvent({ workspaceId: WS }));
    const res = await post();
    expect(res).toEqual({ status: 200, json: { received: true, ignored: true } });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.handleCardEvent).not.toHaveBeenCalled();
    expect(h.processWebhookEvent).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/ignored provider=paddle_sandbox reason=foreign_card subscription=sub_1/);
  });

  it('whose it is cannot be read right now: 500, nothing claimed (never taken for foreign)', async () => {
    h.cardEventOwner.mockRejectedValue(new Error('db down'));
    h.verifyWebhook.mockResolvedValue(cardEvent());
    expect((await post()).status).toBe(500);
    expect(h.claim).not.toHaveBeenCalled();
  });
});

describe('card events: which config verified it', () => {
  it('two configs that both verify it are ambiguous', async () => {
    h.workspaceConfigs = [{ workspace_id: WS, config: { webhook_secret: 'a' } }];
    h.verifyWebhook.mockResolvedValue(cardEvent());
    expect((await post()).status).toBe(400);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.handleCardEvent).not.toHaveBeenCalled();
  });

  it("a workspace's own config verifies its own cards only", async () => {
    h.platformConfig = null;
    h.workspaceConfigs = [{ workspace_id: OTHER_WS, config: { webhook_secret: 'a' } }];
    h.verifyWebhook.mockResolvedValue(cardEvent({ workspaceId: undefined }));
    expect((await post()).status).toBe(400);
    expect(h.handleCardEvent).not.toHaveBeenCalled();
    h.workspaceConfigs = [{ workspace_id: WS, config: { webhook_secret: 'a' } }];
    expect((await post()).status).toBe(200);
    expect(h.handleCardEvent).toHaveBeenCalledTimes(1);
  });
});

describe('other events naming a subscription', () => {
  it('find their workspace through the card of that subscription', async () => {
    h.cards = [{ provider: 'paddle_sandbox', subscription_id: 'sub_9', workspace_id: WS }];
    h.verifyWebhook.mockResolvedValue({
      type: 'payment_succeeded', providerEventId: 'evt_other', providerSubscriptionId: 'sub_9', amount: 100, currency: 'USD', raw: {},
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.tables).toContain('billing_account_cards');
    expect(h.claim.mock.calls[0][2]).toMatchObject({ workspaceId: WS, eventType: 'payment_succeeded' });
  });

  it('a subscription of no card of ours leaves the workspace unresolved', async () => {
    h.verifyWebhook.mockResolvedValue({
      type: 'payment_succeeded', providerEventId: 'evt_other', providerSubscriptionId: 'sub_unknown', amount: 100, currency: 'USD', raw: {},
    });
    expect((await post()).status).toBe(400);
    expect(h.claim).not.toHaveBeenCalled();
  });
});
