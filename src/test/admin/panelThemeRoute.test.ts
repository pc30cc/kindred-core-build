// @vitest-environment node
/**
 * Super Admin → Panel theme: PUT /api/admin/management/panel-theme switches
 * the workspace panel's look for everyone (platform_branding
 * .workspace_panel_theme). Only a platform admin may write it, only a known
 * theme id is accepted, the change is audited, and the public config cache is
 * dropped so members get the new theme on their next read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import cookieParser from 'cookie-parser';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  branding: [] as Row[],
  audit: [] as Row[],
  admins: new Set<string>(),
  sessions: new Map<string, string>(),
  invalidations: 0,
}));

vi.mock('../../../server/supabase.js', () => {
  const table = (name: string) => (name === 'platform_branding' ? state.branding : state.audit);
  return {
    getServiceClient: () => ({
      from(name: string) {
        const rows = table(name);
        let match: (r: Row) => boolean = () => true;
        // Reads return copies, as a real client does: a later update must not
        // rewrite a row the route has already read.
        const copy = (r: Row | undefined) => (r ? { ...r } : null);
        const one = () => ({ data: copy(rows.find(match)), error: null });
        const builder = {
          select: () => builder,
          limit: () => builder,
          eq(col: string, val: unknown) {
            match = (r) => r[col] === val;
            return builder;
          },
          maybeSingle: async () => one(),
          update(patch: Row) {
            return {
              eq(col: string, val: unknown) {
                for (const r of rows) if (r[col] === val) Object.assign(r, patch);
                return { select: () => ({ maybeSingle: async () => ({ data: copy(rows.find((r) => r[col] === val)), error: null }) }) };
              },
            };
          },
          insert(row: Row | Row[]) {
            const added = (Array.isArray(row) ? row : [row]).map((r) => ({ id: `row-${rows.length + 1}`, ...r }));
            rows.push(...added);
            const result = { data: added[0], error: null };
            return { select: () => ({ maybeSingle: async () => result }), then: (resolve: (v: typeof result) => unknown) => resolve(result) };
          },
        };
        return builder;
      },
    }),
  };
});

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async (_config: unknown, userId: string) => state.admins.has(userId),
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    const userId = token ? state.sessions.get(token) : undefined;
    return userId ? { sessionId: 's1', userId, email: 'x@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

vi.mock('../../../server/services/platformPublicConfig.js', () => ({
  invalidatePlatformPublicConfig: () => {
    state.invalidations += 1;
  },
}));

const { adminManagementRouter } = await import('../../../server/routes/adminManagement.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = {
    supabaseUrl: 'http://x',
    supabaseServiceRoleKey: 'k',
    corsOrigins: ['*'],
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin/management', adminManagementRouter);
const server = http.createServer(app).listen(0);

function put(token: string | null, body: unknown): Promise<{ status: number; json: Row }> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
  };
  if (token) headers.cookie = `gs_session=${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/admin/management/panel-theme', method: 'PUT', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data || '{}') as Row }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

beforeEach(() => {
  state.branding.length = 0;
  state.audit.length = 0;
  state.branding.push({ id: 'b1', logo_url: '/logo.svg', workspace_panel_theme: 'classic' });
  state.admins = new Set(['admin-1']);
  state.sessions = new Map([
    ['admin-token', 'admin-1'],
    ['member-token', 'member-1'],
  ]);
  state.invalidations = 0;
});

describe('PUT /api/admin/management/panel-theme', () => {
  it('switches the platform theme, audits it and drops the public config cache', async () => {
    const res = await put('admin-token', { theme: 'art' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ theme: 'art' });
    expect(state.branding[0]).toMatchObject({ id: 'b1', logo_url: '/logo.svg', workspace_panel_theme: 'art' });
    expect(state.invalidations).toBe(1);
    expect(state.audit).toEqual([
      expect.objectContaining({
        user_id: 'admin-1',
        workspace_id: null,
        action: 'admin.panel_theme.changed',
        entity_id: 'b1',
        old_value: { theme: 'classic' },
        new_value: { theme: 'art' },
      }),
    ]);
  });

  it('switches back to classic: no theme is ever removed', async () => {
    state.branding[0].workspace_panel_theme = 'art';
    const res = await put('admin-token', { theme: 'classic' });
    expect(res.status).toBe(200);
    expect(state.branding[0].workspace_panel_theme).toBe('classic');
  });

  it('creates the branding row when there is none yet', async () => {
    state.branding.length = 0;
    const res = await put('admin-token', { theme: 'art' });
    expect(res.status).toBe(200);
    expect(state.branding).toEqual([expect.objectContaining({ workspace_panel_theme: 'art' })]);
  });

  it('accepts only a known theme id', async () => {
    for (const theme of ['neon', '', 'ART', "art'; drop table x", null]) {
      expect((await put('admin-token', { theme })).status).toBe(400);
    }
    expect((await put('admin-token', {})).status).toBe(400);
    expect(state.branding[0].workspace_panel_theme).toBe('classic');
    expect(state.audit).toEqual([]);
  });

  it('refuses a workspace member and an anonymous caller', async () => {
    expect((await put('member-token', { theme: 'art' })).status).toBe(403);
    expect((await put(null, { theme: 'art' })).status).toBe(401);
    expect(state.branding[0].workspace_panel_theme).toBe('classic');
    expect(state.invalidations).toBe(0);
  });
});
