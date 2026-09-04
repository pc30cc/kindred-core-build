import { describe, it, expect, vi } from 'vitest';
import {
  touchVisitorLiveness,
  isMissingRpcError,
  VISITOR_LIVENESS_REFRESH_MS,
} from './visitorLiveness';

/**
 * Faithful in-memory model of public.visitor_touch_liveness, including the
 * FOR NO KEY UPDATE row lock: concurrent callers for the same session queue on
 * the row and each one observes the state left by the previous winner.
 */
function makeFakeDb(row: { lastSeenAt: number; currentPage: string | null }) {
  const writes = { sessions: 0, presence: 0 };
  let chain: Promise<unknown> = Promise.resolve();

  const rpc = vi.fn(async (_fn: string, args: any) => {
    // serialize on the row lock
    const run = chain.then(async () => {
      await new Promise((r) => setTimeout(r, 0)); // force interleaving attempts
      const now = Date.now();
      const pageChanged =
        args.p_current_page != null && args.p_current_page !== row.currentPage;
      const stale = now - row.lastSeenAt >= args.p_min_interval_ms;
      let wrote = false;
      if (pageChanged || stale) {
        row.lastSeenAt = now;
        if (args.p_current_page != null) row.currentPage = args.p_current_page;
        writes.sessions += 1;
        writes.presence += 1;
        wrote = true;
      }
      return { data: [{ matched: true, page_changed: pageChanged, wrote }], error: null };
    });
    chain = run.catch(() => {});
    return run;
  });

  return { client: { rpc } as any, writes, rpcMock: rpc, row };
}

const base = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  sessionId: '22222222-2222-2222-2222-222222222222',
  visitorId: 'v-1',
};

describe('touchVisitorLiveness — concurrency', () => {
  it('collapses 20 simultaneous same-page heartbeats on a stale row to ONE write', async () => {
    const db = makeFakeDb({ lastSeenAt: Date.now() - 10 * 60_000, currentPage: '/pricing' });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        touchVisitorLiveness(db.client, { ...base, currentPage: '/pricing' }),
      ),
    );

    expect(db.writes.sessions).toBe(1);
    expect(db.writes.presence).toBe(1);
    // every caller still gets a correct answer
    expect(results.every((r) => r.matched)).toBe(true);
    expect(results.filter((r) => r.wrote)).toHaveLength(1);
    expect(results.every((r) => r.pageChanged === false)).toBe(true);
  });

  it('10 simultaneous heartbeats on a fresh row write nothing', async () => {
    const db = makeFakeDb({ lastSeenAt: Date.now(), currentPage: '/a' });
    await Promise.all(
      Array.from({ length: 10 }, () => touchVisitorLiveness(db.client, { ...base, currentPage: '/a' })),
    );
    expect(db.writes.sessions).toBe(0);
  });

  it('navigation always writes immediately, even on a fresh row', async () => {
    const db = makeFakeDb({ lastSeenAt: Date.now(), currentPage: '/a' });
    const r = await touchVisitorLiveness(db.client, { ...base, currentPage: '/b' });
    expect(r.pageChanged).toBe(true);
    expect(r.wrote).toBe(true);
    expect(db.writes.sessions).toBe(1);
  });

  it('two concurrent navigations to the same new page write once', async () => {
    const db = makeFakeDb({ lastSeenAt: Date.now(), currentPage: '/a' });
    await Promise.all([
      touchVisitorLiveness(db.client, { ...base, currentPage: '/b' }),
      touchVisitorLiveness(db.client, { ...base, currentPage: '/b' }),
    ]);
    expect(db.writes.sessions).toBe(1);
  });

  it('issues exactly one statement per heartbeat (no pre-read)', async () => {
    const db = makeFakeDb({ lastSeenAt: Date.now(), currentPage: '/a' });
    await touchVisitorLiveness(db.client, { ...base, currentPage: '/a' });
    expect(db.rpcMock).toHaveBeenCalledTimes(1);
    expect(db.rpcMock.mock.calls[0][1].p_min_interval_ms).toBe(VISITOR_LIVENESS_REFRESH_MS);
  });
});

describe('touchVisitorLiveness — fallback gating', () => {
  const legacyClient = (recorder: string[]) => ({
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
    from(table: string) {
      recorder.push(table);
      const api: any = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () => ({ data: { current_page: '/a' }, error: null }),
        update: () => api,
        then: undefined,
      };
      // update() chains resolve to { error: null }
      api.update = () => {
        const upd: any = { eq: () => upd, then: (res: any) => res({ error: null }) };
        return upd;
      };
      return api;
    },
  }) as any;

  it('falls back when the RPC is not deployed', async () => {
    const touched: string[] = [];
    const r = await touchVisitorLiveness(legacyClient(touched), { ...base, currentPage: '/b' });
    expect(r.matched).toBe(true);
    expect(r.wrote).toBe(true);
    expect(touched).toContain('visitor_sessions');
  });

  it.each([
    ['permission denied', { code: '42501', message: 'permission denied for function' }],
    ['runtime failure', { code: 'P0001', message: 'division by zero' }],
    ['timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['invalid input', { code: '22P02', message: 'invalid input syntax for type uuid' }],
  ])('propagates a real RPC error (%s) instead of silently falling back', async (_label, error) => {
    const client = {
      rpc: async () => ({ data: null, error }),
      from: () => {
        throw new Error('fallback must not run');
      },
    } as any;
    await expect(touchVisitorLiveness(client, { ...base, currentPage: '/b' })).rejects.toMatchObject({
      code: (error as any).code,
    });
  });

  it('classifies missing-RPC errors only', () => {
    expect(isMissingRpcError({ code: 'PGRST202' })).toBe(true);
    expect(isMissingRpcError({ code: '42883' })).toBe(true);
    expect(isMissingRpcError({ message: 'Could not find the function public.visitor_touch_liveness' })).toBe(true);
    expect(isMissingRpcError({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isMissingRpcError(null)).toBe(false);
  });
});
