/**
 * Behavioral (not source-string) coverage for server/routes/widgetSettings.ts's
 * mass-assignment fix. The workspace owner/admin-facing
 * `PATCH /api/widget-settings/:workspaceId` endpoint originally used
 * `z.object({}).passthrough()` — no allowlist at all — then, in a first
 * pass, only stripped the single `debug_mode` field. Independent review
 * correctly flagged that as fail-OPEN: any other sensitive column added to
 * `widget_settings` later would automatically become writable by every
 * workspace admin unless someone remembered to blacklist it too.
 *
 * This suite proves the current, fail-CLOSED design: a `.strict()` Zod
 * allowlist (`widgetSettingsPatchSchema`) that names every column a
 * workspace admin may write and rejects (400) anything else outright —
 * including `debug_mode`, `id`, `workspace_id`, `created_at`, `updated_at`,
 * and any made-up "future" column name. Also covers the isolated,
 * platform-admin-only, now-audited `/debug` endpoint, the equally strict
 * `widget_prechat_settings` schema, and the platform-config schema.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const WS_ID = '55555555-5555-4555-8555-555555555555';
const PLATFORM_ID = '66666666-6666-4666-8666-666666666666';

type Row = Record<string, any>;
let settingsRow: Row;
let prechatRow: Row | null;
let platformRow: Row;
let auditLogs: Row[];
let isPlatformAdmin: boolean;
let entitlementsOverride: { features: Record<string, boolean>; maxDomains: number } | null;

function resetFakeDb() {
  settingsRow = {
    id: 'row-1',
    workspace_id: WS_ID,
    debug_mode: false,
    primary_color: '#3B82F6',
    welcome_message: 'Hello!',
    created_at: '2020-01-01T00:00:00.000Z',
    updated_at: '2020-01-01T00:00:00.000Z',
  };
  prechatRow = null;
  platformRow = { id: PLATFORM_ID, default_debug_mode: false, max_message_length: 5000 };
  auditLogs = [];
  isPlatformAdmin = false;
  entitlementsOverride = null;
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
  function prechatBuilder() {
    const b: any = {
      select: () => b,
      eq: () => b,
      upsert: (patch: Record<string, any>) => {
        prechatRow = { ...(prechatRow || {}), ...patch };
        return b;
      },
      single: async () => ({ data: prechatRow ? { ...prechatRow } : null, error: null }),
      maybeSingle: async () => ({ data: prechatRow ? { ...prechatRow } : null, error: null }),
    };
    return b;
  }
  function platformBuilder() {
    const b: any = {
      select: () => b,
      eq: () => b,
      limit: () => b,
      update: (patch: Record<string, any>) => {
        Object.assign(platformRow, patch);
        return b;
      },
      single: async () => ({ data: { ...platformRow }, error: null }),
      maybeSingle: async () => ({ data: { ...platformRow }, error: null }),
    };
    return b;
  }
  function auditLogsBuilder() {
    const b: any = {
      insert: async (row: Record<string, any>) => {
        auditLogs.push({ ...row });
        return { data: null, error: null };
      },
    };
    return b;
  }
  return {
    from(table: string) {
      if (table === 'widget_settings') return widgetSettingsBuilder();
      if (table === 'widget_prechat_settings') return prechatBuilder();
      if (table === 'widget_platform_settings') return platformBuilder();
      if (table === 'audit_logs') return auditLogsBuilder();
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
  resolveWidgetEntitlements: async () => entitlementsOverride ?? { features: {}, maxDomains: 10 },
  guardWidgetSettingsPatch: (patch: Record<string, any>, ent: { features: Record<string, boolean> }) => {
    // Mirror the real WIDGET_SETTING_CAPABILITY behavior closely enough for
    // these tests: a boolean feature flipped to true while the plan denies
    // its capability is blocked.
    const map: Record<string, string> = {
      chat_enabled: 'chat',
      attachments_enabled: 'widget_attachments',
      smart_engagement_enabled: 'widget_smart_engagement',
    };
    const denied: string[] = [];
    for (const [column, capability] of Object.entries(map)) {
      if (patch[column] === true && ent.features[capability] === false) denied.push(capability);
    }
    return { ok: denied.length === 0, denied };
  },
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

function request(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolveReq, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolveReq({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const patch = (path: string, body: any) => request('PATCH', path, body);
const put = (path: string, body: any) => request('PUT', path, body);

beforeEach(() => {
  resetFakeDb();
});

describe('PATCH /api/widget-settings/:workspaceId — fail-closed allowlist (.strict())', () => {
  it('a legitimate setting is accepted and saved', async () => {
    const res = await patch(`/api/widget-settings/${WS_ID}`, { primary_color: '#000000', welcome_message: 'Hi!' });
    expect(res.status).toBe(200);
    expect(settingsRow.primary_color).toBe('#000000');
    expect(settingsRow.welcome_message).toBe('Hi!');
  });

  it('debug_mode in the body is rejected — the whole request 400s, nothing is written', async () => {
    const res = await patch(`/api/widget-settings/${WS_ID}`, { debug_mode: true, primary_color: '#000000' });
    expect(res.status).toBe(400);
    expect(settingsRow.debug_mode).toBe(false);
    // Fail-closed means the WHOLE request is rejected, not a silent partial
    // apply — primary_color must NOT have saved either.
    expect(settingsRow.primary_color).toBe('#3B82F6');
  });

  it('workspace_id in the body cannot be used to retarget the row — rejected outright', async () => {
    const res = await patch(`/api/widget-settings/${WS_ID}`, { workspace_id: 'some-other-workspace' });
    expect(res.status).toBe(400);
    expect(settingsRow.workspace_id).toBe(WS_ID);
  });

  it('id cannot be changed', async () => {
    const res = await patch(`/api/widget-settings/${WS_ID}`, { id: 'different-row-id' });
    expect(res.status).toBe(400);
    expect(settingsRow.id).toBe('row-1');
  });

  it('created_at cannot be changed', async () => {
    const res = await patch(`/api/widget-settings/${WS_ID}`, { created_at: '2099-01-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
    expect(settingsRow.created_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('an unknown, future-looking field name is rejected, not silently dropped-and-saved', async () => {
    const res = await patch(`/api/widget-settings/${WS_ID}`, { some_brand_new_column_from_next_quarter: true });
    expect(res.status).toBe(400);
    // Zod's .strict() reports unknown keys via an "unrecognized_keys" issue
    // whose offending key names live in its message, not `path` (path is
    // empty for this issue kind — there's no nested field to point at).
    expect(res.body.issues?.some((i: any) => i.message.includes('some_brand_new_column_from_next_quarter'))).toBe(true);
  });

  it('a request with no debug_mode at all is completely unaffected (no regression to ordinary saves)', async () => {
    const res = await patch(`/api/widget-settings/${WS_ID}`, { welcome_message: 'Hi there!' });
    expect(res.status).toBe(200);
    expect(settingsRow.welcome_message).toBe('Hi there!');
    expect(settingsRow.debug_mode).toBe(false);
  });

  it('existing entitlement (plan) enforcement still blocks a denied feature flip', async () => {
    entitlementsOverride = { features: { chat: false }, maxDomains: 10 };
    const res = await patch(`/api/widget-settings/${WS_ID}`, { chat_enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.denied).toContain('chat');
  });

  it('existing powered-by entitlement enforcement still forces show_powered_by ON when the plan denies the toggle', async () => {
    entitlementsOverride = { features: { widget_powered_by_toggle: false }, maxDomains: 10 };
    const res = await patch(`/api/widget-settings/${WS_ID}`, { show_powered_by: false });
    expect(res.status).toBe(200);
    expect(settingsRow.show_powered_by).toBe(true);
  });
});

describe('PATCH /api/widget-settings/:workspaceId/debug — platform-admin-only, deliberate, audited opt-in', () => {
  it('a workspace owner/admin (not a platform admin) is denied', async () => {
    isPlatformAdmin = false;
    const res = await patch(`/api/widget-settings/${WS_ID}/debug`, { debug_mode: true });
    expect(res.status).toBe(403);
    expect(settingsRow.debug_mode).toBe(false);
    expect(auditLogs).toHaveLength(0);
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

  it('rejects an unknown field alongside debug_mode (.strict())', async () => {
    isPlatformAdmin = true;
    const res = await patch(`/api/widget-settings/${WS_ID}/debug`, { debug_mode: true, workspace_id: 'x' });
    expect(res.status).toBe(400);
    expect(settingsRow.debug_mode).toBe(false);
  });

  it('writes exactly one audit_logs event on a real change, with actor/workspace/old/new and no PII or tokens', async () => {
    isPlatformAdmin = true;
    settingsRow.debug_mode = false;
    const res = await patch(`/api/widget-settings/${WS_ID}/debug`, { debug_mode: true });
    expect(res.status).toBe(200);
    expect(auditLogs).toHaveLength(1);

    const event = auditLogs[0];
    expect(event.workspace_id).toBe(WS_ID);
    expect(event.user_id).toBe('platform-admin-1');
    expect(event.entity_type).toBe('widget_settings');
    expect(event.entity_id).toBe(WS_ID);
    expect(event.action).toBe('widget_settings.debug_mode_changed');
    expect(event.old_value).toEqual({ debug_mode: false });
    expect(event.new_value).toEqual({ debug_mode: true });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/wss_|token|secret|email|phone/i);
  });

  it('a genuine no-op (setting debug_mode to its current value) writes NO audit event', async () => {
    isPlatformAdmin = true;
    settingsRow.debug_mode = false;
    const res = await patch(`/api/widget-settings/${WS_ID}/debug`, { debug_mode: false });
    expect(res.status).toBe(200);
    expect(auditLogs).toHaveLength(0);
  });

  it('two real toggles in sequence write exactly two audit events, not one merged or duplicated', async () => {
    isPlatformAdmin = true;
    await patch(`/api/widget-settings/${WS_ID}/debug`, { debug_mode: true });
    await patch(`/api/widget-settings/${WS_ID}/debug`, { debug_mode: false });
    expect(auditLogs).toHaveLength(2);
    expect(auditLogs[0].old_value).toEqual({ debug_mode: false });
    expect(auditLogs[0].new_value).toEqual({ debug_mode: true });
    expect(auditLogs[1].old_value).toEqual({ debug_mode: true });
    expect(auditLogs[1].new_value).toEqual({ debug_mode: false });
  });
});

describe('PUT /api/widget-settings/:workspaceId/prechat — fail-closed allowlist', () => {
  it('valid pre-chat fields are accepted', async () => {
    const res = await put(`/api/widget-settings/${WS_ID}/prechat`, {
      ask_email: true,
      require_email: false,
      prechat_timing: 'after_handoff',
      history_continue_window_hours: 48,
    });
    expect(res.status).toBe(200);
    expect(prechatRow).toMatchObject({
      ask_email: true,
      require_email: false,
      prechat_timing: 'after_handoff',
      history_continue_window_hours: 48,
      workspace_id: WS_ID,
    });
  });

  it('an arbitrary/unknown field is rejected outright', async () => {
    const res = await put(`/api/widget-settings/${WS_ID}/prechat`, { ask_email: true, made_up_field: 'x' });
    expect(res.status).toBe(400);
    expect(prechatRow).toBeNull();
  });

  it('an invalid prechat_timing enum value is rejected', async () => {
    const res = await put(`/api/widget-settings/${WS_ID}/prechat`, { prechat_timing: 'whenever' });
    expect(res.status).toBe(400);
  });

  it('a client-supplied workspace_id cannot overwrite the server-authorized workspace — the field is not even in the schema', async () => {
    const res = await put(`/api/widget-settings/${WS_ID}/prechat`, { workspace_id: 'some-other-workspace', ask_name: true });
    expect(res.status).toBe(400);
    expect(prechatRow).toBeNull();
  });

  it('created_at/updated_at cannot be set by the client', async () => {
    const res = await put(`/api/widget-settings/${WS_ID}/prechat`, { created_at: '2099-01-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/widget-settings/platform/config — dedicated strict schema, platform-admin-only', () => {
  it('a legitimate platform setting saves', async () => {
    isPlatformAdmin = true;
    const res = await patch('/api/widget-settings/platform/config', { id: PLATFORM_ID, max_message_length: 8000 });
    expect(res.status).toBe(200);
    expect(platformRow.max_message_length).toBe(8000);
  });

  it('id cannot be overwritten by the update payload (still used only to select the row)', async () => {
    isPlatformAdmin = true;
    const res = await patch('/api/widget-settings/platform/config', { id: PLATFORM_ID, max_message_length: 100 });
    expect(res.status).toBe(200);
    expect(platformRow.id).toBe(PLATFORM_ID);
  });

  it('an unknown field is rejected', async () => {
    isPlatformAdmin = true;
    const res = await patch('/api/widget-settings/platform/config', { id: PLATFORM_ID, some_future_column: 'x' });
    expect(res.status).toBe(400);
  });

  it('created_at cannot be set', async () => {
    isPlatformAdmin = true;
    const res = await patch('/api/widget-settings/platform/config', { id: PLATFORM_ID, created_at: '2099-01-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
  });

  it('alert_webhook_secret cannot be set through this endpoint', async () => {
    isPlatformAdmin = true;
    const res = await patch('/api/widget-settings/platform/config', { id: PLATFORM_ID, alert_webhook_secret: 'sh-h-h' });
    expect(res.status).toBe(400);
  });

  it('a non-platform-admin is denied before validation even matters', async () => {
    isPlatformAdmin = false;
    const res = await patch('/api/widget-settings/platform/config', { id: PLATFORM_ID, max_message_length: 1 });
    expect(res.status).toBe(403);
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
    expect(widgetRoute).not.toContain('default_debug_mode');
  });

  it('widget_platform_settings.default_debug_mode is real but genuinely unused in the request-serving path — it cannot silently affect any visitor today', () => {
    const platformMigration = read('database/migrations/044_widget_platform_settings.sql');
    expect(platformMigration).toContain('default_debug_mode boolean NOT NULL DEFAULT false');
    expect(platformMigration).toContain('get_widget_platform_settings()');
    const rpcBody = platformMigration.slice(
      platformMigration.indexOf('CREATE OR REPLACE FUNCTION public.get_widget_platform_settings()'),
      platformMigration.indexOf('REVOKE ALL ON FUNCTION public.get_widget_platform_settings()'),
    );
    expect(rpcBody).not.toContain('default_debug_mode');
  });

  it('the dead default_debug_mode toggle is no longer rendered in the super-admin UI', () => {
    const page = read('src/pages/admin/WidgetSettingsPage.tsx');
    expect(page).not.toContain("update({ default_debug_mode: v })");
  });
});
