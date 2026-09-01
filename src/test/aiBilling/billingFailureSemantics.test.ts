/**
 * AI Usage Billing — failure semantics of the BILLING DATABASE itself.
 *
 * The rule is asymmetric on purpose:
 *
 *   METER_ONLY — billing is observational. If the financial database is down,
 *                the AI product keeps serving; the loss is counted and audited
 *                so it can be reconciled later. Availability wins.
 *   ENFORCED   — billing is authority. If the financial authority cannot be
 *                reached BEFORE provider execution, the operation fails closed
 *                and no billable provider call happens. Correctness wins.
 *
 * These tests drive the real beginAiRunGuarded with a Supabase client whose
 * RPCs fail, so a regression in either direction is caught.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentMode: 'METER_ONLY' | 'ENFORCED' = 'METER_ONLY';
const inserted: Array<{ table: string; row: any }> = [];

vi.mock('../../../server/services/ai-billing/mode', () => ({
  getBillingMode: vi.fn(async () => currentMode),
}));

vi.mock('../../../server/services/ai-billing/rates', () => ({
  resolveSellPolicy: vi.fn(async () => ({ id: 'policy-1', multiplier: '1.2', overage_policy: 'CAP_AND_ABSORB' })),
  resolveFx: vi.fn(async () => ({ id: 'fx-1', rate: '600000' })),
  resolveRateCard: vi.fn(async () => null),
  priceComponent: vi.fn(),
}));

vi.mock('../../../server/supabase', () => ({
  getServiceClient: vi.fn(() => ({
    // The financial RPC layer is unavailable.
    rpc: vi.fn(async () => ({ data: null, error: { message: 'connection refused' } })),
    from: (table: string) => ({
      insert: async (row: any) => {
        inserted.push({ table, row });
        return { data: null, error: null };
      },
    }),
  })),
}));

const config = { supabaseUrl: 'http://localhost', supabaseServiceRoleKey: 'k' } as any;

const args = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  operationKey: 'agent_turn:conv-1:msg-1',
  payload: { question: 'salam' },
  entryPoint: 'agent_turn',
};

describe('AI billing — billing database failure semantics', () => {
  beforeEach(async () => {
    inserted.length = 0;
    const { resetBillingDegradation } = await import('../../../server/services/ai-billing/degrade');
    resetBillingDegradation();
  });

  it('METER_ONLY: keeps AI available when the billing DB fails, and records the loss', async () => {
    currentMode = 'METER_ONLY';
    const { beginAiRunGuarded } = await import('../../../server/services/ai-billing/runContext');
    const { getBillingDegradation } = await import('../../../server/services/ai-billing/degrade');

    const ctx = await beginAiRunGuarded(config, args);

    // No run — but no exception either: the caller proceeds with the AI work.
    expect(ctx).toBeNull();

    const degradation = getBillingDegradation();
    expect(degradation.total).toBe(1);
    expect(degradation.byStage.begin_run).toBe(1);
    // The entry carries enough identity to reconcile the missing usage.
    expect(degradation.recent[0]).toMatchObject({
      stage: 'begin_run',
      workspaceId: args.workspaceId,
      entryPoint: 'agent_turn',
      operationKey: args.operationKey,
    });

    // And it is persisted as a structured Health/audit entry (best effort).
    const audit = inserted.find((i) => i.table === 'ai_billing_audit_log');
    expect(audit?.row.action).toBe('billing_unavailable');
    expect(audit?.row.details).toMatchObject({ stage: 'begin_run', entry_point: 'agent_turn' });
  });

  it('ENFORCED: fails closed before any billable provider call', async () => {
    currentMode = 'ENFORCED';
    const { beginAiRunGuarded } = await import('../../../server/services/ai-billing/runContext');
    const { getBillingDegradation } = await import('../../../server/services/ai-billing/degrade');

    await expect(beginAiRunGuarded(config, args)).rejects.toThrow();

    // Nothing was swallowed: no degraded-but-served entry in ENFORCED.
    expect(getBillingDegradation().total).toBe(0);
  });
});
