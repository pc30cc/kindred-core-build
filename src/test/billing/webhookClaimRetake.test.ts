/**
 * Provider webhook deliveries: who may process an event, and how often the
 * public endpoint may be called.
 *
 * A delivery claims its `billing_events` row before any financial side
 * effect. A row left in `received` by a crashed attempt must not block the
 * event forever: the provider's later retry takes it over — exactly one retry,
 * and only once the claim is stale. A delivery that arrives while another is
 * still working is not acknowledged, so the provider comes back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';

type EventRow = {
  id: string;
  provider_name: string;
  provider_event_id: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
};

/** In-memory `billing_events` with its unique (provider_name, provider_event_id) index. */
let rows: EventRow[] = [];
let now = Date.parse('2026-10-08T12:00:00.000Z');

function fakeEventsTable() {
  let op: 'select' | 'insert' | 'update' = 'select';
  let payload: Record<string, unknown> = {};
  const filters: Array<[string, unknown]> = [];
  const matching = () => rows.filter((r) => filters.every(([column, value]) => r[column] === value));
  const b: Record<string, unknown> = {
    insert(p: Record<string, unknown>) {
      op = 'insert';
      payload = p;
      return b;
    },
    update(p: Record<string, unknown>) {
      op = 'update';
      payload = p;
      return b;
    },
    select() {
      return b;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return b;
    },
    async single() {
      const taken = rows.some(
        (r) => r.provider_name === payload.provider_name && r.provider_event_id === payload.provider_event_id,
      );
      if (taken) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
      const row = { id: `row-${rows.length + 1}`, created_at: new Date(now).toISOString(), ...payload } as EventRow;
      rows.push(row);
      return { data: { id: row.id }, error: null };
    },
    async maybeSingle() {
      const hits = matching();
      if (op === 'update') {
        for (const r of hits) Object.assign(r, payload);
        return { data: hits[0] ? { id: hits[0].id } : null, error: null };
      }
      return { data: hits[0] ? { ...hits[0] } : null, error: null };
    },
  };
  return b;
}

vi.mock('../../../server/lib/serviceClient.js', () => ({
  serviceClientFor: () => ({ from: () => fakeEventsTable() }),
}));

const { claimBillingWebhookEvent, STALE_WEBHOOK_CLAIM_MS } = await import('../../../server/services/billing/index.js');
const { createBillingWebhookRateLimiter } = await import('../../../server/middleware/security.js');

const input = { providerName: 'stripe', providerEventId: 'evt_1', workspaceId: 'ws-1', eventType: 'payment_succeeded' };
const claim = () => claimBillingWebhookEvent('http://db', 'key', input);

describe('claimBillingWebhookEvent', () => {
  // Only the clock is faked; `now` moves it.
  const tick = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };
  beforeEach(() => {
    rows = [];
    now = Date.parse('2026-10-08T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('the first delivery claims the event; one arriving while it is processed is in flight, not a duplicate', async () => {
    expect(await claim()).toEqual({ claimed: true, eventRowId: 'row-1' });
    tick(30_000);
    expect(await claim()).toEqual({ claimed: false, inFlight: true });
  });

  it('a delivery whose processing finished is a duplicate', async () => {
    await claim();
    rows[0].status = 'success';
    expect(await claim()).toEqual({ claimed: false, duplicate: true });
  });

  it('a row stuck in `received` after a crash is taken over by a retry once it is stale', async () => {
    await claim();
    tick(STALE_WEBHOOK_CLAIM_MS + 1_000);
    expect(await claim()).toEqual({ claimed: true, eventRowId: 'row-1' });
    // The take-over is a fresh claim: the next delivery waits for it.
    expect(rows[0].created_at).toBe(new Date(now).toISOString());
    expect(rows[0].status).toBe('received');
    tick(1_000);
    expect(await claim()).toEqual({ claimed: false, inFlight: true });
  });

  it('exactly one of two concurrent retries takes a stale row over', async () => {
    await claim();
    tick(STALE_WEBHOOK_CLAIM_MS + 1_000);
    const results = await Promise.all([claim(), claim()]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results).toContainEqual({ claimed: false, inFlight: true });
  });

  it('a failed row is taken back by the retry, and that claim is not itself stale', async () => {
    await claim();
    rows[0].status = 'failed';
    tick(60 * 60 * 1000);
    expect(await claim()).toEqual({ claimed: true, eventRowId: 'row-1' });
    expect(rows[0].created_at).toBe(new Date(now).toISOString());
    expect(await claim()).toEqual({ claimed: false, inFlight: true });
  });
});

describe('billing webhook rate limit', () => {
  it('answers 429 once one address exceeds the ceiling', async () => {
    const app = express();
    app.use('/api/billing/webhook', createBillingWebhookRateLimiter(3), (_req, res) => {
      res.json({ received: true });
    });
    const server = http.createServer(app).listen(0);
    const port = (server.address() as { port: number }).port;
    const post = () =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/billing/webhook/paypal', method: 'POST', headers: { connection: 'close' } },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode || 0));
          },
        );
        req.on('error', reject);
        req.end('{}');
      });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) statuses.push(await post());
      expect(statuses).toEqual([200, 200, 200, 429]);
    } finally {
      server.close();
    }
  });
});
