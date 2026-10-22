// @vitest-environment node
/**
 * POST /api/widget/track and visitor privacy (P-01,
 * server/services/widget/trackingPrivacy.ts), through the real widgetRouter
 * over a recording database double:
 *
 *   - a tracked page is stored as its path (no `?email=…&token=…`, no
 *     fragment) unless the workspace keeps query strings; a new session's
 *     referrer has no query string either way;
 *   - while the workspace waits for consent, nothing is written until the
 *     request says the visitor consented; `consent: false` is never tracked;
 *   - a browser sending Global Privacy Control (`Sec-GPC: 1`) is tracked only
 *     with consent, whatever the workspace's setting;
 *   - a database before migration 281 (no such columns) reads the settings
 *     again without them, and the defaults apply.
 *
 * And the helpers themselves (trackedPage, trackedReferrer, trackingAllowed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-track-privacy';

type Row = Record<string, unknown>;
interface Op { table: string; kind: 'select' | 'insert' | 'update'; columns: string; payload?: Row; filters: Array<[string, unknown]> }

const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, ops: [] as Op[], noPrivacyColumns: false, settingsFailOnce: false }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const op: Op = { table, kind: 'select', columns: '*', filters: [] };
      const run = (): { data: unknown; error: unknown } => {
        db.ops.push(op);
        if (op.kind !== 'select') {
          if (op.kind === 'insert' && table === 'visitor_sessions') return { data: { id: 'sess-new' }, error: null };
          return { data: null, error: null };
        }
        if (table === 'widget_settings' && db.settingsFailOnce) {
          db.settingsFailOnce = false;
          return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
        }
        if (table === 'widget_settings' && db.noPrivacyColumns && op.columns.includes('tracking_')) {
          return { data: null, error: { code: '42703', message: 'column "tracking_requires_consent" does not exist' } };
        }
        const rows = (db.tables[table] || []).filter((r) => op.filters.every(([c, v]) => r[c] === v));
        const pick = (r: Row) => {
          if (op.columns === '*') return { ...r };
          const out: Row = {};
          for (const c of op.columns.split(',').map((x) => x.trim())) out[c] = r[c];
          return out;
        };
        return { data: rows.length ? pick(rows[0]) : null, error: null };
      };
      const b: Record<string, unknown> = {
        select(cols?: string) { if (op.kind === 'select') op.columns = cols || '*'; return b; },
        insert(payload: Row) { op.kind = 'insert'; op.payload = payload; return b; },
        update(payload: Row) { op.kind = 'update'; op.payload = payload; return b; },
        eq(c: string, v: unknown) { op.filters.push([c, v]); return b; },
        in() { return b; },
        is() { return b; },
        neq() { return b; },
        gte() { return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle() { return Promise.resolve(run()); },
        single() { return Promise.resolve(run()); },
        then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) { return Promise.resolve(run()).then(ok, err); },
      };
      return b;
    },
  }),
}));
vi.mock('../../../server/services/email/index.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: vi.fn() }));
vi.mock('../../../server/services/billing/visitorLimit.js', async (orig) => ({
  ...(await orig<object>()),
  enforceMaxVisitorsLimitIfNewThisMonth: async () => true,
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { createSessionToken } = await import('../../../server/services/widget/security.js');
const { trackedPage, trackedReferrer, trackingAllowed } = await import('../../../server/services/widget/trackingPrivacy.js');
// /event reads the settings through the workspace's widget snapshot.
const { __resetWidgetConfigCachesForTests } = await import('../../../server/services/widget/configSnapshot.js');

const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const ORIGIN = 'https://shop.example';
const VISITOR = 'aaaaaaaa-0000-4000-8000-000000000001';

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = {
    supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use(express.json());
app.use('/api/widget', widgetRouter);

function track(body: Row, headers: Record<string, string> = {}) {
  db.ops.length = 0;
  let r = request(app).post('/api/widget/track')
    .set('Origin', ORIGIN)
    .set('X-Widget-Token', createSessionToken(WS, ORIGIN))
    .set('X-Forwarded-For', '45.33.32.156');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send({
    workspace_id: WS, visitor_id: VISITOR, event: 'page_view', browser: 'Chrome', device: 'Desktop', os: 'Linux',
    current_page: '/shop/checkout?email=sara%40example.com&token=s3cret#step-2',
    referrer: 'https://search.test/results?q=sara%40example.com',
    ...body,
  });
}
const writes = () => db.ops.filter((o) => o.kind !== 'select');
const written = (table: string, kind: Op['kind'] = 'insert') => writes().find((w) => w.table === table && w.kind === kind)?.payload;

function settings(over: Row = {}) {
  db.tables.widget_settings = [{ workspace_id: WS, store_raw_ip: false, tracking_requires_consent: false, tracking_keep_query: false, ...over }];
}

beforeEach(() => {
  db.noPrivacyColumns = false;
  db.settingsFailOnce = false;
  db.tables = { visitor_sessions: [], workspaces: [{ id: WS, name: 'Shop' }] };
  settings();
});

describe('POST /track: what a page is', () => {
  it('the path only, and a new session\'s referrer without its query', async () => {
    const res = await track({});
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe('sess-new');
    expect(written('visitor_sessions')).toMatchObject({ current_page: '/shop/checkout', referrer: 'https://search.test/results' });
    expect(written('visitor_page_views')).toMatchObject({ url: '/shop/checkout' });
    expect(written('visitor_presence')).toMatchObject({ current_page: '/shop/checkout' });
    expect(JSON.stringify(writes())).not.toContain('s3cret');
    expect(JSON.stringify(writes())).not.toContain('example.com&');
  });

  it('with its query string when the workspace keeps it (never the fragment, never the referrer\'s)', async () => {
    settings({ tracking_keep_query: true });
    await track({});
    expect(written('visitor_sessions')).toMatchObject({
      current_page: '/shop/checkout?email=sara%40example.com&token=s3cret',
      referrer: 'https://search.test/results',
    });
  });

  it('a database before migration 281: the settings read again without the new columns, the defaults apply', async () => {
    db.noPrivacyColumns = true;
    const res = await track({});
    expect(res.body.session_id).toBe('sess-new');
    expect(written('visitor_sessions')).toMatchObject({ current_page: '/shop/checkout' });
  });
});

describe('POST /track: consent', () => {
  it('while the workspace waits for consent: nothing without it, everything with it', async () => {
    settings({ tracking_requires_consent: true });
    const held = await track({});
    expect(held.body).toEqual({ ok: true, tracked: false });
    expect(writes()).toEqual([]);

    const given = await track({ consent: true });
    expect(given.body.session_id).toBe('sess-new');
    expect(written('visitor_sessions')).toBeTruthy();
  });

  it('settings that cannot be read (a timeout, not an older database) are the cautious side: consent asked', async () => {
    settings({ tracking_requires_consent: true });
    db.settingsFailOnce = true;
    const held = await track({});
    expect(held.body).toEqual({ ok: true, tracked: false });
    expect(writes()).toEqual([]);
  });

  it('a refusal is never tracked, wherever', async () => {
    const res = await track({ consent: false });
    expect(res.body).toEqual({ ok: true, tracked: false });
    expect(writes()).toEqual([]);
  });

  it('Global Privacy Control: tracked only with consent, whatever the workspace says', async () => {
    const held = await track({}, { 'Sec-GPC': '1' });
    expect(held.body).toEqual({ ok: true, tracked: false });
    expect(writes()).toEqual([]);
    const given = await track({ consent: true }, { 'Sec-GPC': '1' });
    expect(given.body.session_id).toBe('sess-new');
  });
});

describe('POST /event (gsAnalytics.track): the same rules', () => {
  function event(body: Row, headers: Record<string, string> = {}) {
    __resetWidgetConfigCachesForTests();
    db.ops.length = 0;
    let r = request(app).post('/api/widget/event')
      .set('Origin', ORIGIN)
      .set('X-Widget-Token', createSessionToken(WS, ORIGIN))
      .set('X-Forwarded-For', '45.33.32.156');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send({ workspace_id: WS, session_id: 'sess-1', event_name: 'signup', properties: {}, page_url: '/signup?email=sara%40example.com', ...body });
  }

  it('the page without its query string', async () => {
    const res = await event({});
    expect(res.status).toBe(200);
    expect(written('web_analytics_events')).toMatchObject({ event_name: 'signup', page_url: '/signup' });
  });

  it('nothing while consent is asked for (the workspace or GPC) and not given; a refusal never', async () => {
    settings({ tracking_requires_consent: true });
    expect((await event({})).body).toEqual({ ok: true, tracked: false });
    expect(written('web_analytics_events')).toBeUndefined();
    await event({ consent: true });
    expect(written('web_analytics_events')).toBeTruthy();

    settings();
    expect((await event({}, { 'Sec-GPC': '1' })).body).toEqual({ ok: true, tracked: false });
    expect(written('web_analytics_events')).toBeUndefined();
    await event({ consent: true }, { 'Sec-GPC': '1' });
    expect(written('web_analytics_events')).toBeTruthy();
    expect((await event({ consent: false })).body).toEqual({ ok: true, tracked: false });
    expect(written('web_analytics_events')).toBeUndefined();
  });
});

describe('the helpers', () => {
  it('trackedPage keeps the path (and the query only when asked), never the fragment', () => {
    expect(trackedPage('/a/b?x=1#y', false)).toBe('/a/b');
    expect(trackedPage('/a/b?x=1#y', true)).toBe('/a/b?x=1');
    expect(trackedPage('https://shop.example/p?token=1', false)).toBe('https://shop.example/p');
    expect(trackedPage('', false)).toBeNull();
    expect(trackedPage(null, true)).toBeNull();
    expect(trackedPage('?only=query', false)).toBeNull();
  });

  it('trackedReferrer never keeps a query string', () => {
    expect(trackedReferrer('https://mail.test/inbox?u=sara@example.com')).toBe('https://mail.test/inbox');
    expect(trackedReferrer(undefined)).toBeNull();
  });

  it('trackingAllowed: consent decides; without an answer, the workspace and GPC', () => {
    const req = (gpc?: string) => ({ get: (h: string) => (h.toLowerCase() === 'sec-gpc' ? gpc : undefined) }) as never;
    const asks = { requiresConsent: true, keepQuery: false };
    const free = { requiresConsent: false, keepQuery: false };
    expect(trackingAllowed(req(), free, undefined)).toBe(true);
    expect(trackingAllowed(req(), free, null)).toBe(true);
    expect(trackingAllowed(req(), free, false)).toBe(false);
    expect(trackingAllowed(req(), asks, undefined)).toBe(false);
    expect(trackingAllowed(req(), asks, true)).toBe(true);
    expect(trackingAllowed(req('1'), free, undefined)).toBe(false);
    expect(trackingAllowed(req('1'), free, true)).toBe(true);
    // Only `true` is consent.
    expect(trackingAllowed(req(), asks, 'yes')).toBe(false);
  });
});
