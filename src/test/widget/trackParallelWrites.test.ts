// @vitest-environment node
/**
 * POST /api/widget/track runs its independent reads together and its
 * independent writes together. Pinned per branch, through the real
 * widgetRouter over a database double that records every operation and
 * answers a whole batch of pending operations at once — one batch is one
 * database round trip:
 *
 *   navigation (known session, new URL)  reads: widget_settings.store_raw_ip
 *                                        + the session, together (1 trip);
 *                                        writes: session UPDATE, presence
 *                                        UPDATE, page-view INSERT, together
 *                                        (1 trip). Was 5 trips.
 *   unchanged repeat (same URL < 15 s)   the 2 reads, then ip_raw + presence
 *                                        read together; NO write.
 *   unchanged, presence gone stale       … + the presence UPDATE only.
 *   new session                          the 2 reads, the visitor-cap read,
 *                                        the session INSERT, then presence
 *                                        INSERT + page-view INSERT together.
 *
 * The write set of each branch is exactly what it was before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-track-writes';

type Row = Record<string, unknown>;
interface Op { table: string; kind: 'select' | 'insert' | 'update'; columns: string; payload?: Row; filters: Array<[string, unknown]> }

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  ops: [] as Op[],
  pending: [] as Array<() => void>,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const op: Op = { table, kind: 'select', columns: '*', filters: [] };
      const run = (): { data: unknown; error: unknown } => {
        if (op.kind !== 'select') {
          if (op.kind === 'insert' && table === 'visitor_sessions') return { data: { id: 'sess-new' }, error: null };
          return { data: null, error: null };
        }
        const rows = (db.tables[table] || []).filter((r) => op.filters.every(([c, v]) => r[c] === v));
        const pick = (r: Row) => {
          if (op.columns === '*') return { ...r };
          const out: Row = {};
          for (const c of op.columns.split(',').map((s) => s.trim())) out[c] = r[c];
          return out;
        };
        return { data: rows.length ? pick(rows[0]) : null, error: null };
      };
      // Every operation waits for the test's "round trip" to answer it.
      const settle = () => new Promise<{ data: unknown; error: unknown }>((resolve) => {
        db.ops.push(op);
        db.pending.push(() => resolve(run()));
      });
      const b: Record<string, unknown> = {
        select(cols?: string) { if (op.kind === 'select') op.columns = cols || '*'; return b; },
        insert(payload: Row) { op.kind = 'insert'; op.payload = payload; return b; },
        update(payload: Row) { op.kind = 'update'; op.payload = payload; return b; },
        eq(c: string, v: unknown) { op.filters.push([c, v]); return b; },
        gte() { return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle() { return settle(); },
        single() { return settle(); },
        then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) { return settle().then(ok, err); },
      };
      return b;
    },
  }),
}));
vi.mock('../../../server/services/email/index.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: vi.fn() }));
// The monthly visitor cap has its own tests; here it reads once and allows.
vi.mock('../../../server/services/billing/visitorLimit.js', async (orig) => ({
  ...(await orig<object>()),
  enforceMaxVisitorsLimitIfNewThisMonth: async (_req: unknown, _res: unknown, sb: { from(t: string): { select(c: string): { maybeSingle(): Promise<unknown> } } }) => {
    await sb.from('visitor_sessions').select('id').maybeSingle();
    return true;
  },
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { createSessionToken } = await import('../../../server/services/widget/security.js');
const { hashIp } = await import('../../../server/utils/clientIp.js');

const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const ORIGIN = 'https://shop.example';
const VISITOR = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLIENT_IP = '45.33.32.156';

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = {
    supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use(express.json());
app.use('/api/widget', widgetRouter);

/**
 * Sends one /track and answers the database in rounds: every operation
 * pending at a tick is answered together. Returns the rounds as lists of
 * "kind table" labels (the fire-and-forget geo read is left out: it does
 * not hold the response).
 */
async function track(body: Row): Promise<{ status: number; rounds: string[][]; writes: Op[] }> {
  db.ops.length = 0;
  db.pending.length = 0;
  const rounds: string[][] = [];
  let done = false;
  const sent = request(app).post('/api/widget/track')
    .set('Origin', ORIGIN)
    .set('X-Widget-Token', createSessionToken(WS, ORIGIN))
    .set('X-Forwarded-For', CLIENT_IP)
    .send({ workspace_id: WS, visitor_id: VISITOR, event: 'page_view', browser: 'Chrome', device: 'Desktop', os: 'Linux', ...body })
    .then((r) => { done = true; return r; });
  let seen = 0;
  while (!done) {
    await new Promise((r) => setImmediate(r));
    if (!db.pending.length) continue;
    const batch = db.pending.splice(0);
    const ops = db.ops.slice(seen);
    seen = db.ops.length;
    const labels = ops
      .filter((o) => !(o.kind === 'select' && o.columns === 'geo_resolved_at'))
      .map((o) => `${o.kind} ${o.table}${o.kind === 'select' ? `(${o.columns})` : ''}`);
    if (labels.length) rounds.push(labels.sort());
    for (const answer of batch) answer();
  }
  const res = await sent;
  return { status: res.status, rounds, writes: db.ops.filter((o) => o.kind !== 'select') };
}

const READS = [
  'select visitor_sessions(id, ip_hash, current_page, browser, device, os, last_seen_at)',
  'select widget_settings(store_raw_ip)',
];

function existingSession(over: Row = {}): Row {
  return {
    id: 'sess-1', workspace_id: WS, visitor_id: VISITOR, ip_hash: hashIp(CLIENT_IP), ip_raw: null,
    current_page: 'https://shop.example/a', browser: 'Chrome', device: 'Desktop', os: 'Linux',
    last_seen_at: new Date(Date.now() - 5_000).toISOString(), ...over,
  };
}

beforeEach(() => {
  db.tables = { widget_settings: [{ workspace_id: WS, store_raw_ip: false }] };
});

describe('POST /track: same writes, fewer round trips', () => {
  it('navigation: 2 round trips — the 2 reads together, then the 3 writes together', async () => {
    db.tables.visitor_sessions = [existingSession()];
    db.tables.visitor_presence = [{ visitor_session_id: 'sess-1', status: 'online', current_page: 'https://shop.example/a', updated_at: new Date().toISOString() }];
    const r = await track({ current_page: 'https://shop.example/b', page_title: 'B' });
    expect(r.status).toBe(200);
    expect(r.rounds).toEqual([
      READS,
      ['insert visitor_page_views', 'update visitor_presence', 'update visitor_sessions'],
    ]);
    const byTable = Object.fromEntries(r.writes.map((w) => [`${w.kind} ${w.table}`, w]));
    expect(byTable['update visitor_sessions'].filters).toEqual([['id', 'sess-1']]);
    expect(byTable['update visitor_sessions'].payload).toMatchObject({ current_page: 'https://shop.example/b', ip_raw: null });
    expect(byTable['update visitor_presence'].payload).toMatchObject({ status: 'online', current_page: 'https://shop.example/b' });
    expect(byTable['insert visitor_page_views'].payload).toMatchObject({ workspace_id: WS, visitor_session_id: 'sess-1', url: 'https://shop.example/b', title: 'B' });
  });

  it('unchanged repeat with a fresh presence row: the ip_raw and presence reads together, and no write at all', async () => {
    db.tables.visitor_sessions = [existingSession()];
    db.tables.visitor_presence = [{ visitor_session_id: 'sess-1', status: 'online', current_page: 'https://shop.example/a', updated_at: new Date().toISOString() }];
    const r = await track({ current_page: 'https://shop.example/a' });
    expect(r.status).toBe(200);
    expect(r.rounds).toEqual([
      READS,
      ['select visitor_presence(status, current_page, updated_at)', 'select visitor_sessions(ip_raw)'],
    ]);
    expect(r.writes).toEqual([]);
  });

  it('unchanged repeat whose presence row went offline: only the presence UPDATE', async () => {
    db.tables.visitor_sessions = [existingSession()];
    db.tables.visitor_presence = [{ visitor_session_id: 'sess-1', status: 'offline', current_page: 'https://shop.example/a', updated_at: new Date().toISOString() }];
    const r = await track({ current_page: 'https://shop.example/a' });
    expect(r.writes.map((w) => `${w.kind} ${w.table}`)).toEqual(['update visitor_presence']);
    expect(r.rounds).toHaveLength(3);
  });

  it('a raw-IP toggle turned on makes the "unchanged" repeat write the session (store_raw_ip read from the database, every request)', async () => {
    db.tables.widget_settings = [{ workspace_id: WS, store_raw_ip: true }];
    db.tables.visitor_sessions = [existingSession()];
    db.tables.visitor_presence = [{ visitor_session_id: 'sess-1', status: 'online', current_page: 'https://shop.example/a', updated_at: new Date().toISOString() }];
    const r = await track({ current_page: 'https://shop.example/a' });
    expect(r.writes.map((w) => `${w.kind} ${w.table}`).sort()).toEqual(['update visitor_presence', 'update visitor_sessions']);
    expect(r.writes.find((w) => w.table === 'visitor_sessions')!.payload).toHaveProperty('ip_raw', CLIENT_IP);
  });

  it('new session: the session INSERT, then the presence INSERT and the first page view together', async () => {
    db.tables.visitor_sessions = [];
    const r = await track({ current_page: 'https://shop.example/landing', page_title: 'Landing', utm_source: 'news' });
    expect(r.status).toBe(200);
    expect(r.rounds).toEqual([
      READS,
      ['select visitor_sessions(id)'], // the monthly visitor cap
      ['insert visitor_sessions'],
      ['insert visitor_page_views', 'insert visitor_presence'],
    ]);
    expect(r.writes.map((w) => `${w.kind} ${w.table}`).sort()).toEqual([
      'insert visitor_page_views', 'insert visitor_presence', 'insert visitor_sessions',
    ]);
    const presence = r.writes.find((w) => w.table === 'visitor_presence')!;
    expect(presence.payload).toMatchObject({ workspace_id: WS, visitor_session_id: 'sess-new', status: 'online', current_page: 'https://shop.example/landing' });
    expect(r.writes.find((w) => w.table === 'visitor_sessions')!.payload).toMatchObject({ utm_source: 'news', ip_raw: null });
  });
});
