/**
 * Phase 15 — payment intent replay-safety (Iran billing redesign).
 *
 * `claimPaymentIntent` is the single gate between "gateway said it verified"
 * and "we applied a subscription/credit change". It must succeed exactly
 * once per intent — a second call (double-submit, provider retry) must be a
 * no-op, never a second subscription upsert or a second AI-credit grant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-in for `billing_payment_intents` rows, keyed by id.
let intents: Record<string, { id: string; status: string; amount_irr: number; expires_at: string }> = {};

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
        maybeSingle: async () => {
          const match = Object.values(intents).find((row) =>
            Object.entries(builder._filters).every(([k, v]) => (row as any)[k] === v),
          );
          if (builder._update && match) Object.assign(match, builder._update);
          return { data: match ? { id: match.id } : null, error: null };
        },
      };
      return builder;
    },
  }),
}));

import { claimPaymentIntent, isIntentUsable } from '../../../server/services/billing/paymentIntent';

const CFG = { supabaseUrl: 'http://stub', supabaseServiceRoleKey: 'key' } as any;

describe('claimPaymentIntent — replay safety', () => {
  beforeEach(() => {
    intents = { intent_1: { id: 'intent_1', status: 'pending', amount_irr: 15_000_000, expires_at: new Date(Date.now() + 60_000).toISOString() } };
  });

  it('claims a pending intent exactly once', async () => {
    const first = await claimPaymentIntent(CFG, 'intent_1');
    expect(first).toBe(true);
    expect(intents.intent_1.status).toBe('succeeded');
  });

  it('a second claim on the same intent is a no-op (replay-safe)', async () => {
    const first = await claimPaymentIntent(CFG, 'intent_1');
    const second = await claimPaymentIntent(CFG, 'intent_1');
    expect(first).toBe(true);
    expect(second).toBe(false);
    // Only ONE claim ever succeeded — the state was not double-applied.
    expect(intents.intent_1.status).toBe('succeeded');
  });

  it('never claims an already-failed intent', async () => {
    intents.intent_1.status = 'failed';
    const result = await claimPaymentIntent(CFG, 'intent_1');
    expect(result).toBe(false);
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
