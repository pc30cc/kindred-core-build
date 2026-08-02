/**
 * Phase 6-S5-R6 — durable entitlement fan-out.
 *
 * Covers the pure decision logic and the source-level contracts that make the
 * fan-out restart-safe: durable enqueue instead of `void (async …)`, keyset
 * pagination instead of offset, and lease-owned progress checkpoints.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  planChangeAffectsAiEntitlements,
  AI_RELEVANT_ENTITLEMENT_KEYS,
  FANOUT_KEYSET_PAGE_SIZE,
} from '../../../server/services/billing/entitlementFanout';
import { shouldEnqueueEntitlementCatchup } from '../../../server/services/billing/entitlementChange';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('plan-change AI relevance diff', () => {
  it('skips fan-out for edits that cannot affect AI access', () => {
    const plan = { is_active: true, entitlements: { ai_assistant: true }, limits: { seats: 5 } };
    expect(planChangeAffectsAiEntitlements(plan, { ...plan, limits: { seats: 9 } })).toBe(false);
    expect(planChangeAffectsAiEntitlements(plan, plan)).toBe(false);
  });

  it('fans out when an AI entitlement is granted or revoked', () => {
    for (const key of AI_RELEVANT_ENTITLEMENT_KEYS) {
      expect(planChangeAffectsAiEntitlements(
        { is_active: true, entitlements: { [key]: false }, limits: {} },
        { is_active: true, entitlements: { [key]: true }, limits: {} },
      )).toBe(true);
    }
  });

  it('treats knowledge_base as irrelevant — it is never plan-gated', () => {
    expect(planChangeAffectsAiEntitlements(
      { is_active: true, entitlements: { knowledge_base: false }, limits: {} },
      { is_active: true, entitlements: { knowledge_base: true }, limits: {} },
    )).toBe(false);
    expect(AI_RELEVANT_ENTITLEMENT_KEYS as readonly string[]).not.toContain('knowledge_base');
  });

  it('fans out when an AI-relevant limit or plan activation moves', () => {
    expect(planChangeAffectsAiEntitlements(
      { is_active: true, entitlements: {}, limits: { ai_knowledge_chunks_embedded: 50 } },
      { is_active: true, entitlements: {}, limits: { ai_knowledge_chunks_embedded: 500 } },
    )).toBe(true);
    // Phase 6-S5-R7 — activation can GRANT access, so it fans out...
    expect(planChangeAffectsAiEntitlements(
      { is_active: false, entitlements: {}, limits: {} },
      { is_active: true, entitlements: {}, limits: {} },
    )).toBe(true);
    // ...but deactivation is a pure revocation: nothing new to index.
    expect(planChangeAffectsAiEntitlements(
      { is_active: true, entitlements: {}, limits: {} },
      { is_active: false, entitlements: {}, limits: {} },
    )).toBe(false);
  });

  it('is conservative when the previous definition is unknown', () => {
    expect(planChangeAffectsAiEntitlements(null, { is_active: true })).toBe(true);
    expect(planChangeAffectsAiEntitlements(undefined, undefined)).toBe(true);
  });

  it('reads nested { enabled } entitlement shapes', () => {
    expect(planChangeAffectsAiEntitlements(
      { is_active: true, entitlements: { ai_assistant: { enabled: false } }, limits: {} },
      { is_active: true, entitlements: { ai_assistant: { enabled: true } }, limits: {} },
    )).toBe(true);
  });
});

describe('workspace transition semantics', () => {
  it('grants enqueue, revocations only clear cache', () => {
    expect(shouldEnqueueEntitlementCatchup({
      previousEffectiveAccess: false, nextEffectiveAccess: true, source: 'admin_assign',
    })).toBe(true);
    expect(shouldEnqueueEntitlementCatchup({
      previousEffectiveAccess: true, nextEffectiveAccess: false, source: 'admin_assign',
    })).toBe(false);
    expect(shouldEnqueueEntitlementCatchup({ source: 'admin_revoke' })).toBe(false);
    expect(shouldEnqueueEntitlementCatchup({ source: 'subscription_canceled' })).toBe(false);
  });
});

describe('durability contracts (source level)', () => {
  const fanout = read('server/services/billing/entitlementFanout.ts');
  const change = read('server/services/billing/entitlementChange.ts');
  const worker = read('worker/intelligence/index.ts');

  it('no fire-and-forget detach survives in the change funnel', () => {
    expect(change).not.toContain('void (async');
    expect(change).not.toContain('drainRemainder');
  });

  it('enqueues through the durable queue RPC before returning', () => {
    expect(fanout).toContain("rpc('enqueue_entitlement_fanout'");
    expect(change).toContain('enqueuePlanEntitlementFanout');
    expect(change).toContain('enqueuePlatformEntitlementFanout');
  });

  it('paginates by keyset cursor, never by offset', () => {
    expect(fanout).toContain(".gt('workspace_id', cursor)");
    expect(fanout).toContain(".gt('id', cursor)");
    expect(fanout).not.toContain('.range(');
    expect(FANOUT_KEYSET_PAGE_SIZE).toBeGreaterThan(0);
  });

  it('checkpoints progress under an owned, expiring lease', () => {
    expect(fanout).toContain("rpc('advance_entitlement_fanout'");
    expect(fanout).toContain("rpc('complete_entitlement_fanout'");
    expect(fanout).toContain("rpc('fail_entitlement_fanout'");
    expect(fanout).toContain('_claim_token: job.claim_token');
  });

  it('is drained by a background worker loop', () => {
    expect(worker).toContain('drainEntitlementFanoutJobs');
    expect(worker).toContain('drainFanoutJobs');
  });
});

describe('SQL contract', () => {
  const sql = read('database/migrations/007_entitlement_fanout_jobs.sql');

  it('enforces lease ownership AND expiration on every transition', () => {
    const guards = sql.match(/claim_expires_at > now\(\)/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
    const owners = sql.match(/worker_id = _worker_id/g) || [];
    expect(owners.length).toBeGreaterThanOrEqual(3);
  });

  it('claims only expired or unclaimed jobs, with SKIP LOCKED', () => {
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('j.claim_expires_at IS NULL OR j.claim_expires_at <= now()');
  });

  it('prevents duplicate active jobs per scope', () => {
    expect(sql).toContain('entitlement_fanout_jobs_active_plan_uq');
    expect(sql).toContain('entitlement_fanout_jobs_active_platform_uq');
  });

  it('pins search_path on every SECURITY DEFINER routine', () => {
    const definers = (sql.match(/SECURITY DEFINER/g) || []).length;
    const pinned = (sql.match(/SET search_path = public/g) || []).length;
    expect(definers).toBeGreaterThan(0);
    expect(pinned).toBeGreaterThanOrEqual(definers);
  });
});
