/**
 * The app icon's badge and hidden pairs (295, server/services/teamVisibility.ts).
 *
 * push_unread_badge (236) counted every colleague with an unread line for the
 * operator, a colleague hidden from them included. The operator never sees
 * that colleague listed, so cannot open the thread to read it, and the
 * iPhone/Android badge stayed stuck. The badge takes them away, on the one
 * statement's path and on the long way, and keeps a colleague who is also
 * unread where they are not hidden. A failed read of the pairs hides nobody.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerConfig } from '../../../server/config';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  badge: 0 as number | null,
  rpcFails: false,
  pairsFail: false,
  tables: {} as Record<string, Row[]>,
  reads: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc(fn: string) {
      if (state.rpcFails || fn !== 'push_unread_badge') return Promise.resolve({ data: null, error: { message: 'no function' } });
      return Promise.resolve({ data: state.badge, error: null });
    },
    from(table: string) {
      state.reads.push(table);
      const filters: Array<(r: Row) => boolean> = [];
      const builder: Record<string, unknown> = {
        select: () => builder,
        limit: () => builder,
        or: () => builder,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
        is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return builder; },
        in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'workspace_member_hidden_pairs' && state.pairsFail) {
            return resolve({ data: null, error: { code: '57014', message: 'canceling statement' } });
          }
          const rows = (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  }),
}));

const { unreadBadgeCount } = await import('../../../server/services/push/recipients.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as ServerConfig;
const ME = 'u-me';
const HIDDEN = 'u-golpari';
const SEEN = 'u-maryam';

const unread = (workspace_id: string, sender_id: string): Row => ({ workspace_id, sender_id, recipient_id: ME, read_at: null });

beforeEach(() => {
  state.rpcFails = false;
  state.pairsFail = false;
  state.reads = [];
  state.tables = {
    workspace_members: [{ workspace_id: 'w1', user_id: ME, role: 'agent', suspended_at: null }],
    // ME and HIDDEN are hidden from each other in w1 (user_a < user_b).
    workspace_member_hidden_pairs: [{ workspace_id: 'w1', user_a: HIDDEN, user_b: ME }],
    team_messages: [unread('w1', HIDDEN), unread('w1', HIDDEN), unread('w1', SEEN)],
    conversations: [],
    conversation_messages: [],
  };
  // What 236 counts here: two colleagues with unread lines, no conversation.
  state.badge = 2;
});

describe('the badge with hidden pairs', () => {
  it('one statement: a hidden colleague is taken away', async () => {
    expect(await unreadBadgeCount(CONFIG, ME, 'w1')).toBe(1);
  });

  it('the long way: a hidden colleague is not counted', async () => {
    state.rpcFails = true;
    expect(await unreadBadgeCount(CONFIG, ME, 'w1')).toBe(1);
  });

  it('a colleague also unread in a workspace where they are not hidden stays counted', async () => {
    state.tables.workspace_members.push({ workspace_id: 'w2', user_id: ME, role: 'agent', suspended_at: null });
    state.tables.team_messages.push(unread('w2', HIDDEN));
    // 236 counts HIDDEN once across both workspaces, and SEEN.
    state.badge = 2;
    expect(await unreadBadgeCount(CONFIG, ME, null)).toBe(2);
    state.rpcFails = true;
    expect(await unreadBadgeCount(CONFIG, ME, null)).toBe(2);
  });

  it('nobody hidden: the statement\'s number, with no further read of team_messages', async () => {
    state.tables.workspace_member_hidden_pairs = [];
    expect(await unreadBadgeCount(CONFIG, ME, 'w1')).toBe(2);
    expect(state.reads.filter((t) => t === 'team_messages')).toHaveLength(0);
  });

  it('a pair of two other members hides nobody from me', async () => {
    state.tables.workspace_member_hidden_pairs = [{ workspace_id: 'w1', user_a: HIDDEN, user_b: SEEN }];
    expect(await unreadBadgeCount(CONFIG, ME, 'w1')).toBe(2);
    state.rpcFails = true;
    expect(await unreadBadgeCount(CONFIG, ME, 'w1')).toBe(2);
  });

  it('a failed read of the pairs hides nobody (the push still goes)', async () => {
    state.pairsFail = true;
    expect(await unreadBadgeCount(CONFIG, ME, 'w1')).toBe(2);
    state.rpcFails = true;
    expect(await unreadBadgeCount(CONFIG, ME, 'w1')).toBe(2);
  });

  it('the pairs are read through teamVisibility.ts only', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('server/services/push/recipients.ts', 'utf8');
    expect(src).not.toContain('workspace_member_hidden_pairs');
    expect(src).toContain("from '../teamVisibility.js'");
  });
});
