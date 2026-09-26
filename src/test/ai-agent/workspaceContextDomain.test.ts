/**
 * The AI Agent's workspace context carries the workspace's VERIFIED domain.
 *
 * It used to read `workspaces.verified_domain` / `workspaces.domain`, columns
 * `workspaces` does not have, so the query failed on every call and the
 * domain was always null. Domains live in `workspace_domains`; only a
 * verified one may be offered, the primary one first, and never an
 * unverified domain as a fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerConfig } from '../../../server/config';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const tablesRead: string[] = [];

interface FakeQuery {
  select: () => FakeQuery;
  eq: (col: string, value: unknown) => FakeQuery;
  not: () => FakeQuery;
  order: (col: string, opts?: { ascending?: boolean }) => FakeQuery;
  limit: (n: number) => FakeQuery;
  then: (resolve: (result: { data: Row[]; error: null }) => unknown) => unknown;
}

function query(table: string): FakeQuery {
  tablesRead.push(table);
  const filters: Array<(r: Row) => boolean> = [];
  const orders: Array<{ col: string; asc: boolean }> = [];
  let max = Infinity;
  const q: FakeQuery = {
    select: () => q,
    eq: (col, value) => (filters.push((r) => r[col] === value), q),
    not: () => q,
    order: (col, opts) => (orders.push({ col, asc: opts?.ascending !== false }), q),
    limit: (n) => ((max = n), q),
    then: (resolve) => {
      const rows = (db[table] || []).filter((r) => filters.every((f) => f(r)));
      rows.sort((a, b) => {
        for (const { col, asc } of orders) {
          const x = String(a[col]);
          const y = String(b[col]);
          if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      return resolve({ data: rows.slice(0, max), error: null });
    },
  };
  return q;
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({ from: (t: string) => query(t) }) }));

const { loadWorkspaceContext } = await import('../../../server/services/ai-agent/workspaceContext');

const CFG = {} as ServerConfig;
const WS = 'ws-1';

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  tablesRead.length = 0;
});

describe('workspace context domain', () => {
  it('offers the primary verified domain', async () => {
    db.workspace_domains = [
      { workspace_id: WS, domain: 'unverified-primary.example', verified: false, is_primary: true, created_at: '2026-01-01' },
      { workspace_id: WS, domain: 'older-verified.example', verified: true, is_primary: false, created_at: '2026-01-02' },
      { workspace_id: WS, domain: 'shop.example', verified: true, is_primary: true, created_at: '2026-01-03' },
      { workspace_id: 'other-ws', domain: 'other.example', verified: true, is_primary: true, created_at: '2026-01-01' },
    ];
    const ctx = await loadWorkspaceContext(CFG, WS);
    expect(ctx.domain).toBe('shop.example');
  });

  it('falls back to the oldest verified domain when none is primary', async () => {
    db.workspace_domains = [
      { workspace_id: WS, domain: 'second.example', verified: true, is_primary: false, created_at: '2026-02-02' },
      { workspace_id: WS, domain: 'first.example', verified: true, is_primary: false, created_at: '2026-02-01' },
    ];
    expect((await loadWorkspaceContext(CFG, WS)).domain).toBe('first.example');
  });

  it('never offers an unverified domain', async () => {
    db.workspace_domains = [
      { workspace_id: WS, domain: 'pending.example', verified: false, is_primary: true, created_at: '2026-01-01' },
    ];
    expect((await loadWorkspaceContext(CFG, WS)).domain).toBeNull();
  });

  it('reads domains from workspace_domains, not from workspaces', async () => {
    await loadWorkspaceContext(CFG, WS);
    expect(tablesRead).toContain('workspace_domains');
    expect(tablesRead).not.toContain('workspaces');
  });
});
