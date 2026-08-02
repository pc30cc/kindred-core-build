/**
 * Phase 6-S5-R7.1 — generation-safe retry, hardened AI-KB responses.
 *
 * Complements the live-database suites: these assert the WORKER's decisions
 * and the route/DTO contract without needing PostgreSQL, so they run in the
 * default CI job too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rpcCalls: Array<{ fn: string; args: any }> = [];
let workspacePages: string[][] = [];
let pageCall = 0;
let claimRow: any = null;
let failOutcome: any = 'retry_same_generation';

vi.mock('../../../server/supabase', () => ({
  getServiceClient: () => ({
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (fn === 'claim_entitlement_fanout_jobs') return { data: claimRow ? [claimRow] : [], error: null };
      if (fn === 'fail_entitlement_fanout') return { data: failOutcome, error: null };
      if (fn === 'complete_entitlement_fanout') return { data: 'completed', error: null };
      return { data: true, error: null };
    },
    from: () => {
      const q: any = {
        select: () => q, eq: () => q, order: () => q, gt: () => q, limit: () => q,
        then: (res: any, rej: any) => {
          const idx = pageCall;
          pageCall += 1;
          return Promise.resolve({
            data: (workspacePages[idx] || []).map((id) => ({ id, workspace_id: id })),
            error: null,
          }).then(res, rej);
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
  classifyReleaseOutcome,
} from '../../../server/services/billing/entitlementFanout';
import { toPublicAiKbVisibility } from '../../../server/services/ai-kb/dto';

const config: any = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' };
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const baseJob = {
  id: 'job-1', scope: 'platform', source: 'platform_ai_toggle', plan_id: null,
  cursor_workspace_id: null, cursor_generation: null, attempts: 1,
  requested_generation: 3, processing_generation: 3,
  claim_token: 'token-1', claim_expires_at: new Date(Date.now() + 60000).toISOString(),
};
const lastCall = (fn: string) => [...rpcCalls].reverse().find((c) => c.fn === fn);

beforeEach(() => {
  rpcCalls.length = 0;
  workspacePages = [];
  pageCall = 0;
  claimRow = { ...baseJob };
  failOutcome = 'retry_same_generation';
});

describe('release outcomes', () => {
  it('maps every RPC encoding, including the legacy boolean', () => {
    expect(classifyReleaseOutcome(true)).toBe('retry_same_generation');
    expect(classifyReleaseOutcome('retry_same_generation')).toBe('retry_same_generation');
    expect(classifyReleaseOutcome('requeued_new_generation')).toBe('requeued_new_generation');
    expect(classifyReleaseOutcome('dead_lettered')).toBe('dead_lettered');
    // Anything else is a lost lease — never optimistically a success.
    expect(classifyReleaseOutcome(false)).toBe('lease_lost');
    expect(classifyReleaseOutcome('lease_lost')).toBe('lease_lost');
    expect(classifyReleaseOutcome(null)).toBe('lease_lost');
    expect(classifyReleaseOutcome(undefined)).toBe('lease_lost');
  });

  it('a release that requeued a NEWER generation is not counted as a plain retry', async () => {
    workspacePages = [[id(1), id(2)], [id(3), id(4)]];
    failOutcome = 'requeued_new_generation';
    const s = await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 2, pagesPerLease: 1,
    });
    expect(s.requeuedNewGeneration).toBe(1);
    expect(s.requeued).toBe(0);
    expect(s.leaseLost).toBe(0);
  });

  it('a dead-lettered release is not a lost lease', async () => {
    workspacePages = [[id(1)]];
    failOutcome = 'dead_lettered';
    claimRow = { ...baseJob, scope: 'plan', plan_id: null };
    const s = await drainEntitlementFanoutJobs(config, { workerId: 'w1', pageSize: 5 });
    expect(s.leaseLost).toBe(0);
    expect(s.permanentFailures).toBe(1);
  });
});

describe('generation-bound cursor', () => {
  it('discards a cursor produced by a different generation', async () => {
    // The DB already resets this, but the worker must not trust a stale row.
    claimRow = { ...baseJob, cursor_workspace_id: id(7), cursor_generation: 2 };
    workspacePages = [[id(1)]];
    const seen: string[] = [];
    await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 5,
      enqueueCatchup: async (w) => { seen.push(w); return { ok: true }; },
    });
    expect(seen).toEqual([id(1)]);
    // Completion reports the rescan's own boundary, not the stale cursor.
    expect(lastCall('complete_entitlement_fanout')!.args._cursor_workspace_id).toBe(id(1));
  });

  it('resumes from a cursor that belongs to the claimed generation', async () => {
    claimRow = { ...baseJob, cursor_workspace_id: id(7), cursor_generation: 3 };
    workspacePages = [[]];
    const s = await drainEntitlementFanoutJobs(config, { workerId: 'w1', pageSize: 5 });
    // Nothing left after the cursor: complete WITHOUT rewinding it to null.
    expect(s.completed).toBe(1);
    expect(lastCall('complete_entitlement_fanout')!.args._cursor_workspace_id).toBe(id(7));
    expect(lastCall('advance_entitlement_fanout')).toBeUndefined();
  });
});

describe('AI-KB visibility DTO', () => {
  it('never exposes the internal workspace id or article body', () => {
    const dto = toPublicAiKbVisibility({
      generatedStatus: 'published',
      kbArticleId: 'art-1',
      article: { status: 'published', locale: 'en', slug: 's' } as any,
      widgetVisible: true,
      reason: null,
    });
    expect(Object.keys(dto).sort()).toEqual([
      'generated_status', 'kb_article_id', 'kb_article_locale', 'kb_article_slug',
      'kb_article_status', 'widget_visible', 'reason_if_not_visible',
    ].sort());
    expect(JSON.stringify(dto)).not.toMatch(/workspace/);
  });

  it('reports a cross-workspace link as a verdict only', () => {
    const dto = toPublicAiKbVisibility({
      generatedStatus: 'published', kbArticleId: 'art-1',
      article: null, widgetVisible: false, reason: 'workspace_mismatch',
    });
    expect(dto.reason_if_not_visible).toBe('workspace_mismatch');
    expect(dto.kb_article_slug).toBeNull();
    expect(dto.kb_article_status).toBeNull();
  });
});

describe('AI-KB mutation routes', () => {
  const src = readFileSync(resolve(process.cwd(), 'server/routes/aiKb.ts'), 'utf8');

  it('every draft mutation goes through a transactional RPC', () => {
    expect(src).toMatch(/accept_ai_kb_generated_article/);
    expect(src).toMatch(/publish_ai_kb_generated_article/);
    expect(src).toMatch(/reject_ai_kb_generated_article/);
    // No two-step write remains on the accept/publish path.
    expect(src).not.toMatch(/upsertKbArticleFromGenerated/);
  });

  it('no mutation result is left unchecked', () => {
    const reject = src.match(/'\/generated\/:id\/reject'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(reject).toMatch(/if \(error\)/);
    expect(reject).toMatch(/result\.ok/);
    expect(reject).toMatch(/404/);
  });

  it('an unreadable row is a 503, never a 404 or a silent empty result', () => {
    const visibility = src.match(/'\/generated\/:id\/visibility'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(visibility).toMatch(/artError/);
    expect(visibility).toMatch(/503/);
    expect(visibility).toMatch(/toPublicAiKbVisibility/);

    const publishAll = src.match(/publish-all'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(publishAll).toMatch(/jobError/);
    expect(publishAll).toMatch(/ai_kb_status_unavailable/);
  });
});

describe('migration 009', () => {
  const sql = readFileSync(resolve(
    process.cwd(), 'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql'), 'utf8');

  it('binds the cursor to a generation and resets it otherwise', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS cursor_generation/);
    expect(sql).toMatch(/t\.cursor_generation = t\.requested_generation/);
  });

  it('serializes enqueue so concurrent first writers cannot duplicate a job', () => {
    expect(sql).toMatch(/pg_advisory_xact_lock/);
  });

  it('every new function pins search_path', () => {
    const bodies = sql.match(/CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?AS \$/g) || [];
    expect(bodies.length).toBeGreaterThan(5);
    for (const body of bodies) expect(body).toMatch(/SET search_path = public/);
  });
});
