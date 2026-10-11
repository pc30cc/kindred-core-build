/**
 * Simple billing phase 4 — the Knowledge Base view of computed locks
 * (server/services/knowledge-base/locks.ts) and the AI source policy.
 *
 * The lock state itself comes from the lock core (its own tests); here it is
 * a fixed state, so the KB rules are checked on their own:
 *   - fail open: switch off, unreadable or nothing locked → nothing locked,
 *     and the query is left untouched;
 *   - the cutoff decides when created_at was read (NULL included), the
 *     locked id list when it was not;
 *   - the id check reads created_at only when the id list is capped;
 *   - the SQL guard's error is recognised.
 * The real database path is covered by src/test/integration/kbLocks.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  state: null as unknown,
  article: null as Record<string, unknown> | null,
  reads: 0,
  cleared: [] as Array<string | undefined>,
}));

vi.mock('../../../server/services/billing/locks/state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => h.state,
  clearLockStateCache: (ws?: string) => { h.cleared.push(ws); },
}));
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => { h.reads++; return { data: h.article, error: null }; };
      return b;
    },
  }),
}));

const locks = await import('../../../server/services/knowledge-base/locks.js');
const { unlockedState } = await import('../../../server/services/billing/locks/state.js');
const { isKbArticleSourceAllowed } = await import('../../../server/services/ai-agent/sourcePolicy.js');

const CONFIG = {} as never;
const WS = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

function kbState(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    kb: {
      limit: 1,
      total: 3,
      locked: 2,
      // The last active article: created 2026-01-01 10:00:00.123456, id A.
      cut: { ts: '2026-01-01T10:00:00.123456+00:00', id: A },
      ids: [B, C],
      ...over,
    },
    contact: null,
    member: null,
    conversation: null,
  };
}

class FakeQuery {
  ors: string[] = [];
  or(filter: string) { this.ors.push(filter); return this; }
}

beforeEach(() => {
  h.state = unlockedState();
  h.article = null;
  h.reads = 0;
  h.cleared = [];
});

describe('resolveKbLock — fail open', () => {
  it('switch off / unreadable: nothing is locked and the query is untouched', async () => {
    const lock = await locks.resolveKbLock(CONFIG, WS);
    expect(lock.active).toBe(false);
    expect(locks.isKbArticleLocked(lock, { id: B, created_at: '2027-01-01T00:00:00Z' })).toBe(false);
    const q = new FakeQuery();
    expect(locks.applyKbUnlockedFilter(q, lock)).toBe(q);
    expect(q.ors).toEqual([]);
    expect(await locks.isKbArticleIdLocked(CONFIG, WS, B)).toBe(false);
    expect(h.reads).toBe(0);
  });

  it('switch on but under the limit (no cut): nothing is locked', async () => {
    h.state = kbState({ locked: 0, cut: null, ids: [] });
    expect((await locks.resolveKbLock(CONFIG, WS)).active).toBe(false);
  });

  it('no workspace id: nothing is locked', async () => {
    h.state = kbState();
    expect((await locks.resolveKbLock(CONFIG, '')).active).toBe(false);
  });
});

describe('isKbArticleLocked', () => {
  it('with created_at read, the cutoff decides to the microsecond, ties on id', async () => {
    h.state = kbState();
    const lock = await locks.resolveKbLock(CONFIG, WS);
    expect(lock).toMatchObject({ active: true, locked: 2, limit: 1, complete: true });
    // Same instant as the cut, one microsecond later: locked.
    expect(locks.isKbArticleLocked(lock, { id: '00000000-0000-4000-8000-000000000000', created_at: '2026-01-01T10:00:00.123457+00:00' })).toBe(true);
    // Same microsecond: the id breaks the tie.
    expect(locks.isKbArticleLocked(lock, { id: A, created_at: '2026-01-01 10:00:00.123456+00' })).toBe(false);
    expect(locks.isKbArticleLocked(lock, { id: B, created_at: '2026-01-01T10:00:00.123456Z' })).toBe(true);
    // A NULL created_at ranks first: never after a dated cut.
    expect(locks.isKbArticleLocked(lock, { id: C, created_at: null })).toBe(false);
  });

  it('without created_at, the locked id list decides', async () => {
    h.state = kbState();
    const lock = await locks.resolveKbLock(CONFIG, WS);
    expect(locks.isKbArticleLocked(lock, { id: B })).toBe(true);
    expect(locks.isKbArticleLocked(lock, { id: A })).toBe(false);
    expect(locks.isKbArticleLocked(lock, { id: B.toUpperCase() })).toBe(true);
    expect(locks.isKbArticleLocked(lock, null)).toBe(false);
  });

  it('lockedKbIdsOf / withoutLockedKb pick and drop the locked rows', async () => {
    h.state = kbState();
    const lock = await locks.resolveKbLock(CONFIG, WS);
    const rows = [{ id: A, created_at: '2026-01-01T00:00:00Z' }, { id: B, created_at: '2026-02-01T00:00:00Z' }];
    expect([...locks.lockedKbIdsOf(lock, rows)]).toEqual([B]);
    expect(locks.withoutLockedKb(lock, rows).map((r) => r.id)).toEqual([A]);
    expect(locks.withoutLockedKb(locks.noKbLock(), rows)).toHaveLength(2);
  });
});

describe('applyKbUnlockedFilter', () => {
  it('adds one or() with the quoted cutoff', async () => {
    h.state = kbState();
    const q = new FakeQuery();
    locks.applyKbUnlockedFilter(q, await locks.resolveKbLock(CONFIG, WS));
    expect(q.ors).toEqual([
      `created_at.is.null,created_at.lt."2026-01-01T10:00:00.123456+00:00",and(created_at.eq."2026-01-01T10:00:00.123456+00:00",id.lte.${A})`,
    ]);
  });

  it('limit 0 (cut -infinity, the nil uuid) keeps nothing', async () => {
    h.state = kbState({ limit: 0, locked: 3, cut: { ts: '-infinity', id: '00000000-0000-0000-0000-000000000000' }, ids: [A, B, C] });
    const q = new FakeQuery();
    locks.applyKbUnlockedFilter(q, await locks.resolveKbLock(CONFIG, WS));
    expect(q.ors).toEqual(['and(created_at.is.null,id.lte.00000000-0000-0000-0000-000000000000)']);
  });
});

describe('isKbArticleIdLocked', () => {
  it('answers from the id list while it is complete (no read)', async () => {
    h.state = kbState();
    expect(await locks.isKbArticleIdLocked(CONFIG, WS, B)).toBe(true);
    expect(await locks.isKbArticleIdLocked(CONFIG, WS, A)).toBe(false);
    expect(await locks.isKbArticleIdLocked(CONFIG, WS, null)).toBe(false);
    expect(h.reads).toBe(0);
  });

  it('reads the article when the id list is capped', async () => {
    h.state = kbState({ locked: 9000, ids: [B] });
    h.article = { id: C, created_at: '2026-03-01T00:00:00Z' };
    expect(await locks.isKbArticleIdLocked(CONFIG, WS, C)).toBe(true);
    expect(h.reads).toBe(1);
    h.article = null; // not found (or another workspace's): not locked
    expect(await locks.isKbArticleIdLocked(CONFIG, WS, C)).toBe(false);
  });
});

describe('errors and cache', () => {
  it('recognises the SQL guard of _ai_kb_apply_generated', () => {
    expect(locks.isKbArticleLockedError({ message: 'kb_article_locked', code: 'P0001' })).toBe(true);
    expect(locks.isKbArticleLockedError({ message: 'other' })).toBe(false);
    expect(locks.isKbArticleLockedError(null)).toBe(false);
    expect(locks.kbArticleLockedBody()).toEqual({ error: 'kb_article_locked', upgrade_required: true });
  });

  it('forgetKbLock clears the workspace\'s cached lock state', () => {
    locks.forgetKbLock(WS);
    expect(h.cleared).toEqual([WS]);
  });
});

describe('isKbArticleSourceAllowed — locked articles', () => {
  const row = { id: B, workspace_id: 'ws-a', status: 'published', used_by_ai: true };
  it('a locked article is never an AI source', () => {
    expect(isKbArticleSourceAllowed(row, 'ws-a', new Set([B]))).toBe(false);
  });
  it('without a locked set (or not in it) the old rule holds', () => {
    expect(isKbArticleSourceAllowed(row, 'ws-a')).toBe(true);
    expect(isKbArticleSourceAllowed(row, 'ws-a', new Set([C]))).toBe(true);
    expect(isKbArticleSourceAllowed({ ...row, status: 'draft' }, 'ws-a', new Set())).toBe(false);
  });
});
