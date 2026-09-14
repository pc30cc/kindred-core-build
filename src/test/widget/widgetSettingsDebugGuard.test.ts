/**
 * Behavioral (not source-string) coverage for the root-cause fix in
 * server/routes/widgetSettings.ts: the workspace owner/admin-facing
 * `PATCH /api/widget-settings/:workspaceId` endpoint used
 * `z.object({}).passthrough()` with no field allowlist, so any accepted
 * request body — including `{ debug_mode: true }`, which makes the WIDGET
 * ITSELF verbose in every visitor's browser console for that workspace —
 * was written straight to the `widget_settings` row with zero warning,
 * zero dedicated UI, and zero audit trail. This is how a production
 * workspace could end up broadcasting diagnostics to every visitor despite
 * no browser-side debug flag ever being set.
 *
 * Mounts the REAL widgetSettingsRouter against a fake Supabase client and
 * proves:
 *   - the generic PATCH strips debug_mode from the request body — it can
 *     never be set through the workspace's own settings API, whatever a
 *     future frontend bug or a stray curl command sends
 *   - other, legitimate fields in the SAME request still save normally
 *     (this isn't a blanket regression of the settings save feature)
 *   - the new PATCH /:workspaceId/debug endpoint requires platform-admin
 *     authorization — a workspace owner/admin (not a platform admin)
 *     is denied
 *   - a genuine platform admin CAN deliberately set debug_mode through
 *     that dedicated endpoint
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const WS_ID = '55555555-5555-4555-8555-555555555555';

type FakeSettingsRow = Record<string, any>;
let settingsRow: FakeSettingsRow;
let isPlatformAdmin: boolean;

function resetFakeDb() {
  settingsRow = {
    workspace_id: WS_ID,
    debug_mode: false,
    primary_color: '#3B82F6',
    welcome_message: 'Hello!',
  };
  isPlatformAdmin = false;
}

function makeFakeSupabase() {
  function widgetSettingsBuilder() {
    const b: any = {
      select: () => b,
      eq: () => b,
      update: (patch: Record<string, any>) => {
        Object.assign(settingsRow, patch);
        return b;
      },
      single: async () => ({ data: { ...settingsRow }, error: null }),
    };
    return b;
  }
  return {
    from(table: string) {
      if (table === 'widget_settings') return widgetSettingsBuilder();
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => makeFakeSupabase(),
}));

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async (_req: any, _res: any, _workspaceId: string, _opts: any) => ({ userId: 'owner-1' }),
  requirePlatformAdmin: async (_req: any, res: any) => {
    if (!isPlatformAdmin) {
      res.status(403).json({ error: 'platform_admin_required' });
      return null;
    }
    return 'platform-admin-1';
  },
}));

vi.mock('../../../server/services/phoneVerification/index.js', () => ({
  assertPhoneVerificationSatisfied: async () => {},
}));
vi.mock('../../../server/services/phoneVerification/types.js', () => ({
  PhoneVerificationError: class PhoneVerificationError extends Error {},
}));
vi.mock('../../../server/services/widget/public.js', () => ({
  invalidateWorkspaceOriginCache: () => {},
}));
vi.mock('../../../server/services/widget/entitlements.js', () => ({
  resolveWidgetEntitlements: async () => ({ features: {}, maxDomains: 10 }),
  guardWidgetSettingsPatch: () => ({ ok: true, denied: [] }),
}));

const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' };
  next();
});
app.use(express.json());
app.use('/api/widget-settings', widgetSettingsRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function patch(path: string, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

beforeEach(() => {
  resetFakeDb();
});

describe('PATCH /api/widget-settings/:workspaceId — debug_mode is never settable through the generic workspace-admin endpoint', () => {
  it('debug_mode in the request body is silently stripped, not written', async () => {
    const res = await patch(`/api/widget-settings/${WS_ID}`, { debug_mode: true, primary_color: '#000000' });
    expect(res.status).toBe(200);
    expect(settingsRow.debug_mode).toBe(false);
    // Every OTHER field in the same request still saves — this is a
    // targeted strip, not a broken settings endpoint.
    expect(settingsRow.primary_color).toBe('#000000');
    expect(res.body.settings.debug_mode).toBe(false);
  });

  it('debug_mode alone in the request body is a no-op for that field, but the request still succeeds', async () => {
    const res = await patch(`/api/widget-settings/${WS_ID}`, { debug_mode: true });
    expect(res.status).toBe(200);
    expect(settingsRow.debug_mode).toBe(false);
  });

  it('a request with no debug_mode at all is completely unaffected (no regression to ordinary saves)', async () => {
    const res = await patch(`/api/widget-settings/${WS_ID}`, { welcome_message: 'Hi there!' });
    expect(res.status).toBe(200);
    expect(settingsRow.welcome_message).toBe('Hi there!');
    expect(settingsRow.debug_mode).toBe(false);
  });
});

describe('PATCH /api/widget-settings/:workspaceId/debug — platform-admin-only, deliberate opt-in', () => {
  it('a workspace owner/admin (not a platform admin) is denied', async () => {
    isPlatformAdmin = false;
    const res = await patch(`/api/widget-settings/${WS_ID}/debug`, { debug_mode: true });
    expect(res.status).toBe(403);
    expect(settingsRow.debug_mode).toBe(false);
  });

  it('a genuine platform admin can deliberately enable it', async () => {
    isPlatformAdmin = true;
    const res = await patch(`/api/widget-settings/${WS_ID}/debug`, { debug_mode: true });
    expect(res.status).toBe(200);
    expect(settingsRow.debug_mode).toBe(true);
    expect(res.body.settings.debug_mode).toBe(true);
  });

  it('a platform admin can also deliberately disable it', async () => {
    isPlatformAdmin = true;
    settingsRow.debug_mode = true;
    const res = await patch(`/api/widget-settings/${WS_ID}/debug`, { debug_mode: false });
    expect(res.status).toBe(200);
    expect(settingsRow.debug_mode).toBe(false);
  });

  it('rejects a non-boolean debug_mode value', async () => {
    isPlatformAdmin = true;
    const res = await patch(`/api/widget-settings/${WS_ID}/debug`, { debug_mode: 'yes' });
    expect(res.status).toBe(400);
  });
});

describe('server config safety — no workspace-creation path or platform default can inherit debug_mode', () => {
  it('no widget_settings INSERT statement in any migration sets debug_mode — every workspace starts on the column default (false)', () => {
    const dirs = ['database/migrations', 'supabase/migrations'];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.sql')) continue;
        const sql = read(`${dir}/${file}`);
        // Find every `INSERT INTO ... widget_settings (...)` statement and
        // check its explicit column list for debug_mode. A column list
        // that never names debug_mode falls through to the table's own
        // `DEFAULT false` — which is what every workspace-creation path
        // in this repo does today (see the migrations this test scans).
        const inserts = sql.match(/INSERT INTO\s+(?:public\.)?widget_settings\s*\(([^)]*)\)/gi) || [];
        for (const stmt of inserts) {
          if (/debug_mode/i.test(stmt)) offenders.push(`${file}: ${stmt}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the visitor-facing bootstrap config only ever reads ws.debug_mode — never widget_platform_settings.default_debug_mode (no platform-wide inheritance path exists)', () => {
    const widgetRoute = read('server/routes/widget.ts');
    expect(widgetRoute).toContain('debugMode: ws.debug_mode ?? false');
    // default_debug_mode must never reach the widget bootstrap response —
    // if it starts appearing here, a future change wired the platform
    // default into every workspace's visitor console, which is exactly
    // the blast-radius regression this task guards against.
    expect(widgetRoute).not.toContain('default_debug_mode');
  });

  it('widget_platform_settings.default_debug_mode is real but genuinely unused in the request-serving path — it cannot silently affect any visitor today', () => {
    const platformMigration = read('database/migrations/044_widget_platform_settings.sql');
    expect(platformMigration).toContain('default_debug_mode boolean NOT NULL DEFAULT false');
    // The sanitized RPC every non-admin surface reads platform settings
    // through never includes it either.
    expect(platformMigration).toContain('get_widget_platform_settings()');
    const rpcBody = platformMigration.slice(
      platformMigration.indexOf('CREATE OR REPLACE FUNCTION public.get_widget_platform_settings()'),
      platformMigration.indexOf('REVOKE ALL ON FUNCTION public.get_widget_platform_settings()'),
    );
    expect(rpcBody).not.toContain('default_debug_mode');
  });
});
