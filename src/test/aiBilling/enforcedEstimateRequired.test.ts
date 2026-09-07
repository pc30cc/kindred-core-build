/**
 * AI Usage Billing — ENFORCED reservations must be priced, never placeholder.
 *
 * reserveForRun() used to fall through to a flat 1-unit reservation whenever
 * a caller omitted provider/model in its estimate — silently skipping the
 * rate-card check entirely. Two real callers did exactly that
 * (ensureIndexingRun for KB/crawler embeddings, operator-assist's initial
 * Run) until this fix, which is why embedding usage was never actually
 * billed even once ENFORCED. These tests drive the real beginAiRun/
 * beginAiRunGuarded against a Supabase client whose RPC succeeds, so the
 * validation now lives in reserveForRun() itself, not just in the callers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentMode: 'METER_ONLY' | 'ENFORCED' = 'ENFORCED';
let rateCard: any = { id: 'card-1', provider: 'openai', model_key: 'text-embedding-3-small', currency: 'USD', version: 1, components: [{ component_type: 'EMBEDDING_TOKENS', unit: 'TOKEN', unit_amount: '0.02', per_units: '1000000' }] };

vi.mock('../../../server/services/ai-billing/mode', () => ({
  getBillingMode: vi.fn(async () => currentMode),
}));

vi.mock('../../../server/services/ai-billing/rates', () => ({
  resolveSellPolicy: vi.fn(async () => ({ id: 'policy-1', multiplier: '4', overage_policy: 'CAP_AND_ABSORB' })),
  resolveFx: vi.fn(async () => ({ id: 'fx-1', rate: '2210600' })),
  resolveRateCard: vi.fn(async (_config: any, provider: string, model: string) => {
    if (rateCard && rateCard.provider === provider && rateCard.model_key === model) return rateCard;
    return null;
  }),
  priceComponent: vi.fn(() => ({ amount: 0n, matched: false })),
}));

const reserveCalls: any[] = [];
vi.mock('../../../server/services/ai-billing/ledger', () => ({
  reserve: vi.fn(async (_config: any, args: any) => {
    reserveCalls.push(args);
    return { reservation_id: 'res-1', reserved: 1 };
  }),
}));

vi.mock('../../../server/supabase', () => ({
  getServiceClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string) => {
      if (name === 'ai_begin_run') {
        return { data: [{ id: 'run-1', reservation_id: null, status: 'RUNNING', billing_quality: 'RESOLVED', sell_multiplier: '4', billing_fx_rate: '2210600', billing_fx_id: 'fx-1', overage_policy: 'CAP_AND_ABSORB' }], error: null };
      }
      return { data: null, error: null };
    }),
    from: () => ({ insert: async () => ({ data: null, error: null }) }),
  })),
}));

const config = { supabaseUrl: 'http://localhost', supabaseServiceRoleKey: 'k' } as any;
const baseArgs = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  operationKey: 'kb_index:web_page:src-1:2026090714',
  payload: { workspaceId: 'ws-1', sourceType: 'web_page', sourceId: 'src-1' },
  entryPoint: 'kb_index',
};

describe('AI billing — ENFORCED reservations require a priced estimate', () => {
  beforeEach(() => {
    currentMode = 'ENFORCED';
    reserveCalls.length = 0;
  });

  it('rejects an ENFORCED reservation with no provider/model estimate (the old ensureIndexingRun bug)', async () => {
    const { beginAiRun } = await import('../../../server/services/ai-billing/runContext');
    await expect(
      beginAiRun(config, { ...baseArgs, estimate: { promptChars: 0 } }),
    ).rejects.toMatchObject({ code: 'billing_estimate_missing' });
    expect(reserveCalls.length).toBe(0);
  });

  it('rejects an ENFORCED reservation for a model with no published rate card', async () => {
    const { beginAiRun } = await import('../../../server/services/ai-billing/runContext');
    await expect(
      beginAiRun(config, { ...baseArgs, estimate: { promptChars: 0, provider: 'openai', model: 'some-unpriced-model' } }),
    ).rejects.toMatchObject({ code: 'billing_rate_not_configured' });
    expect(reserveCalls.length).toBe(0);
  });

  it('opens and reserves normally when provider/model match a published rate card', async () => {
    const { beginAiRun } = await import('../../../server/services/ai-billing/runContext');
    const ctx = await beginAiRun(config, { ...baseArgs, estimate: { promptChars: 400, provider: 'openai', model: 'text-embedding-3-small' } });
    expect(ctx.runId).toBe('run-1');
    expect(reserveCalls.length).toBe(1);
  });

  it('under METER_ONLY, the same missing-estimate case never even reaches reservation (no ENFORCED check applies)', async () => {
    currentMode = 'METER_ONLY';
    const { beginAiRun } = await import('../../../server/services/ai-billing/runContext');
    const ctx = await beginAiRun(config, { ...baseArgs, estimate: { promptChars: 0 } });
    expect(ctx.runId).toBe('run-1');
    expect(reserveCalls.length).toBe(0);
  });

  it('beginAiRunGuarded: a missing-estimate ENFORCED denial propagates (never silently degrades)', async () => {
    const { beginAiRunGuarded } = await import('../../../server/services/ai-billing/runContext');
    await expect(
      beginAiRunGuarded(config, { ...baseArgs, estimate: { promptChars: 0 } }),
    ).rejects.toMatchObject({ code: 'billing_estimate_missing' });
  });
});
