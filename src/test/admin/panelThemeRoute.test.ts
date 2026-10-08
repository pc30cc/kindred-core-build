// @vitest-environment node
/**
 * Super Admin → Panel theme: PUT /api/admin/management/panel-theme switches
 * the workspace panel's look for everyone (platform_branding
 * .workspace_panel_theme), with the theme's options (Art's layout and colour
 * scheme, .workspace_panel_theme_options, migration 254). Only a platform
 * admin may write it, only a known theme id and known option values are
 * accepted, options are merged into the theme's own entry (every other
 * entry kept), the change is audited, and the public config cache is dropped
 * so members get the new look on their next read.
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
  /** Every patch the route sent to platform_branding, as sent. */
  patches: [] as Row[],
  admins: new Set<string>(),
  sessions: new Map<string, string>(),
  invalidations: 0,
  /** Columns the table lacks (a database before a migration): an insert naming one fails, as PostgREST's does. */
  missingColumns: new Set<string>(),
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
            if (name === 'platform_branding') state.patches.push(structuredClone(patch));
            return {
              eq(col: string, val: unknown) {
                for (const r of rows) if (r[col] === val) Object.assign(r, patch);
                return { select: () => ({ maybeSingle: async () => ({ data: copy(rows.find((r) => r[col] === val)), error: null }) }) };
              },
            };
          },
          insert(row: Row | Row[]) {
            const given = Array.isArray(row) ? row : [row];
            const missing = given.flatMap((r) => Object.keys(r)).find((key) => state.missingColumns.has(key));
            if (missing) {
              const failed = {
                data: null,
                error: { code: 'PGRST204', message: `Could not find the '${missing}' column of '${name}' in the schema cache` },
              };
              return { select: () => ({ maybeSingle: async () => failed }), then: (resolve: (v: typeof failed) => unknown) => resolve(failed) };
            }
            const added = given.map((r) => ({ id: `row-${rows.length + 1}`, ...r }));
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
  state.patches.length = 0;
  state.branding.push({ id: 'b1', logo_url: '/logo.svg', workspace_panel_theme: 'classic' });
  state.admins = new Set(['admin-1']);
  state.sessions = new Map([
    ['admin-token', 'admin-1'],
    ['member-token', 'member-1'],
  ]);
  state.invalidations = 0;
  state.missingColumns = new Set();
});

describe('PUT /api/admin/management/panel-theme', () => {
  it('switches the platform theme, audits it and drops the public config cache', async () => {
    const res = await put('admin-token', { theme: 'art' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ theme: 'art', options: { layout: 'topnav', palette: 'clay' } });
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

describe('PUT /api/admin/management/panel-theme — options', () => {
  // A database with migration 254: the options column is there.
  const withOptions = (options: Row) => {
    state.branding[0].workspace_panel_theme_options = options;
  };

  it('activates Art with its layout and colour scheme, merged into its entry, other entries kept', async () => {
    withOptions({ art: { layout: 'topnav', palette: 'sage' }, classic: {}, future: { shape: 'round' } });
    const res = await put('admin-token', { theme: 'art', options: { layout: 'sidebar' } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ theme: 'art', options: { layout: 'sidebar', palette: 'sage' } });
    expect(state.branding[0]).toMatchObject({
      workspace_panel_theme: 'art',
      workspace_panel_theme_options: { art: { layout: 'sidebar', palette: 'sage' }, classic: {}, future: { shape: 'round' } },
    });
    expect(state.invalidations).toBe(1);
    expect(state.audit).toEqual([
      expect.objectContaining({
        action: 'admin.panel_theme.changed',
        old_value: { theme: 'classic', options: { layout: 'topnav', palette: 'sage' } },
        new_value: { theme: 'art', options: { layout: 'sidebar', palette: 'sage' } },
      }),
    ]);
  });

  it('saves the active theme’s options without changing the theme', async () => {
    state.branding[0].workspace_panel_theme = 'art';
    withOptions({ art: { layout: 'sidebar', palette: 'clay' } });
    const res = await put('admin-token', { theme: 'art', options: { palette: 'ocean' } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ theme: 'art', options: { layout: 'sidebar', palette: 'ocean' } });
    expect(state.branding[0]).toMatchObject({
      workspace_panel_theme: 'art',
      workspace_panel_theme_options: { art: { layout: 'sidebar', palette: 'ocean' } },
    });
  });

  it('accepts every layout and colour scheme Art offers', async () => {
    withOptions({});
    for (const layout of ['topnav', 'sidebar']) {
      for (const palette of ['clay', 'sage', 'indigo', 'plum', 'ocean', 'saffron', 'graphite']) {
        const res = await put('admin-token', { theme: 'art', options: { layout, palette } });
        expect(res.status, `${layout}/${palette}`).toBe(200);
        expect((state.branding[0].workspace_panel_theme_options as Row).art).toEqual({ layout, palette });
      }
    }
  });

  it('refuses an unknown option, an unknown value and options of a theme that has none', async () => {
    withOptions({ art: { layout: 'topnav', palette: 'clay' } });
    const bad: unknown[] = [
      { layout: 'floating' },
      { palette: 'neon' },
      { palette: 'CLAY' },
      { colour: 'red' },
      { layout: 1 },
      { layout: null },
      { constructor: 'sidebar' },
      { toString: 'sidebar' },
      ['sidebar'],
      'sidebar',
      null,
    ];
    for (const options of bad) {
      expect((await put('admin-token', { theme: 'art', options })).status, JSON.stringify(options)).toBe(400);
    }
    expect((await put('admin-token', { theme: 'classic', options: { layout: 'sidebar' } })).status).toBe(400);
    expect(state.branding[0]).toMatchObject({
      workspace_panel_theme: 'classic',
      workspace_panel_theme_options: { art: { layout: 'topnav', palette: 'clay' } },
    });
    expect(state.patches).toEqual([]);
    expect(state.audit).toEqual([]);
    expect(state.invalidations).toBe(0);
  });

  it('without options (or with none set) leaves the options column alone', async () => {
    withOptions({ art: { layout: 'sidebar', palette: 'plum' } });
    expect((await put('admin-token', { theme: 'art' })).status).toBe(200);
    expect((await put('admin-token', { theme: 'classic', options: {} })).status).toBe(200);
    expect(state.patches).toHaveLength(2);
    for (const patch of state.patches) expect(patch).not.toHaveProperty('workspace_panel_theme_options');
    expect(state.branding[0].workspace_panel_theme_options).toEqual({ art: { layout: 'sidebar', palette: 'plum' } });
    // The theme-only audit keeps its shape.
    expect(state.audit[0].old_value).toEqual({ theme: 'classic' });
    expect(state.audit[0].new_value).toEqual({ theme: 'art' });
  });

  it('before migration 254 a theme still switches, and options are refused with a clear answer', async () => {
    // beforeEach's row has no options column, as a database before 254.
    expect((await put('admin-token', { theme: 'art' })).status).toBe(200);
    expect(state.branding[0].workspace_panel_theme).toBe('art');

    const res = await put('admin-token', { theme: 'art', options: { layout: 'sidebar' } });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'migration_required' });
    expect(state.branding[0]).not.toHaveProperty('workspace_panel_theme_options');
    expect(state.patches).toHaveLength(1);
  });

  it('before migration 254 and without a branding row, options get the same clear answer, not a 500', async () => {
    state.branding.length = 0;
    state.missingColumns = new Set(['workspace_panel_theme_options']);
    const res = await put('admin-token', { theme: 'art', options: { layout: 'sidebar' } });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'migration_required' });
    expect(state.branding).toEqual([]);
    expect(state.audit).toEqual([]);
    expect(state.invalidations).toBe(0);
    // The theme alone still creates the row.
    expect((await put('admin-token', { theme: 'art' })).status).toBe(200);
    expect(state.branding).toEqual([expect.objectContaining({ workspace_panel_theme: 'art' })]);
  });

  it('refuses options from anyone but a platform admin', async () => {
    withOptions({});
    expect((await put('member-token', { theme: 'art', options: { layout: 'sidebar' } })).status).toBe(403);
    expect(state.branding[0].workspace_panel_theme_options).toEqual({});
  });
});
