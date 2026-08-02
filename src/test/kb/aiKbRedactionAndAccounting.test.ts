/**
 * Phase 6-S5-R5 — public DTO redaction + exact lease accounting invariants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  toPublicAiKbJob,
  toPublicAiKbPage,
  toPublicAiKbJobEvent,
  toPublicErrorCode,
  AI_KB_JOB_COLUMNS,
} from '../../../server/services/ai-kb/dto';
import { accountOwnedTransition } from '../../../server/services/ai-agent/knowledgeIndex/kbEvents';

const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('AI KB public DTOs redact internal state', () => {
  const row = {
    id: 'j1', workspace_id: 'w1', status: 'failed',
    source_kind: 'workspace_domain', source_domain: 'example.com', locale: 'en',
    progress: 40, pages_discovered: 10, pages_crawled: 4, pages_failed: 1,
    articles_generated: 0,
    error_message: 'OpenAI 401 sk-live-SECRET at /worker/crawl.ts:88',
    created_at: 't', updated_at: 't', completed_at: null,
    // fields that must never survive mapping:
    worker_id: 'worker-7', plan_snapshot: { monthlyCredits: 100 },
    claimed_at: 't', requested_by: 'u1', admin_override: true,
  } as any;

  it('never leaks raw errors, worker ids, plan snapshots or claim data', () => {
    const dto = toPublicAiKbJob(row);
    const json = JSON.stringify(dto);
    expect(json).not.toContain('sk-live-SECRET');
    expect(json).not.toContain('worker-7');
    expect(json).not.toContain('plan_snapshot');
    expect(json).not.toContain('claimed_at');
    expect(json).not.toContain('requested_by');
    expect(json).not.toContain('admin_override');
  });

  it('replaces raw failures with a stable public error code', () => {
    expect(toPublicAiKbJob(row).error_code).toBeTruthy();
    expect(toPublicErrorCode({ status: 'completed', errorMessage: null })).toBeNull();
    expect(toPublicErrorCode({ status: 'failed', errorMessage: 'robots.txt blocked' }))
      .toBe('crawl_failed');
  });

  it('drops free-form job event messages entirely', () => {
    const dto = toPublicAiKbJobEvent({
      id: 'e1', job_id: 'j1', level: 'error',
      message: 'provider payload {"key":"sk-live"}', created_at: 't',
    });
    expect(JSON.stringify(dto)).not.toContain('sk-live');
    expect((dto as Record<string, unknown>).message).toBeUndefined();
  });

  it('redacts page-level error text', () => {
    const dto = toPublicAiKbPage({
      id: 'p1', job_id: 'j1', url: 'https://example.com/a', title: null,
      status: 'failed', depth: 1, http_status: 500,
      error_message: 'ECONNREFUSED 10.0.0.5:5432', fetched_at: null, created_at: 't',
    });
    expect(JSON.stringify(dto)).not.toContain('10.0.0.5');
    expect(dto.error_code).toBeTruthy();
  });

  it('routes select explicit columns and map through the DTOs', () => {
    const src = read('server/routes/aiKb.ts');
    expect(AI_KB_JOB_COLUMNS).not.toContain('plan_snapshot');
    expect(AI_KB_JOB_COLUMNS).not.toContain('worker_id');
    expect(src).toMatch(/toPublicAiKbJob/);
    expect(src).toMatch(/toPublicAiKbPage/);
    expect(src).toMatch(/toPublicAiKbGenerated/);
    expect(src).toMatch(/toPublicAiKbJobEvent/);
    // Diagnostics must not surface worker identity or raw errors.
    expect(src).not.toMatch(/latest_worker_id/);
    expect(src).not.toMatch(/latest_error:/);
  });
});

describe('Outbox lease accounting is exact', () => {
  it('counts full, partial and total lease loss precisely', () => {
    expect(accountOwnedTransition(3, 3)).toEqual({
      succeeded: 3, leaseLost: 0, invariantViolation: false,
    });
    expect(accountOwnedTransition(3, 0)).toEqual({
      succeeded: 0, leaseLost: 3, invariantViolation: false,
    });
    expect(accountOwnedTransition(3, 2)).toEqual({
      succeeded: 2, leaseLost: 1, invariantViolation: false,
    });
  });

  it('clamps and flags an impossible over-count instead of trusting it', () => {
    const r = accountOwnedTransition(2, 5);
    expect(r.invariantViolation).toBe(true);
    expect(r.succeeded).toBe(2);
    expect(r.leaseLost).toBe(0);
  });

  it('groups claims by workspace AND claim token', () => {
    const src = read('server/services/ai-agent/knowledgeIndex/kbEvents.ts');
    expect(src).toMatch(/byOwnedGroup/);
    expect(src).toMatch(/claim\.workspaceId\}::\$\{claim\.claimToken/);
    expect(src).not.toMatch(/const byWorkspace =/);
  });

  it('only counts a workspace as reindexed on a full-group completion', () => {
    const src = read('server/services/ai-agent/knowledgeIndex/kbEvents.ts');
    expect(src).toMatch(/acct\.succeeded === ids\.length/);
  });
});

describe('Rebuild terminal state is authoritative', () => {
  const src = read('server/services/ai-agent/knowledgeIndex/sync.ts');

  it('fails the rebuild when any source query fails', () => {
    expect(src).toMatch(/kb_article_query_failed/);
    expect(src).toMatch(/qna_query_failed/);
    expect(src).toMatch(/business_profile_query_failed/);
  });

  it('treats a failed Q&A query as untrusted rather than an empty set', () => {
    expect(src).toMatch(/qnasError \? \[\] : \(qnas \|\| \[\]\)/);
  });

  it('propagates indexer write failures into the terminal state', () => {
    expect(src).toMatch(/indexWritesTrustworthy = false/);
    expect(src).toMatch(/applyIndexResult/);
  });
});
