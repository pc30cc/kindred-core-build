/* eslint-disable @typescript-eslint/no-explicit-any -- Express/Supabase test doubles are intentionally untyped. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ip_blocklist as the snapshot loader reads it:
 * from('ip_blocklist').select(cols, { count }).or(filter).order('id').range(a, b).
 * `listAnswer` decides each page: rows, a PostgREST error, or a throw.
 */
const listAnswer = vi.fn();
const listQueries: Array<{ select: string; or: string; range: [number, number] }> = [];
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: () => { throw new Error('the IP block must not be checked per request any more'); },
    from: (table: string) => {
      if (table !== 'ip_blocklist') return { insert: async () => ({}) };
      const q: any = { select: '', or: '', range: [0, 0] };
      const b: any = {
        select: (cols: string) => { q.select = cols; return b; },
        or: (f: string) => { q.or = f; return b; },
        order: () => b,
        range: (a: number, z: number) => {
          q.range = [a, z];
          listQueries.push(q);
          return Promise.resolve().then(() => listAnswer(q));
        },
      };
      return b;
    },
  }),
}));

const {
  ipBlockMiddleware,
  resolveRateLimitWorkspaceKey,
  widgetWorkspaceRateLimiter,
  __resetIpBlocklistForTests,
  __ageIpBlocklistForTests,
} = await import('../../../server/middleware/security.js');
const { invalidateLocal } = await import('../../../server/lib/cacheBus.js');

function makeRes() {
  const state: any = { code: 0, body: null };
  return {
    state,
    status(c: number) { state.code = c; return this; },
    json(b: any) { state.body = b; return this; },
    setHeader() { /* noop */ },
  } as any;
}

async function run(ip: string) {
  const req: any = { ip, socket: {}, serverConfig: {} };
  const res = makeRes();
  const next = vi.fn();
  await ipBlockMiddleware()(req, res, next);
  return { code: res.state.code, passed: next.mock.calls.length === 1 };
}

const rows = (list: Array<{ ip_address: string; blocked_until: string | null }>) =>
  ({ data: list, error: null, count: list.length });
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('ipBlockMiddleware: one list snapshot, no query per visitor, fail closed', () => {
  beforeEach(() => {
    listAnswer.mockReset();
    listQueries.length = 0;
    __resetIpBlocklistForTests();
    vi.useRealTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('never loaded + the load throws → 503 (fail closed)', async () => {
    listAnswer.mockImplementation(() => { throw new Error('db down'); });
    expect(await run('1.2.3.4')).toEqual({ code: 503, passed: false });
  });

  it('never loaded + a PostgREST error → 503', async () => {
    listAnswer.mockImplementation(() => ({ data: null, error: { message: 'permission denied' }, count: null }));
    expect(await run('7.7.7.7')).toEqual({ code: 503, passed: false });
  });

  it('reads only the active rows, with the predicate of is_ip_blocked()', async () => {
    listAnswer.mockImplementation(() => rows([]));
    await run('8.8.4.4');
    expect(listQueries).toHaveLength(1);
    expect(listQueries[0].select).toBe('ip_address, blocked_until');
    expect(listQueries[0].or).toMatch(/^blocked_until\.is\.null,blocked_until\.gt\."\d{4}-\d\d-\d\dT[^"]+Z"$/);
  });

  it('listed with no end, or an end in the future → 403', async () => {
    listAnswer.mockImplementation(() => rows([
      { ip_address: '9.9.9.9', blocked_until: null },
      { ip_address: '9.9.9.8', blocked_until: inMinutes(10) },
    ]));
    expect(await run('9.9.9.9')).toEqual({ code: 403, passed: false });
    expect(await run('9.9.9.8')).toEqual({ code: 403, passed: false });
  });

  it('a block that has ended by the time of the request → passes (checked per request)', async () => {
    listAnswer.mockImplementation(() => rows([{ ip_address: '6.6.6.6', blocked_until: inMinutes(-1) }]));
    expect(await run('6.6.6.6')).toEqual({ code: 0, passed: true });
  });

  it('clean addresses pass, and many visitors cost ONE query (no lookup per address)', async () => {
    listAnswer.mockImplementation(() => rows([{ ip_address: '9.9.9.9', blocked_until: null }]));
    for (let i = 0; i < 50; i++) expect((await run(`8.8.${i}.1`)).passed).toBe(true);
    expect(listQueries).toHaveLength(1);
  });

  it('pages past DATABASE_MAX_ROWS instead of silently cutting the list short', async () => {
    const all = Array.from({ length: 1500 }, (_, i) => ({ ip_address: `10.0.${Math.floor(i / 250)}.${i % 250}`, blocked_until: null }));
    listAnswer.mockImplementation((q: any) => ({ data: all.slice(q.range[0], q.range[1] + 1), error: null, count: all.length }));
    expect((await run('10.0.5.249')).code).toBe(403); // row #1499, on the second page
    expect(listQueries.map((q) => q.range)).toEqual([[0, 999], [1000, 1999]]);
  });

  it('older than 30 s: answers from the current list while ONE reload runs; a failed reload keeps it', async () => {
    listAnswer.mockImplementation(() => rows([{ ip_address: '9.9.9.9', blocked_until: null }]));
    await run('1.1.1.1');
    __ageIpBlocklistForTests(60_000);
    listAnswer.mockImplementation(() => { throw new Error('db blip'); });
    expect(await run('9.9.9.9')).toEqual({ code: 403, passed: false });
    expect(await run('1.1.1.1')).toEqual({ code: 0, passed: true });
    expect(listQueries).toHaveLength(2); // the second request waited out the retry gap
  });

  it('older than 5 min + the reload fails → 503 (fail closed)', async () => {
    listAnswer.mockImplementation(() => rows([]));
    await run('1.1.1.1');
    __ageIpBlocklistForTests(5 * 60_000 + 1);
    listAnswer.mockImplementation(() => { throw new Error('db down'); });
    expect(await run('1.1.1.1')).toEqual({ code: 503, passed: false });
    // Within the retry gap the same answer comes without another query.
    expect(await run('1.1.1.1')).toEqual({ code: 503, passed: false });
    expect(listQueries).toHaveLength(2);
  });

  it('an `ipblock` invalidation (the admin routes publish it) reloads before the next answer', async () => {
    listAnswer.mockImplementation(() => rows([]));
    expect((await run('5.5.5.5')).passed).toBe(true);
    // An admin blocks 5.5.5.5 (on this node or another one).
    listAnswer.mockImplementation(() => rows([{ ip_address: '5.5.5.5', blocked_until: null }]));
    invalidateLocal(['ipblock']);
    expect(await run('5.5.5.5')).toEqual({ code: 403, passed: false });
    expect(listQueries).toHaveLength(2);
    // … and unblocks it.
    listAnswer.mockImplementation(() => rows([]));
    invalidateLocal(['ipblock']);
    expect((await run('5.5.5.5')).passed).toBe(true);
    expect(listQueries).toHaveLength(3);
  });

  it('an invalidation whose reload fails keeps answering from the current list', async () => {
    listAnswer.mockImplementation(() => rows([{ ip_address: '9.9.9.9', blocked_until: null }]));
    await run('1.1.1.1');
    listAnswer.mockImplementation(() => { throw new Error('db blip'); });
    invalidateLocal(['ipblock']);
    expect(await run('9.9.9.9')).toEqual({ code: 403, passed: false });
    expect(await run('1.1.1.1')).toEqual({ code: 0, passed: true });
  });
});

describe('per-workspace widget rate limiting', () => {
  it('keys on the workspace, not the IP, only for a cryptographically verified rl:"workspace" context', () => {
    const mk = (ip: string, extra: any = {}) =>
      ({ ip, query: {}, body: {}, headers: {}, originalUrl: '/api/widget/bootstrap', ...extra }) as any;
    // `_widgetWorkspaceId` alone is NOT enough — it must be paired with
    // `_widgetRateLimitTrust === 'workspace'` (both set together by
    // enforceWidgetToken only for a token that itself carries rl:'workspace').
    expect(resolveRateLimitWorkspaceKey(mk('1.1.1.1', { _widgetWorkspaceId: 'ws-a' }))).toBe('ip:1.1.1.1');
    expect(
      resolveRateLimitWorkspaceKey(mk('1.1.1.1', { _widgetWorkspaceId: 'ws-a', _widgetRateLimitTrust: 'workspace' })),
    ).toBe('ws:ws-a');
    // Same workspace from two different IPs → same bucket (IP rotation resistant),
    // still gated on the workspace-trust flag.
    const a = resolveRateLimitWorkspaceKey(mk('1.1.1.1', { _widgetWorkspaceId: 'ws-b', _widgetRateLimitTrust: 'workspace' }));
    const b = resolveRateLimitWorkspaceKey(mk('3.3.3.3', { _widgetWorkspaceId: 'ws-b', _widgetRateLimitTrust: 'workspace' }));
    expect(a).toBe(b);
    // A raw, unvalidated workspace_id must NOT select a workspace bucket.
    expect(resolveRateLimitWorkspaceKey(mk('2.2.2.2', { body: { workspace_id: 'ws-a' } }))).toBe('ip:2.2.2.2');
  });

  it('falls back to an IP bucket when no workspace is present', () => {
    expect(resolveRateLimitWorkspaceKey({ ip: '4.4.4.4', query: {}, body: {}, headers: {}, originalUrl: '/api/widget/bootstrap' } as any)).toBe('ip:4.4.4.4');
  });

  it('is mounted as a real express-rate-limit middleware', () => {
    expect(typeof widgetWorkspaceRateLimiter).toBe('function');
  });
});
