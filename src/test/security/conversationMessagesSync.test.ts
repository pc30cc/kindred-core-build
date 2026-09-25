/**
 * Incremental thread sync — GET /api/conversations/:id/messages?since=…
 *
 * The native Windows app keeps each thread on the PC and asks only for what
 * changed. This proves the delta contract the client relies on:
 *   - without `since` the thread comes back in full, exactly as before, plus
 *     an additive `sync` block;
 *   - with a cursor only rows created OR UPDATED after it come back;
 *   - `total` always equals what a full fetch would return, so a delete (or
 *     a row hidden by the Telegram menu switch) is detectable;
 *   - a cursor stays SAFETY_LAG behind the clock and never moves backwards;
 *   - a server without the migration degrades to full answers;
 *   - authorization is unchanged, and unchanged answers revalidate to 304.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import {
  decodeCursor,
  encodeCursor,
  microsToTimestamp,
  nextCursor,
  SAFETY_LAG_MICROS,
  timestampToMicros,
} from '../../../server/services/messageSync.js';

type Row = Record<string, unknown>;
/** The fake query builder: a chain of filters ending in a thenable, like supabase-js. */
type Builder = Record<string, unknown> & { then: (resolve: (r: unknown) => unknown) => unknown };
type Json = { [key: string]: unknown };
type Answer = { status: number; json: Json; headers: http.IncomingHttpHeaders; bytes: number };
const ids = (list: unknown): unknown[] => (list as Array<{ id: unknown }>).map((m) => m.id);
const db: Record<string, Row[]> = {};
const flags = { menuVisible: true, noUpdatedAtColumn: false };

function field(row: Row, col: string): unknown {
  const json = /^(\w+)->>(\w+)$/.exec(col);
  if (json) {
    const v = (row[json[1]] as Row | null | undefined)?.[json[2]];
    return v === undefined || v === null ? null : String(v);
  }
  return row[col];
}

function evalOrClause(row: Row, clause: string): boolean {
  const m = /^(.+?)\.(is|neq|eq|in)\.(.*)$/.exec(clause);
  if (!m) return false;
  const [, col, op, val] = m;
  const v = field(row, col);
  if (op === 'is') return val === 'null' ? v === null || v === undefined : v === val;
  if (op === 'neq') return v !== val;
  if (op === 'eq') return v === val;
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').includes(String(v));
  return false;
}

/** Splits "a.in.(x,y),b.is.null" on the commas that separate clauses, not those inside (). */
function splitOr(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      const orGroups: string[][] = [];
      let countMode = false;
      let failure: { code: string; message: string } | null = null;
      let orderCol: string | null = null;
      let limitN: number | null = null;
      const builder: Builder = {
        select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) countMode = true;
          return builder;
        },
        eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: unknown) { filters.push((r) => r[col] !== val); return builder; },
        is(col: string, val: unknown) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
        in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        gt(col: string, val: string) {
          if (flags.noUpdatedAtColumn && col === 'updated_at') failure = { code: '42703', message: 'column does not exist' };
          const bound = timestampToMicros(val)!;
          filters.push((r) => {
            const t = timestampToMicros(r[col]);
            return t !== null && t > bound;
          });
          return builder;
        },
        or(clauseStr: string) { orGroups.push(splitOr(clauseStr)); return builder; },
        order(col: string) { orderCol = col; return builder; },
        limit(n: number) { limitN = n; return builder; },
        async maybeSingle() {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: (r: unknown) => unknown) {
          if (failure) return resolve({ data: null, error: failure, count: null });
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          for (const group of orGroups) matched = matched.filter((r) => group.some((c) => evalOrClause(r, c)));
          if (orderCol) {
            const c = orderCol;
            matched = [...matched].sort((a, b) => String(a[c] ?? '').localeCompare(String(b[c] ?? '')));
          }
          if (limitN !== null) matched = matched.slice(0, limitN);
          if (countMode) return resolve({ data: null, error: null, count: matched.length });
          const data = flags.noUpdatedAtColumn
            ? matched.map(({ updated_at: _u, ...rest }) => ({ ...rest }))
            : matched.map((r) => ({ ...r }));
          return resolve({ data, error: null });
        },
      };
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'is_workspace_member') {
        const member = (db.workspace_members || []).find(
          (m) => m.workspace_id === args._workspace_id && m.user_id === args._user_id,
        );
        return { data: !!member, error: null };
      }
      return { data: null, error: null };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));
vi.mock('../../../server/services/channels/telegram/settings.js', () => ({
  isTelegramMenuEventsVisible: async () => flags.menuVisible,
}));
vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = db.__sessions?.find((s) => s.token === token);
    return user ? { sessionId: 'test-session', userId: user.userId, email: 'test@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishConversationEvent: async () => ({ ok: false, reason: 'not_configured' }),
  publishOperatorEvent: async () => ({ ok: false }),
  buildMessageEnvelope: (m: unknown) => ({ type: 'message', payload: m }),
}));
vi.mock('../../../server/services/billing/conversationLimit.js', () => ({
  enforceMaxConversationsLimit: async () => true,
}));

const { conversationsRouter } = await import('../../../server/routes/conversations.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/conversations', conversationsRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

function call(path: string, opts: { token?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: port(), path, method: 'GET',
        headers: { ...(opts.token ? { cookie: `gs_session=${opts.token}` } : {}), ...(opts.headers ?? {}) },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json: Json = {};
          try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
          resolve({ status: res.statusCode || 0, json, headers: res.headers, bytes: Buffer.byteLength(d) });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const MEMBER = crypto.randomUUID();
const WS = crypto.randomUUID();
const WS_B = crypto.randomUUID();
let conv: string;
let foreign: string;

/** Well before now - SAFETY_LAG, so a cursor settles on the newest row. */
const OLD = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.123456+00:00`;

function message(id: string, minute: number, extra: Row = {}): Row {
  return { id, conversation_id: conv, sender_type: 'contact', body: `m${minute}`, metadata: {}, created_at: OLD(minute), updated_at: OLD(minute), ...extra };
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  flags.menuVisible = true;
  flags.noUpdatedAtColumn = false;
  conv = crypto.randomUUID();
  foreign = crypto.randomUUID();
  db.__sessions = [{ token: 'member-token', userId: MEMBER }];
  db.workspace_members = [{ id: crypto.randomUUID(), workspace_id: WS, user_id: MEMBER, role: 'owner' }];
  db.conversations = [
    { id: conv, workspace_id: WS, status: 'open', is_spam: false, ai_state: null, assigned_to: null, updated_at: '2026-01-01T00:00:00Z' },
    { id: foreign, workspace_id: WS_B, status: 'open', is_spam: false, ai_state: null, assigned_to: null, updated_at: '2026-01-01T00:00:00Z' },
  ];
  db.contacts = [];
  db.conversation_attachments = [];
  db.profiles = [];
  db.conversation_messages = [message('a', 1), message('b', 2), message('c', 3)];
});

describe('cursor arithmetic', () => {
  it('keeps microseconds and time zones exactly', () => {
    const a = timestampToMicros('2026-01-01T00:00:00.123456+00:00')!;
    expect(timestampToMicros('2026-01-01T03:30:00.123456+03:30')).toBe(a);
    expect(timestampToMicros(microsToTimestamp(a))).toBe(a);
    expect(timestampToMicros('2026-01-01T00:00:00.1234565Z')).toBe(a); // beyond µs is dropped
    expect(timestampToMicros('garbage')).toBeNull();
  });

  it('encodes opaque cursors and rejects foreign ones', () => {
    expect(decodeCursor(encodeCursor(42n))).toBe(42n);
    expect(decodeCursor('2026-01-01')).toBeNull();
    expect(decodeCursor('v1.-5')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('stays SAFETY_LAG behind now and never moves backwards', () => {
    const now = timestampToMicros('2026-01-01T01:00:00Z')!;
    const recent = microsToTimestamp(now - 1_000_000n);
    expect(nextCursor([{ updated_at: recent }], null, now)).toBe(now - SAFETY_LAG_MICROS);
    expect(nextCursor([{ updated_at: OLD(5) }], null, now)).toBe(timestampToMicros(OLD(5)));
    expect(nextCursor([], now, now)).toBe(now); // a cursor from the future stays put
    expect(nextCursor([{ id: 'x' } as { updated_at?: unknown }], null, now)).toBeNull(); // no column → no cursor
  });
});

describe('GET /:id/messages — full answers keep their shape', () => {
  it('returns the whole thread plus an additive sync block', async () => {
    const res = await call(`/api/conversations/${conv}/messages`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(ids(res.json.messages)).toEqual(['a', 'b', 'c']);
    expect(res.json.sync.mode).toBe('full');
    expect(res.json.sync.total).toBe(3);
    expect(decodeCursor(res.json.sync.cursor)).toBe(timestampToMicros(OLD(3)));
  });

  it('an unchanged thread revalidates to 304 with no body', async () => {
    const first = await call(`/api/conversations/${conv}/messages`, { token: 'member-token' });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    const again = await call(`/api/conversations/${conv}/messages`, { token: 'member-token', headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(again.bytes).toBe(0);
  });

  it('an unknown cursor is answered in full', async () => {
    const res = await call(`/api/conversations/${conv}/messages?since=not-a-cursor`, { token: 'member-token' });
    expect(res.json.sync.mode).toBe('full');
    expect(res.json.messages).toHaveLength(3);
  });
});

describe('GET /:id/messages?since= — deltas', () => {
  async function cursorNow() {
    const res = await call(`/api/conversations/${conv}/messages`, { token: 'member-token' });
    return res.json.sync.cursor as string;
  }

  it('nothing changed → empty delta, total unchanged, cursor only moves forward', async () => {
    const cursor = await cursorNow();
    const res = await call(`/api/conversations/${conv}/messages?since=${cursor}`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(res.json.messages).toEqual([]);
    expect(res.json.sync.mode).toBe('delta');
    expect(res.json.sync.total).toBe(3);
    // Nothing changed up to now - SAFETY_LAG, so the cursor may advance to it (never past it).
    const next = decodeCursor(res.json.sync.cursor)!;
    expect(next).toBeGreaterThanOrEqual(decodeCursor(cursor)!);
    expect(next).toBeLessThanOrEqual(BigInt(Date.now()) * 1000n - SAFETY_LAG_MICROS);
  });

  it('one new message → only that message', async () => {
    const cursor = await cursorNow();
    db.conversation_messages.push(message('d', 4));
    const res = await call(`/api/conversations/${conv}/messages?since=${cursor}`, { token: 'member-token' });
    expect(ids(res.json.messages)).toEqual(['d']);
    expect(res.json.sync.total).toBe(4);
    expect(decodeCursor(res.json.sync.cursor)).toBe(timestampToMicros(OLD(4)));
  });

  it('an edited message (delivery status, anonymizer) comes back with its new content', async () => {
    const cursor = await cursorNow();
    const b = db.conversation_messages.find((m) => m.id === 'b')!;
    b.metadata = { delivery_status: 'delivered' };
    b.updated_at = OLD(10);
    const res = await call(`/api/conversations/${conv}/messages?since=${cursor}`, { token: 'member-token' });
    expect(res.json.messages).toHaveLength(1);
    expect(res.json.messages[0].metadata.delivery_status).toBe('delivered');
    expect(res.json.messages[0].created_at).toBe(OLD(2));
  });

  it('a file linked later is embedded in the re-sent message', async () => {
    const cursor = await cursorNow();
    db.conversation_attachments.push({ id: 'f1', message_id: 'c', status: 'attached', file_name: 'x.png', mime_type: 'image/png', size_bytes: 10 });
    db.conversation_messages.find((m) => m.id === 'c')!.updated_at = OLD(11); // the attachment trigger's touch
    const res = await call(`/api/conversations/${conv}/messages?since=${cursor}`, { token: 'member-token' });
    expect(res.json.messages[0].attachments[0]).toMatchObject({ id: 'f1', kind: 'image' });
  });

  it('a deleted message shows up as a smaller total', async () => {
    const cursor = await cursorNow();
    db.conversation_messages = db.conversation_messages.filter((m) => m.id !== 'b');
    const res = await call(`/api/conversations/${conv}/messages?since=${cursor}`, { token: 'member-token' });
    expect(res.json.messages).toEqual([]);
    expect(res.json.sync.total).toBe(2);
  });

  it('hidden bot-menu taps are left out of both the delta and the total', async () => {
    flags.menuVisible = false;
    const cursor = await cursorNow();
    db.conversation_messages.push(message('menu', 5, { metadata: { channel_menu_event: true } }));
    db.conversation_messages.push(message('e', 6));
    const res = await call(`/api/conversations/${conv}/messages?since=${cursor}`, { token: 'member-token' });
    expect(ids(res.json.messages)).toEqual(['e']);
    expect(res.json.sync.total).toBe(4);
    const full = await call(`/api/conversations/${conv}/messages`, { token: 'member-token' });
    expect(full.json.sync.total).toBe(full.json.messages.length);
    expect(ids(full.json.messages)).not.toContain('menu');
  });

  it('a very recent change is re-sent until it is older than the safety lag', async () => {
    const cursor = await cursorNow();
    const fresh = new Date().toISOString().replace('Z', '000+00:00');
    db.conversation_messages.push(message('z', 7, { created_at: fresh, updated_at: fresh }));
    const first = await call(`/api/conversations/${conv}/messages?since=${cursor}`, { token: 'member-token' });
    expect(ids(first.json.messages)).toEqual(['z']);
    const second = await call(`/api/conversations/${conv}/messages?since=${first.json.sync.cursor}`, { token: 'member-token' });
    expect(ids(second.json.messages)).toEqual(['z']); // upserted again by id: harmless
    expect(decodeCursor(first.json.sync.cursor)!).toBeGreaterThanOrEqual(decodeCursor(cursor)!);
  });

  it('a server without the updated_at column answers in full and hands out no cursor', async () => {
    flags.noUpdatedAtColumn = true;
    const full = await call(`/api/conversations/${conv}/messages`, { token: 'member-token' });
    expect(full.json.sync.cursor).toBeNull();
    const res = await call(`/api/conversations/${conv}/messages?since=${encodeCursor(1n)}`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(res.json.sync.mode).toBe('full');
    expect(res.json.messages).toHaveLength(3);
  });

  it('a delta never crosses workspaces', async () => {
    const res = await call(`/api/conversations/${foreign}/messages?since=${encodeCursor(1n)}`, { token: 'member-token' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/conversations — the inbox list revalidates with If-None-Match', () => {
  it('an unchanged list is a 304 with no body; a change is a fresh 200', async () => {
    const first = await call(`/api/conversations?workspace_id=${WS}&queue=main&status=open`, { token: 'member-token' });
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    const same = await call(`/api/conversations?workspace_id=${WS}&queue=main&status=open`, { token: 'member-token', headers: { 'if-none-match': etag } });
    expect(same.status).toBe(304);
    db.conversations[0].priority = 'urgent';
    const changed = await call(`/api/conversations?workspace_id=${WS}&queue=main&status=open`, { token: 'member-token', headers: { 'if-none-match': etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });
});
