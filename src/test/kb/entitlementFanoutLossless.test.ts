/**
 * Phase 6-S5-R7 — lossless fan-out, eligibility filtering and authoritative
 * indexing.
 *
 * These tests drive the REAL consumer loop (`drainEntitlementFanoutJobs`)
 * against a scripted Supabase client, so the cursor/counter contract is
 * proven on the shipped code path rather than restated in prose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: Array<{ fn: string; args: any }> = [];
let workspacePages: string[][] = [];
let pageErrorOnCall: number | null = null;
let pageCall = 0;
let claimRow: any = null;
let completeOutcome = 'completed';

vi.mock('../../../server/supabase', () => ({
  getServiceClient: () => ({
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (fn === 'claim_entitlement_fanout_jobs') return { data: claimRow ? [claimRow] : [], error: null };
      if (fn === 'complete_entitlement_fanout') return { data: completeOutcome, error: null };
      return { data: true, error: null };
    },
    from: () => {
      // The builder must stay chainable AFTER .limit(), exactly like
      // postgrest-js: the query resolves only when awaited.
      const q: any = {
        select: () => q, eq: () => q, order: () => q, gt: () => q, limit: () => q,
        then: (resolve: any, reject: any) => {
          const idx = pageCall;
          pageCall += 1;
          const result = pageErrorOnCall === idx
            ? { data: null, error: { code: 'XX000' } }
            : { data: (workspacePages[idx] || []).map((id) => ({ id, workspace_id: id })), error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return q;
    },
  }),
}));

vi.mock('../../../server/middleware/featureGating', () => ({
  clearEntitlementCache: () => {},
  checkModuleAccess: async () => ({ allowed: true }),
}));

vi.mock('../../../server/services/ai-agent/knowledgeIndex/kbEvents', () => ({
  enqueueKnowledgeBaseCatchup: async () => ({ ok: true, enqueued: 1 }),
}));

import {
  drainEntitlementFanoutJobs,
  classifyAiPlanChange,
  AI_INDEX_ENTITLEMENT_KEY,
} from '../../../server/services/billing/entitlementFanout';

const config: any = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' };
const ws = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
const id = (n: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const baseJob = {
  id: 'job-1', scope: 'platform', source: 'platform_ai_toggle', plan_id: null,
  cursor_workspace_id: null, attempts: 1,
  requested_generation: 3, processing_generation: 3,
  claim_token: 'token-1', claim_expires_at: new Date(Date.now() + 60000).toISOString(),
};

const lastCall = (fn: string) => [...rpcCalls].reverse().find((c) => c.fn === fn);

beforeEach(() => {
  rpcCalls.length = 0;
  workspacePages = [];
  pageErrorOnCall = null;
  pageCall = 0;
  claimRow = { ...baseJob };
  completeOutcome = 'completed';
});

describe('fan-out consumer — generation ownership', () => {
  it('carries the CLAIMED generation into every transition call', async () => {
    workspacePages = [[id(1)]];
    await drainEntitlementFanoutJobs(config, { workerId: 'w1', pageSize: 5 });
    const complete = lastCall('complete_entitlement_fanout');
    expect(complete!.args._generation).toBe(3);
    expect(complete!.args._claim_token).toBe('token-1');
  });

  it('reports a completion that was superseded by a newer generation', async () => {
    workspacePages = [[id(1)]];
    completeOutcome = 'requeued_new_generation';
    const s = await drainEntitlementFanoutJobs(config, { workerId: 'w1', pageSize: 5 });
    expect(s.requeuedNewGeneration).toBe(1);
    expect(s.completed).toBe(0);
  });

  it('treats a lost lease as lease_lost, never as success', async () => {
    workspacePages = [[id(1)]];
    completeOutcome = 'lease_lost';
    const s = await drainEntitlementFanoutJobs(config, { workerId: 'w1', pageSize: 5 });
    expect(s.leaseLost).toBe(1);
    expect(s.completed).toBe(0);
  });
});

describe('fan-out consumer — eligibility filtering', () => {
  it('only enqueues catch-up for workspaces with ai_assistant access', async () => {
    workspacePages = [[id(1), id(2), id(3)]];
    const seen: string[] = [];
    const s = await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 10,
      resolveEligibility: async (w) =>
        w === id(2) ? { kind: 'ineligible', reason: 'plan' } : { kind: 'eligible' },
      enqueueCatchup: async (w) => { seen.push(w); return { ok: true }; },
    });
    expect(seen).toEqual([id(1), id(3)]);
    expect(s.processed).toBe(2);
    expect(s.skippedIneligible).toBe(1);
    // A deliberate skip still advances the cursor — it is a decided outcome.
    expect(lastCall('complete_entitlement_fanout')!.args._cursor_workspace_id).toBe(id(3));
  });

  it('never counts an ineligible workspace as a failure', async () => {
    workspacePages = [[id(1)]];
    const s = await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 10,
      resolveEligibility: async () => ({ kind: 'ineligible', reason: 'plan' }),
    });
    expect(s.skippedIneligible).toBe(1);
    expect(s.retryableFailures).toBe(0);
    expect(s.permanentFailures).toBe(0);
  });
});

describe('fan-out consumer — success-boundary cursor', () => {
  it('stops at the first retryable failure and never advances past it', async () => {
    workspacePages = [[id(1), id(2), id(3), id(4)]];
    const seen: string[] = [];
    const s = await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 10,
      enqueueCatchup: async (w) => {
        seen.push(w);
        return { ok: w !== id(3) };
      },
    });
    // Workspace 4 is NOT attempted: it must stay behind the failure boundary.
    expect(seen).toEqual([id(1), id(2), id(3)]);
    expect(s.retryableFailures).toBe(1);
    // The cursor stops at the last SUCCESS (2), so 3 and 4 are both retried.
    const advance = lastCall('advance_entitlement_fanout');
    expect(advance!.args._cursor_workspace_id).toBe(id(2));
    expect(advance!.args._processed).toBe(2);
    expect(advance!.args._retryable_failures).toBe(1);
    // The job is released for retry, not completed.
    expect(lastCall('complete_entitlement_fanout')).toBeUndefined();
    expect(lastCall('fail_entitlement_fanout')!.args._error_code)
      .toBe('fanout_workspace_retryable');
  });

  it('treats an entitlement lookup failure as retryable, not as a denial', async () => {
    workspacePages = [[id(1), id(2)]];
    const s = await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 10,
      resolveEligibility: async (w) =>
        w === id(2) ? { kind: 'lookup_failed', reason: 'rpc_error' } : { kind: 'eligible' },
    });
    expect(s.retryableFailures).toBe(1);
    expect(s.skippedIneligible).toBe(0);
    expect(lastCall('advance_entitlement_fanout')!.args._cursor_workspace_id).toBe(id(1));
    expect(lastCall('complete_entitlement_fanout')).toBeUndefined();
  });

  it('a retryable release uses a huge attempt ceiling so the job is never dead-lettered', async () => {
    workspacePages = [[id(1)]];
    await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 10,
      enqueueCatchup: async () => ({ ok: false }),
    });
    expect(lastCall('fail_entitlement_fanout')!.args._max_attempts).toBeGreaterThan(1000);
  });
});

describe('fan-out consumer — final page accounting', () => {
  it('persists the last partial page through Complete, not a dropped advance', async () => {
    // Page size 2: a full page, then a short final page.
    workspacePages = [[id(1), id(2)], [id(3)]];
    const s = await drainEntitlementFanoutJobs(config, { workerId: 'w1', pageSize: 2 });
    expect(s.processed).toBe(3);
    const advance = lastCall('advance_entitlement_fanout');
    expect(advance!.args._processed).toBe(2);
    const complete = lastCall('complete_entitlement_fanout');
    // The final page's counters ride on Complete itself.
    expect(complete!.args._processed).toBe(1);
    expect(complete!.args._cursor_workspace_id).toBe(id(3));
    expect(s.completed).toBe(1);
  });

  it('an empty scope completes cleanly without inventing progress', async () => {
    workspacePages = [[]];
    const s = await drainEntitlementFanoutJobs(config, { workerId: 'w1', pageSize: 5 });
    expect(s.completed).toBe(1);
    expect(s.processed).toBe(0);
    expect(lastCall('advance_entitlement_fanout')).toBeUndefined();
  });

  it('a workspace-listing failure releases the job instead of completing it', async () => {
    workspacePages = [[id(1), id(2)]];
    pageErrorOnCall = 1;
    const s = await drainEntitlementFanoutJobs(config, { workerId: 'w1', pageSize: 2 });
    expect(s.lookupFailures).toBe(1);
    expect(s.completed).toBe(0);
    expect(lastCall('fail_entitlement_fanout')!.args._error_code).toBe('fanout_lookup_failed');
  });

  it('re-queues instead of completing when the lease page budget runs out', async () => {
    workspacePages = [[id(1), id(2)], [id(3), id(4)], [id(5), id(6)]];
    const s = await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 2, pagesPerLease: 2,
    });
    expect(s.requeued).toBe(1);
    expect(s.completed).toBe(0);
    expect(lastCall('fail_entitlement_fanout')!.args._error_code).toBe('fanout_requeued');
  });
});

describe('plan-change classification', () => {
  it('separates a grant from a revocation', () => {
    const grant = classifyAiPlanChange(
      { is_active: true, entitlements: { [AI_INDEX_ENTITLEMENT_KEY]: false } },
      { is_active: true, entitlements: { [AI_INDEX_ENTITLEMENT_KEY]: true } },
    );
    expect(grant.accessMayBeGranted).toBe(true);
    expect(grant.reindexRequired).toBe(true);

    const revoke = classifyAiPlanChange(
      { is_active: true, entitlements: { [AI_INDEX_ENTITLEMENT_KEY]: true } },
      { is_active: true, entitlements: { [AI_INDEX_ENTITLEMENT_KEY]: false } },
    );
    expect(revoke.accessRevoked).toBe(true);
    expect(revoke.reindexRequired).toBe(false);
  });

  it('ignores ai_kb_builder — it gates generation, not the index worker', () => {
    const impact = classifyAiPlanChange(
      { is_active: true, entitlements: { ai_kb_builder: false } },
      { is_active: true, entitlements: { ai_kb_builder: true } },
    );
    expect(impact.reindexRequired).toBe(false);
  });

  it('ignores price, name and other display-only edits', () => {
    const plan = { is_active: true, entitlements: { ai_assistant: true }, limits: {} };
    expect(classifyAiPlanChange(plan, { ...plan }).changed).toBe(false);
  });
});
