/**
 * Routing candidates (server/services/calls/departments.ts) with billing
 * locks off: a routing call that the 30 s caches answer reads nothing more
 * (no uncached workspace_members query per handoff), suspended members are
 * still never candidates, and a suspension is seen at once once the cache
 * is dropped (invalidateDepartmentCache, called on every seat change).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reads: [] as string[],
  members: [] as Array<{ user_id: string; suspended_at: string | null; role?: string }>,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      h.reads.push(table);
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'in', 'is']) b[m] = () => b;
      const rows = () => {
        if (table === 'workspace_members') return h.members;
        return [];
      };
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
      return b;
    },
  }),
}));
vi.mock('../../../server/services/billing/locks/state.js', () => ({
  resolveLockState: async () => ({ enabled: false, kb: null, contact: null, member: null, conversation: null }),
}));

const { resolveRoutingCandidates, invalidateDepartmentCache } = await import('../../../server/services/calls/departments');

const config = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' } as never;

describe('resolveRoutingCandidates (billing locks off)', () => {
  beforeEach(() => {
    h.reads.length = 0;
    h.members = [
      { user_id: 'owner', suspended_at: null },
      { user_id: 'a', suspended_at: null },
      { user_id: 's', suspended_at: '2026-10-01T00:00:00Z' },
    ];
  });

  it('a call the caches answer reads no table; suspended members are not candidates', async () => {
    const ws = 'ws-cache-1';
    const first = await resolveRoutingCandidates(config, ws, 'chat');
    expect(first).toEqual({ user_ids: ['owner', 'a'], source: 'general' });
    const readsAfterFirst = h.reads.length;
    const second = await resolveRoutingCandidates(config, ws, 'chat');
    expect(second).toEqual(first);
    expect(h.reads.slice(readsAfterFirst)).toEqual([]);
    // One workspace_members read served both.
    expect(h.reads.filter((t) => t === 'workspace_members')).toHaveLength(1);
  });

  it('a suspension counts at once once the cache is dropped', async () => {
    const ws = 'ws-cache-2';
    expect((await resolveRoutingCandidates(config, ws, 'chat')).user_ids).toEqual(['owner', 'a']);
    h.members[1].suspended_at = '2026-10-11T00:00:00Z';
    invalidateDepartmentCache(ws);
    expect((await resolveRoutingCandidates(config, ws, 'chat')).user_ids).toEqual(['owner']);
  });
});
