/**
 * Notification preferences belong to one operator and one surface.
 *
 * They used to belong to one operator and nothing else, and both clients
 * wrote to the same row — so an operator who silenced their phone at night
 * silenced the browser on their desk, and an operator who narrowed the
 * browser to "only threads assigned to me" narrowed the phone with it.
 * Neither was ever asked for.
 *
 * The other half of the same bug is what the endpoint accepts: a Zod object
 * strips unknown keys rather than rejecting them, so for months every
 * attempt to change `push_scope`, `push_preview` or `push_internal_notes`
 * answered 200 and wrote nothing at all. Those three are most of what the
 * phone's settings screen is made of.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let pending: 'update' | 'insert' | null = null;
      let payload: Row = {};

      const matched = () => rows.filter((r) => filters.every((f) => f(r)));

      const apply = (): Row[] => {
        if (pending === 'update') {
          const hits = matched();
          for (const r of hits) Object.assign(r, payload);
          return hits;
        }
        if (pending === 'insert') {
          const inserted = { id: payload.id ?? crypto.randomUUID(), ...payload };
          rows.push(inserted);
          return [inserted];
        }
        return matched();
      };

      const builder: any = {
        select: (_cols?: string) => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r: Row) => r[col] !== val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => (r[col] ?? null) === val); return builder; },
        gt(col: string, val: any) { filters.push((r: Row) => r[col] > val); return builder; },
        in(col: string, vals: any[]) { filters.push((r: Row) => vals.includes(r[col])); return builder; },
        order() { return builder; },
        update(patch: Row) { pending = 'update'; payload = patch; return builder; },
        insert(values: Row) { pending = 'insert'; payload = values; return builder; },
        maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
        then(resolve: any) { return resolve({ data: apply(), error: null }); },
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

const { notificationsRouter } = await import('../../../server/routes/notifications.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/notifications', notificationsRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `gs_session=${token}`;
  const payload = body === undefined ? null : JSON.stringify(body);
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json: any = {};
        try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const USER_A = crypto.randomUUID();
const USER_B = crypto.randomUUID();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  const future = new Date(Date.now() + 3600_000).toISOString();
  db.profiles = [
    { id: USER_A, email: 'a@example.com' },
    { id: USER_B, email: 'b@example.com' },
  ];
  db.auth_sessions = [
    { id: crypto.randomUUID(), token_hash: hashToken('token-a'), user_id: USER_A, email: 'a@example.com', created_at: '2026-01-01T00:00:00Z', expires_at: future, revoked_at: null },
    { id: crypto.randomUUID(), token_hash: hashToken('token-b'), user_id: USER_B, email: 'b@example.com', created_at: '2026-01-01T00:00:00Z', expires_at: future, revoked_at: null },
  ];
  db.user_notification_prefs = [];
});

describe('GET /api/notifications/prefs', () => {
  it('answers with the defaults before the operator has ever opened the page', async () => {
    const res = await call('GET', '/api/notifications/prefs?platform=web', 'token-a');
    expect(res.status).toBe(200);
    expect(res.json.platform).toBe('web');
    expect(res.json.prefs.push_scope).toBe('all');
    expect(res.json.prefs.disable_all).toBe(false);
  });

  it('a client that does not name a surface gets the browser one', async () => {
    // A build already open in somebody's tab asks the old way, and must not
    // start reading the phone's row.
    const res = await call('GET', '/api/notifications/prefs', 'token-a');
    expect(res.json.platform).toBe('web');
  });

  it('refuses a surface it does not have', async () => {
    const res = await call('GET', '/api/notifications/prefs?platform=watch', 'token-a');
    expect(res.status).toBe(400);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await call('GET', '/api/notifications/prefs?platform=web', null);
    expect(res.status).toBe(401);
  });

  it('no longer offers the switches nothing enforced', async () => {
    const res = await call('GET', '/api/notifications/prefs?platform=web', 'token-a');
    for (const dead of [
      'email_unread_messages',
      'email_transcripts',
      'email_user_ratings',
      'email_paid_invoices',
      'email_weekly_summary',
      'email_product_updates',
      'push_visitor_browsing',
    ]) {
      expect(res.json.prefs).not.toHaveProperty(dead);
    }
  });
});

describe('PATCH /api/notifications/prefs', () => {
  it('saves the three fields that used to be silently dropped', async () => {
    // They were in the table and read by the dispatcher from the day mobile
    // push shipped, and absent from this route's schema the whole time.
    const res = await call('PATCH', '/api/notifications/prefs', 'token-a', {
      platform: 'mobile',
      push_scope: 'assigned',
      push_preview: false,
      push_internal_notes: false,
    });
    expect(res.status).toBe(200);
    expect(res.json.prefs.push_scope).toBe('assigned');
    expect(res.json.prefs.push_preview).toBe(false);
    expect(res.json.prefs.push_internal_notes).toBe(false);

    const read = await call('GET', '/api/notifications/prefs?platform=mobile', 'token-a');
    expect(read.json.prefs.push_scope).toBe('assigned');
  });

  it('the phone and the browser do not touch each other', async () => {
    await call('PATCH', '/api/notifications/prefs', 'token-a', {
      platform: 'mobile',
      disable_all: true,
      push_scope: 'mentions',
    });

    const web = await call('GET', '/api/notifications/prefs?platform=web', 'token-a');
    expect(web.json.prefs.disable_all).toBe(false);
    expect(web.json.prefs.push_scope).toBe('all');

    const mobile = await call('GET', '/api/notifications/prefs?platform=mobile', 'token-a');
    expect(mobile.json.prefs.disable_all).toBe(true);
    expect(mobile.json.prefs.push_scope).toBe('mentions');
  });

  it('writes one row per surface rather than a new one per save', async () => {
    await call('PATCH', '/api/notifications/prefs', 'token-a', { platform: 'web', play_sound: false });
    await call('PATCH', '/api/notifications/prefs', 'token-a', { platform: 'web', push_preview: false });
    await call('PATCH', '/api/notifications/prefs', 'token-a', { platform: 'mobile', play_sound: false });

    expect(db.user_notification_prefs.filter((r) => r.user_id === USER_A && r.platform === 'web')).toHaveLength(1);
    expect(db.user_notification_prefs.filter((r) => r.user_id === USER_A && r.platform === 'mobile')).toHaveLength(1);

    const web = await call('GET', '/api/notifications/prefs?platform=web', 'token-a');
    expect(web.json.prefs.play_sound).toBe(false);
    expect(web.json.prefs.push_preview).toBe(false);
  });

  it('one operator never reads or writes another operator\'s row', async () => {
    await call('PATCH', '/api/notifications/prefs', 'token-a', { platform: 'web', disable_all: true });

    const b = await call('GET', '/api/notifications/prefs?platform=web', 'token-b');
    expect(b.json.prefs.disable_all).toBe(false);

    await call('PATCH', '/api/notifications/prefs', 'token-b', { platform: 'web', disable_all: false });
    const a = await call('GET', '/api/notifications/prefs?platform=web', 'token-a');
    expect(a.json.prefs.disable_all).toBe(true);
  });

  it('rejects a scope the table would reject', async () => {
    const res = await call('PATCH', '/api/notifications/prefs', 'token-a', {
      platform: 'web',
      push_scope: 'everything',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a quiet-hours time that is not a time', async () => {
    const res = await call('PATCH', '/api/notifications/prefs', 'token-a', {
      platform: 'web',
      quiet_hours_start: '10pm',
    });
    expect(res.status).toBe(400);
  });

  it('keeps the timezone it is given, because the server cannot guess it', async () => {
    const res = await call('PATCH', '/api/notifications/prefs', 'token-a', {
      platform: 'web',
      quiet_hours_enabled: true,
      quiet_hours_start: '22:00',
      quiet_hours_end: '08:00',
      quiet_hours_timezone: 'Asia/Tehran',
    });
    expect(res.status).toBe(200);
    expect(res.json.prefs.quiet_hours_timezone).toBe('Asia/Tehran');
  });

  it('refuses a surface it does not have', async () => {
    const res = await call('PATCH', '/api/notifications/prefs', 'token-a', {
      platform: 'desktop',
      play_sound: false,
    });
    expect(res.status).toBe(400);
  });
});
