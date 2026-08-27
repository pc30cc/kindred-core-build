/**
 * FINAL GOTRUE CUTOVER — the dashboard operations that used to run
 * browser-direct against Supabase under `authenticated`/auth.uid() RLS now
 * live behind first-party Express routes. These tests prove:
 *   1. every migrated admin route rejects a request with no gs_session (401)
 *   2. a non-admin principal is rejected (403)
 *   3. the browser Supabase client has all Auth session machinery OFF
 *   4. no production source calls supabase.auth.*
 *   5. no service_role key is referenced from src/
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => r[col] === val); return builder; },
        ilike(col: string, val: string) {
          filters.push((r: Row) => String(r[col] ?? '').toLowerCase() === val.toLowerCase());
          return builder;
        },
        like: () => builder,
        gte: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        single: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        insert(payload: Row) {
          const inserted = { id: crypto.randomUUID(), ...payload };
          rows.push(inserted);
          const ib: any = {
            select: () => ({ single: async () => ({ data: inserted, error: null }) }),
            then: (resolve: any) => resolve({ data: inserted, error: null }),
          };
          return ib;
        },
        update(patch: Row) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const ub: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return ub; },
            is(col: string, val: null) { scoped.push((r: Row) => r[col] === val); return ub; },
            select: () => ({
              maybeSingle: async () => {
                const matched = rows.filter((r) => scoped.every((f) => f(r)));
                for (const r of matched) Object.assign(r, patch);
                return { data: matched[0] ?? null, error: null };
              },
              single: async () => {
                const matched = rows.filter((r) => scoped.every((f) => f(r)));
                for (const r of matched) Object.assign(r, patch);
                return { data: matched[0] ?? null, error: null };
              },
            }),
            then(resolve: any) {
              const matched = rows.filter((r) => scoped.every((f) => f(r)));
              for (const r of matched) Object.assign(r, patch);
              return resolve({ data: matched, error: null });
            },
          };
          return ub;
        },
        upsert(payload: Row) {
          const existing = rows.find((r) => r.key === payload.key);
          if (existing) Object.assign(existing, payload);
          else rows.push({ id: crypto.randomUUID(), ...payload });
          return { then: (resolve: any) => resolve({ data: null, error: null }) };
        },
        delete() {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const dbld: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return dbld; },
            then(resolve: any) {
              db[table] = rows.filter((r) => !scoped.every((f) => f(r)));
              return resolve({ data: null, error: null });
            },
          };
          return dbld;
        },
        then(resolve: any) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async (_c: unknown, userId: string) =>
    (db.user_roles || []).some((r) => r.user_id === userId && r.role === 'admin'),
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = db.__sessions?.find((s) => s.token === token);
    return user ? { sessionId: 's1', userId: user.userId, email: 'x@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

const { adminManagementRouter } = await import('../../../server/routes/adminManagement.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin/management', adminManagementRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(method: string, p: string, token: string | null, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `gs_session=${token}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path: p, method, headers }, (res) => {
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

const ADMIN_USER = crypto.randomUUID();
const ORDINARY_USER = crypto.randomUUID();

const MIGRATED_ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/admin/management/platform-settings'],
  ['PUT', '/api/admin/management/platform-settings', { timezone: 'UTC' }],
  ['GET', '/api/admin/management/email-settings'],
  ['PUT', '/api/admin/management/email-settings', { sender_email: 'a@b.co' }],
  ['GET', '/api/admin/management/email-settings-localized'],
  ['PUT', '/api/admin/management/email-settings-localized', { locale: 'en' }],
  ['PATCH', '/api/admin/management/feature-flags/f1', { enabled: true }],
  ['GET', '/api/admin/management/domains'],
  ['GET', '/api/admin/management/login-attempts?email=a@b.co'],
  ['GET', '/api/admin/management/runtime-config/privacy_export_storage'],
  ['PUT', '/api/admin/management/runtime-config/privacy_export_storage', { value: { provider: 'local' } }],
  ['DELETE', '/api/admin/management/runtime-config/privacy_export_storage'],
];

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.__sessions = [
    { token: 'admin-token', userId: ADMIN_USER },
    { token: 'ordinary-token', userId: ORDINARY_USER },
  ];
  db.user_roles = [{ id: crypto.randomUUID(), user_id: ADMIN_USER, role: 'admin' }];
  db.feature_flags = [{ id: 'f1', workspace_id: null, key: 'beta', enabled: false }];
  db.login_attempts = [{ id: 'l1', email: 'a@b.co', success: false, created_at: '2026-01-01' }];
  db.platform_settings = [{ id: 'p1', timezone: 'UTC' }];
  db.app_runtime_config = [];
});

describe('migrated dashboard routes — first-party authorization', () => {
  it('rejects every migrated route without a gs_session cookie', async () => {
    for (const [method, p, body] of MIGRATED_ROUTES) {
      const res = await call(method, p, null, body);
      expect(`${method} ${p} → ${res.status}`).toBe(`${method} ${p} → 401`);
    }
  });

  it('rejects every migrated route for a non-admin principal', async () => {
    for (const [method, p, body] of MIGRATED_ROUTES) {
      const res = await call(method, p, 'ordinary-token', body);
      expect(`${method} ${p} → ${res.status}`).toBe(`${method} ${p} → 403`);
    }
  });

  it('allows a platform admin to toggle a global feature flag', async () => {
    const res = await call('PATCH', '/api/admin/management/feature-flags/f1', 'admin-token', { enabled: true });
    expect(res.status).toBe(200);
    expect(db.feature_flags[0].enabled).toBe(true);
  });

  it('never lets runtime-config writes flip the auth provider', async () => {
    const res = await call('PUT', '/api/admin/management/runtime-config/default_auth_provider', 'admin-token', {
      value: { provider_name: 'supabase' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects malformed runtime-config keys', async () => {
    const res = await call('GET', '/api/admin/management/runtime-config/..%2Fetc', 'admin-token');
    expect(res.status).toBe(400);
  });
});

// ── Static source guarantees ──────────────────────────────────────────
const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === '__tests__') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('browser Supabase client — Auth session machinery is off', () => {
  const source = read('src/integrations/supabase/client.ts');

  it('persistSession, autoRefreshToken and detectSessionInUrl are all false', () => {
    expect(source).toMatch(/persistSession:\s*false/);
    expect(source).toMatch(/autoRefreshToken:\s*false/);
    expect(source).toMatch(/detectSessionInUrl:\s*false/);
  });

  it('does not install a custom auth storage broker', () => {
    expect(source).not.toMatch(/brokeredPreviewStorage/);
    expect(source).not.toMatch(/storage:/);
  });
});

describe('production source has no Supabase Auth or service_role usage', () => {
  const files = walk(path.join(root, 'src'));

  it('no production module calls supabase.auth.*', () => {
    const offenders = files.filter((f) => /supabase\.auth\./.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('no frontend module reads or embeds a service role key', () => {
    // Prose mentions of service_role in comments are fine; an actual key
    // reference (env read, variable, or a service_role JWT literal) is not.
    const offenders = files.filter((f) =>
      /SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey\s*[:=]|"role"\s*:\s*"service_role"/.test(
        fs.readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
