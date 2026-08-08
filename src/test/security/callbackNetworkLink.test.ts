/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase/Response test doubles are intentionally untyped. */
/**
 * Phase 4 guards — Callbacks and cross-workspace isolation.
 *
 * Test H: the widget callback route stores the CANONICAL visitor session id
 *         (a real `visitor_sessions.id`, never the widget cookie id), and the
 *         operator Callbacks UI reads geo/IP through the SAME batch endpoint
 *         the Inbox and the Call Center use.
 * Test J: a session/conversation belonging to workspace A can never be
 *         resolved through workspace B — the resolvers return empty, they do
 *         not error in a way that would confirm the row exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const state: {
  sessions: any[];
  conversations: any[];
  callbacks: any[];
  inserted: any[];
} = { sessions: [], conversations: [], callbacks: [], inserted: [] };

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb() }));
vi.mock('../../../server/services/realtime/resolvePublisher.js', () => ({
  resolvePublisher: async () => ({ publish: async () => {} }),
}));

function fakeSb(): any {
  return {
    from(table: string) {
      const filters: Record<string, any> = {};
      let inField: string | null = null;
      let inValues: string[] = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      const src = () =>
        table === 'conversations' ? state.conversations
          : table === 'visitor_sessions' ? state.sessions
            : table === 'callback_requests' ? state.callbacks
              : [];
      const rowsFor = () => {
        const out = src().filter((r) => {
          for (const [k, v] of Object.entries(filters)) if (r[k] !== v) return false;
          if (inField && !inValues.includes(r[inField])) return false;
          return true;
        });
        if (orderCol) {
          const col = orderCol;
          out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (orderAsc ? 1 : -1));
        }
        return out;
      };
      const chain: any = {
        select() { return chain; },
        eq(col: string, val: any) { filters[col] = val; return chain; },
        in(col: string, vals: string[]) { inField = col; inValues = vals; return chain; },
        gte() { return chain; },
        not() { return chain; },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col; orderAsc = opts?.ascending !== false; return chain;
        },
        limit() { return chain; },
        insert(row: any) {
          const created = { id: `cb-${state.inserted.length + 1}`, created_at: new Date().toISOString(), ...row };
          state.inserted.push(created);
          state.callbacks.push(created);
          return {
            select: () => ({
              single: async () => ({ data: created, error: null }),
              maybeSingle: async () => ({ data: created, error: null }),
            }),
          };
        },
        maybeSingle: async () => ({ data: rowsFor()[0] ?? null }),
        single: async () => ({ data: rowsFor()[0] ?? null, error: null }),
        then: (resolve: any) => resolve({ data: rowsFor(), error: null }),
      };
      return chain;
    },
  };
}

const WS_A = 'ws-a';
const WS_B = 'ws-b';
const cfg: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };

beforeEach(() => {
  state.sessions = [
    { id: 'sess-a', workspace_id: WS_A, visitor_id: 'v1', contact_id: 'c1', ip_hash: 'aaaa1111bbbb2222', last_seen_at: '2026-02-01T00:00:00Z' },
  ];
  state.conversations = [
    { id: 'conv-a', workspace_id: WS_A, visitor_session_id: 'sess-a', contact_id: 'c1' },
  ];
  state.callbacks = [];
  state.inserted = [];
});

describe('Test H — callbacks carry the canonical visitor session', () => {
  it('persists visitor_session_id on the callback row', async () => {
    const { createCallbackRequest } = await import('../../../server/services/calls/callbacks.js');
    const row = await createCallbackRequest(cfg, {
      workspaceId: WS_A,
      channel: 'audio',
      visitorSessionId: 'sess-a',
    });
    expect(row.visitor_session_id).toBe('sess-a');
    expect(state.inserted[0].visitor_session_id).toBe('sess-a');
  });

  it('the widget route resolves a real session row, not the widget cookie id', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'server/routes/widgetCallbacks.ts'), 'utf8',
    );
    // Canonical shared writer (creates the session when missing) …
    expect(src).toContain('ensureVisitorSessionRow');
    expect(src).toContain('resolveSessionNetworkContext');
    // … and its result is what gets stored.
    expect(src).toContain('visitorSessionId,');
    // The raw cookie id must never be stored as the session id.
    expect(src).not.toMatch(/visitorSessionId\s*=\s*visitorId/);
  });

  it('the Callbacks UI reads geo/IP via the shared batch endpoint (no per-row fetch)', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/pages/app/call-center/CallbacksPage.tsx'), 'utf8',
    );
    const calls = src.match(/useVisitorNetworkBatchBySession\(/g) || [];
    expect(calls.length).toBe(1);
    expect(src).toContain('VisitorNetworkInline');
    expect(src).toContain('useGeoEnrichmentRealtime');
    // No second endpoint was invented for callbacks.
    expect(src).not.toContain('/api/visitor-intel/network?');
  });
});

describe('Test J — cross-workspace isolation', () => {
  const policy: any = { entitled: true, canViewRaw: true };

  it('a session from workspace A is invisible to workspace B', async () => {
    const np = await import('../../../server/services/visitors/networkProfile.js');
    const mine = await np.resolveNetworkProfiles(cfg, WS_A, ['sess-a'], policy);
    expect(mine.get('sess-a')).toBeTruthy();
    const theirs = await np.resolveNetworkProfiles(cfg, WS_B, ['sess-a'], policy);
    expect(theirs.size).toBe(0);
    expect(await np.resolveNetworkProfile(cfg, WS_B, 'sess-a', policy)).toBeNull();
  });

  it('a conversation from workspace A resolves no session under workspace B', async () => {
    const np = await import('../../../server/services/visitors/networkProfile.js');
    expect(await np.resolveConversationSessionId(cfg, WS_A, 'conv-a')).toBe('sess-a');
    expect(await np.resolveConversationSessionId(cfg, WS_B, 'conv-a')).toBeNull();
    const profiles = await np.resolveConversationNetworkProfiles(cfg, WS_B, ['conv-a'], policy);
    expect(profiles.size).toBe(0);
  });

  it('every canonical resolver filters on workspace_id', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'server/services/visitors/networkProfile.ts'), 'utf8',
    );
    const selects = src.match(/\.from\('(visitor_sessions|conversations|call_sessions|callback_requests)'\)/g) || [];
    expect(selects.length).toBeGreaterThan(0);
    // Not a single table read in this module may skip the workspace scope.
    expect(src.match(/workspace_id/g)!.length).toBeGreaterThanOrEqual(selects.length);
  });
});
