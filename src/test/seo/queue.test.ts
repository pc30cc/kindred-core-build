/**
 * server/services/jobs/queue.ts — the generic job queue the SEO crawler
 * shares with any future worker kind. Proves the two properties the spec
 * calls out explicitly: (1) validation/security failures (invalid_target,
 * blocked_target) are NEVER retried even when the caller asks for a retry,
 * and (2) a job that has exhausted max_attempts is never handed out again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: Record<string, any> = {};

function makeSb() {
  return {
    from: (_name: string) => {
      const filters: Record<string, unknown> = {};
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
        in: () => chain,
        update: (patch: Record<string, unknown>) => {
          // Every .eq()/.in() call on the update chain is an AND-ed condition
          // against the same target row (matching how the real code always
          // scopes an update by id + status).
          let targetId: string | undefined;
          let ok = true;
          const updateChain: any = {
            eq: (col: string, val: unknown) => {
              if (col === 'id') targetId = val as string;
              else if (!targetId || rows[targetId]?.[col] !== val) ok = false;
              return updateChain;
            },
            in: (col: string, vals: unknown[]) => {
              if (!targetId || !vals.includes(rows[targetId]?.[col])) ok = false;
              return updateChain;
            },
            select: () => updateChain,
            maybeSingle: async () => {
              if (ok && targetId && rows[targetId]) Object.assign(rows[targetId], patch);
              return { data: ok && targetId ? rows[targetId] || null : null, error: null };
            },
          };
          return updateChain;
        },
        maybeSingle: async () => ({ data: rows[filters.id as string] || null, error: null }),
      };
      return chain;
    },
  };
}

let fakeSb: any = makeSb();
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

const { failJob } = await import('../../../server/services/jobs/queue.js');

describe('failJob — retry policy', () => {
  beforeEach(() => {
    fakeSb = makeSb();
    rows = {
      'job-1': { id: 'job-1', status: 'running', attempts: 1, max_attempts: 3 },
      'job-2': { id: 'job-2', status: 'running', attempts: 1, max_attempts: 3 },
      'job-3': { id: 'job-3', status: 'completed', attempts: 1, max_attempts: 3 },
    };
  });

  it('never retries a blocked_target failure even when retryable=true is requested', async () => {
    const res = await failJob({} as any, { jobId: 'job-1', errorMessage: 'ssrf blocked', errorCategory: 'blocked_target', retryable: true });
    expect(res.finalStatus).toBe('failed');
    expect(rows['job-1'].status).toBe('failed');
  });

  it('never retries an invalid_target failure', async () => {
    const res = await failJob({} as any, { jobId: 'job-2', errorMessage: 'site not found', errorCategory: 'invalid_target', retryable: true });
    expect(res.finalStatus).toBe('failed');
  });

  it('retries a genuinely transient failure (timeout) when attempts remain', async () => {
    const res = await failJob({} as any, { jobId: 'job-1', errorMessage: 'timed out', errorCategory: 'timeout', retryable: true });
    expect(res.finalStatus).toBe('queued');
  });

  it('does not retry a transient failure once max_attempts is exhausted', async () => {
    rows['job-1'].attempts = 3;
    const res = await failJob({} as any, { jobId: 'job-1', errorMessage: 'timed out', errorCategory: 'timeout', retryable: true });
    expect(res.finalStatus).toBe('failed');
  });

  it('never overwrites an already-terminal job (completed stays completed)', async () => {
    const res = await failJob({} as any, { jobId: 'job-3', errorMessage: 'late failure', errorCategory: 'internal_error', retryable: true });
    expect(res.updated).toBe(false);
    expect(res.finalStatus).toBe('completed');
    expect(rows['job-3'].status).toBe('completed');
  });
});
