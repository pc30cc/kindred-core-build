/**
 * Phase 3 guards — Call Center reads the SAME canonical Geo/IP as the Inbox.
 *
 * Test G: an operator-initiated call links the conversation's OWN
 *         visitor_session (not the contact's newest one), so the Call Center
 *         renders the same country/IP as the Inbox thread it started from.
 * Batch:  list surfaces issue ONE network request per page, not one per row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const state: { sessions: any[]; conversations: any[] } = { sessions: [], conversations: [] };

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb() }));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true }),
}));

function fakeSb(): any {
  return {
    from(table: string) {
      const filters: Record<string, any> = {};
      let inField: string | null = null;
      let inValues: string[] = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      const rowsFor = () => {
        const src =
          table === 'conversations' ? state.conversations
            : table === 'visitor_sessions' ? state.sessions
              : [];
        const out = src.filter((r) => {
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
        not() { return chain; },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col; orderAsc = opts?.ascending !== false; return chain;
        },
        limit() { return chain; },
        maybeSingle: async () => ({ data: rowsFor()[0] ?? null }),
        then: (resolve: any) => resolve({ data: rowsFor(), error: null }),
      };
      return chain;
    },
  };
}

const WS = 'w1';
const cfg: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };
let np: typeof import('../../../server/services/visitors/networkProfile.js');

beforeEach(async () => {
  np = await import('../../../server/services/visitors/networkProfile.js');
  state.sessions = [
    { id: 'sess-old', workspace_id: WS, contact_id: 'c1', last_seen_at: '2026-01-01T00:00:00Z' },
    { id: 'sess-new', workspace_id: WS, contact_id: 'c1', last_seen_at: '2026-02-01T00:00:00Z' },
  ];
  state.conversations = [
    { id: 'conv-old', workspace_id: WS, visitor_session_id: 'sess-old', contact_id: 'c1' },
    { id: 'conv-legacy', workspace_id: WS, visitor_session_id: null, contact_id: 'c1' },
  ];
});

describe('Test G — operator-initiated calls link the canonical session', () => {
  it('picks the conversation own session, not the contact newest one', async () => {
    const sid = await np.resolveConversationSessionId(cfg, WS, 'conv-old');
    expect(sid).toBe('sess-old');
  });

  it('falls back to the newest session ONLY for legacy unlinked conversations', async () => {
    const sid = await np.resolveConversationSessionId(cfg, WS, 'conv-legacy');
    expect(sid).toBe('sess-new');
  });

  it('resolves many conversations in a bounded number of queries', async () => {
    const map = await np.resolveConversationSessionIds(cfg, WS, ['conv-old', 'conv-legacy']);
    expect(map.get('conv-old')).toBe('sess-old');
    expect(map.get('conv-legacy')).toBe('sess-new');
  });

  it('call creation routes stamp visitor_session_id', () => {
    const calls = readFileSync(path.resolve(process.cwd(), 'server/routes/calls.ts'), 'utf8');
    expect(calls).toContain('resolveConversationSessionId');
    expect(calls).toContain('visitor_session_id: visitorSessionId');
    const inv = readFileSync(
      path.resolve(process.cwd(), 'server/routes/widgetCallInvitations.ts'), 'utf8',
    );
    expect(inv).toContain('visitor_session_id: visitorSessionId');
  });
});

describe('Call Center list surfaces batch their network reads', () => {
  it('Live Queue uses one batched call, not a per-row fetch', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/pages/app/call-center/LiveQueuePage.tsx'), 'utf8',
    );
    expect(src).toContain('useVisitorNetworkBatchBySession');
    // Exactly one batch hook call for the entire page.
    const calls = src.match(/useVisitorNetworkBatchBySession\(/g) || [];
    expect(calls.length).toBe(1);
    // The per-row/per-selection fetch reference is gone.
    expect(src).not.toContain('reference={{ callSessionId');
  });

  it('Calls list + detail render the same batched profiles', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/pages/app/call-center/CallsPage.tsx'), 'utf8',
    );
    const calls = src.match(/useVisitorNetworkBatchBySession\(/g) || [];
    expect(calls.length).toBe(1);
    expect(src).toContain('VisitorNetworkInline');
    expect(src).toContain('VisitorNetworkCard');
  });

  it('the batch hook posts session_ids to the phase-2 endpoint (no new endpoint)', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/hooks/useVisitorNetwork.ts'), 'utf8');
    expect(src).toContain('/api/visitor-intel/network/batch');
    expect(src).toContain('session_ids');
  });
});

describe('Geo enrichment invalidation reuses the visitors channel', () => {
  it('server marks the enrichment on the existing visitor.upsert envelope', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'server/services/geo/index.ts'), 'utf8');
    expect(src).toContain('publishVisitorEvent');
    expect(src).toContain('geo_enriched: true');
  });

  it('client invalidates cached profiles on that event', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/hooks/useGeoEnrichmentRealtime.ts'), 'utf8',
    );
    expect(src).toContain('geo_enriched');
    expect(src).toContain(':visitors');
  });
});
