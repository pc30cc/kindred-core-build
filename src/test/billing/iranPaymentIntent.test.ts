/**
 * Payment intent state machine — replay safety and crash recovery.
 *
 * `claimIntentForProcessing` is the single gate between "gateway said it
 * verified" and "we applied a subscription/credit change". It must claim
 * exactly once per intent, so a double-submit or provider retry can never
 * produce a second subscription period or a second AI-credit grant.
 *
 * `succeeded` is written separately (markIntentSucceeded), only AFTER the
 * financial side effect landed — a crash in between leaves a recoverable
 * `processing` row instead of a paid customer with nothing granted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-in for `billing_payment_intents` rows, keyed by id.
type IntentRow = { id: string; status: string; amount_irr: number; expires_at: string; processing_at?: string | null };
let intents: Record<string, IntentRow> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      if (table !== 'billing_payment_intents') throw new Error(`unexpected table ${table}`);
      const builder: any = {
        _filters: {} as Record<string, unknown>,
        _update: undefined as any,
        eq(field: string, value: unknown) {
          this._filters[field] = value;
          return this;
        },
        select() { return this; },
        update(payload: any) {
          this._update = payload;
          return this;
        },
        in(field: string, values: unknown[]) {
          this._in = { field, values };
          return this;
        },
        _in: undefined as any,
        // Awaiting the builder without `.maybeSingle()` (plain update) must
        // apply the same filters — that is how markIntentSucceeded runs.
        then(resolve: any, reject: any) {
          return builder.maybeSingle().then(resolve, reject);
        },
        maybeSingle: async () => {
          const match = Object.values(intents).find((row) => {
            const eqOk = Object.entries(builder._filters).every(([k, v]) => (row as any)[k] === v);
            const inOk = !builder._in || builder._in.values.includes((row as any)[builder._in.field]);
            return eqOk && inOk;
          });
          if (builder._update && match) Object.assign(match, builder._update);
          return { data: match ? { ...match } : null, error: null };
        },
      };
      return builder;
    },
  }),
}));

import {
  claimIntentForProcessing,
  markIntentSucceeded,
  isIntentUsable,
} from '../../../server/services/billing/paymentIntent';

const CFG = { supabaseUrl: 'http://stub', supabaseServiceRoleKey: 'key' } as any;

describe('claimIntentForProcessing — replay safety', () => {
  beforeEach(() => {
    intents = {
      intent_1: {
        id: 'intent_1',
        status: 'pending',
        amount_irr: 15_000_000,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        processing_at: null,
      },
    };
  });

  it('claims a pending intent exactly once and leaves it processing', async () => {
    const first = await claimIntentForProcessing(CFG, 'intent_1');
    expect(first).toEqual({ claimed: true, resumed: false });
    expect(intents.intent_1.status).toBe('processing');
  });

  it('a concurrent second claim is refused while the first is in flight', async () => {
    const first = await claimIntentForProcessing(CFG, 'intent_1');
    const second = await claimIntentForProcessing(CFG, 'intent_1');
    expect(first.claimed).toBe(true);
    expect(second).toEqual({ claimed: false, reason: 'in_flight' });
    expect(intents.intent_1.status).toBe('processing');
  });

  it('re-claims a crashed finalization once the processing lease went stale', async () => {
    await claimIntentForProcessing(CFG, 'intent_1');
    // Simulate the process dying mid-finalization two minutes ago.
    intents.intent_1.processing_at = new Date(Date.now() - 120_000).toISOString();
    const retry = await claimIntentForProcessing(CFG, 'intent_1');
    expect(retry).toEqual({ claimed: true, resumed: true });
  });

  it('never claims an already-finalized intent', async () => {
    for (const status of ['succeeded', 'failed', 'expired', 'canceled']) {
      intents.intent_1.status = status;
      intents.intent_1.processing_at = null;
      const result = await claimIntentForProcessing(CFG, 'intent_1');
      expect(result).toEqual({ claimed: false, reason: 'already_finalized' });
    }
  });

  it('marks success only from pending/processing, never resurrecting a failed intent', async () => {
    await claimIntentForProcessing(CFG, 'intent_1');
    await markIntentSucceeded(CFG, 'intent_1');
    expect(intents.intent_1.status).toBe('succeeded');

    intents.intent_1.status = 'failed';
    await markIntentSucceeded(CFG, 'intent_1');
    expect(intents.intent_1.status).toBe('failed');
  });
});

describe('isIntentUsable', () => {
  it('rejects an already-succeeded intent', () => {
    expect(isIntentUsable({ status: 'succeeded', expires_at: new Date(Date.now() + 60_000).toISOString() } as any)).toBe(false);
  });

  it('rejects an expired pending intent', () => {
    expect(isIntentUsable({ status: 'pending', expires_at: new Date(Date.now() - 1000).toISOString() } as any)).toBe(false);
  });

  it('accepts a pending, unexpired intent', () => {
    expect(isIntentUsable({ status: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString() } as any)).toBe(true);
  });
});
