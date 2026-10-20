/**
 * PUT/GET /api/call-center/settings and the call widget design's settings
 * (S10, migration 277), with the rolling-deploy rules of the contract (§5.1):
 * the launcher style is one of the nine; a placement is stored canonical
 * (its older spellings and anything else accepted); the callback hours are
 * `{}` or the strict business-hours shape, or exactly what is stored (an old
 * dashboard resends it untouched); turning slots on needs hours that pass the
 * strict shape; a database without 277 answers 503 migration_pending, never
 * 500; GET sends the 277 settings only when the row has them, so a new
 * dashboard sends them back only to a backend that can store them.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startTestServer } from './callWidgetHttp';

const WS = '55555555-5555-4555-8555-555555555555';
const DESIGN_COLUMNS = ['launcher_style', 'callback_slots_enabled', 'callback_slot_minutes', 'callback_days_ahead', 'callback_slot_capacity'];
const HOURS = { enabled: true, timezone: 'Asia/Tehran', weekly: { sat: [{ from: '09:00', to: '17:00' }], mon: [], tue: [{ from: '09:00', to: '12:00' }, { from: '14:00', to: '18:00' }] }, overrides: [{ date: '2026-10-22', closed: true, label: 'Holiday' }] };

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  /** Migration 277 applied? Without it, a write naming one of its columns fails like PostgREST / the direct driver. */
  has277: true,
  missingCode: 'PGRST204' as 'PGRST204' | '42703',
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is', 'insert', 'update']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.single = async () => ({ data: null, error: null });
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return b;
    },
    rpc: async (fn: string) => ({ data: fn === 'get_workspace_role' ? 'owner' : null, error: null }),
  }),
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: true, role: 'owner' }),
  requirePlatformAdmin: async () => ({ userId: 'u1' }),
}));
vi.mock('../../../server/services/callCenter/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/callCenter/settings.js')>();
  return {
    ...actual,
    getOrCreateWorkspaceSettings: async () => ({ ...state.row }),
    updateWorkspaceSettings: async (_c: unknown, _w: string, patch: Row) => {
      const missing = state.has277 ? undefined : Object.keys(patch).find((k) => DESIGN_COLUMNS.includes(k));
      if (missing) {
        throw state.missingCode === 'PGRST204'
          ? { code: 'PGRST204', message: `Could not find the '${missing}' column of 'call_center_settings' in the schema cache`, details: null, hint: null }
          : { code: '42703', message: `column "${missing}" of relation "call_center_settings" does not exist` };
      }
      state.updates.push({ ...patch });
      Object.assign(state.row, patch);
      return { ...state.row };
    },
    getPlatformCallCenterSettings: async () => ({ call_center_enabled: true }),
    computeEffectiveCallCenterCaps: () => ({}),
  };
});
vi.mock('../../../server/services/callCenter/recording.js', () => ({
  computeRecordingCapability: async () => ({ enabled: false }),
  disabledRecordingCapability: () => ({ enabled: false }),
}));
vi.mock('../../../server/services/callCenter/departments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/callCenter/departments.js')>()),
  updateMyAgentPresence: async (_c: unknown, workspaceId: string, userId: string, status: string) => ({ workspace_id: workspaceId, user_id: userId, status }),
}));
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformEditionOrNull: async () => 'iran',
}));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => true }));

const { callCenterRouter } = await import('../../../server/routes/callCenter.js');
const { onInvalidate } = await import('../../../server/lib/cacheBus.js');
const server = startTestServer('/api/call-center', callCenterRouter, { supabaseUrl: 'x', supabaseServiceRoleKey: 'z' }, { authUserId: 'u1' });
afterAll(() => { server.close(); });

type SettingsBody = { settings?: Row; error?: string; details?: { fieldErrors?: Record<string, string[]> } };
const put = (body: Row) => server.put<SettingsBody>(`/api/call-center/settings?workspaceId=${WS}`, body);
const get = () => server.get<SettingsBody>(`/api/call-center/settings?workspaceId=${WS}`);

/** A row as stored before 277 (an old database), and the same with 277's defaults. */
function oldRow(): Row {
  return {
    id: 'cc-1', workspace_id: WS, enabled: true, public_key: 'cck_x', display_name: 'Support', widget_position: 'bottom-right',
    widget_template_id: 'default', widget_theme: {}, pre_call_form_schema: [], offline_behavior: 'show_callback',
    business_hours: { legacy: true, note: 'free text from the API', days: ['sat', 'sun'] }, avatar_url: null, avatar_storage_path: null,
  };
}
const row277 = (): Row => ({ ...oldRow(), launcher_style: 'round_label', callback_slots_enabled: false, callback_slot_minutes: 30, callback_days_ahead: 4, callback_slot_capacity: null });

beforeEach(() => {
  state.row = row277();
  state.has277 = true;
  state.missingCode = 'PGRST204';
  state.updates = [];
});

describe('PUT settings: launcher style and placement', () => {
  it('stores one of the nine styles and refuses any other', async () => {
    expect((await put({ launcher_style: 'card' })).status).toBe(200);
    expect(state.row.launcher_style).toBe('card');
    const bad = await put({ launcher_style: 'hologram' });
    expect(bad.status).toBe(400);
    expect(bad.body.details?.fieldErrors).toHaveProperty('launcher_style');
    expect(state.row.launcher_style).toBe('card');
  });

  it('stores a placement canonical: older spellings mapped, anything else right', async () => {
    for (const [sent, stored] of [['bottom-left', 'left'], ['top-right', 'top_right'], ['center', 'bottom_center'], ['top_left', 'top_left'], ['middle', 'right'], ['bottom-right', 'right']]) {
      const res = await put({ widget_position: sent });
      expect(res.status, sent).toBe(200);
      expect(state.row.widget_position, sent).toBe(stored);
    }
  });
});

describe('PUT settings: callback hours and slots', () => {
  it('accepts {} and the strict business-hours shape', async () => {
    expect((await put({ business_hours: {} })).status).toBe(200);
    expect(state.row.business_hours).toEqual({});
    expect((await put({ business_hours: HOURS })).status).toBe(200);
    expect(state.row.business_hours).toEqual(HOURS);
  });

  it('refuses hours that fail the strict shape', async () => {
    const cases: Row[] = [
      { weekly: { mon: [{ from: '9am', to: '5pm' }] } },
      { weekly: { mon: [{ from: '24:00', to: '25:00' }] } },
      { weekly: { funday: [] } },
      { timezone: 'Mars/Olympus', weekly: {} },
      { weekly: { mon: Array.from({ length: 7 }, () => ({ from: '09:00', to: '10:00' })) } },
      { weekly: {}, overrides: Array.from({ length: 61 }, () => ({ date: '2026-10-22', closed: true })) },
      { weekly: {}, extra: 1 },
      { legacy: true },
    ];
    for (const hours of cases) {
      const res = await put({ business_hours: hours });
      expect(res.status, JSON.stringify(hours)).toBe(400);
      expect(res.body.details?.fieldErrors).toHaveProperty('business_hours');
    }
    expect(state.updates).toEqual([]);
  });

  it('accepts the stored legacy hours resent unchanged (an old dashboard), without rewriting them', async () => {
    const stored = state.row.business_hours as Row;
    // Same value, keys in another order (jsonb does not keep key order).
    const resent = { days: ['sat', 'sun'], note: 'free text from the API', legacy: true };
    const res = await put({ display_name: 'Support team', business_hours: resent });
    expect(res.status).toBe(200);
    expect(state.updates).toEqual([{ display_name: 'Support team' }]);
    expect(state.row.business_hours).toEqual(stored);
  });

  it('turning slots on needs hours that pass the strict shape', async () => {
    const bad = await put({ callback_slots_enabled: true });
    expect(bad.status).toBe(400);
    expect(bad.body.details?.fieldErrors).toHaveProperty('business_hours');
    expect(state.row.callback_slots_enabled).toBe(false);
    const good = await put({ callback_slots_enabled: true, business_hours: HOURS, callback_slot_minutes: 45, callback_days_ahead: 7, callback_slot_capacity: 3 });
    expect(good.status).toBe(200);
    expect(state.row).toMatchObject({ callback_slots_enabled: true, callback_slot_minutes: 45, callback_days_ahead: 7, callback_slot_capacity: 3 });
    // Already on with good hours: other saves go through.
    expect((await put({ callback_slots_enabled: true, display_name: 'X' })).status).toBe(200);
    expect((await put({ callback_slot_capacity: null })).status).toBe(200);
    expect(state.row.callback_slot_capacity).toBeNull();
  });

  it('keeps the slot settings in range', async () => {
    for (const patch of [{ callback_slot_minutes: 5 }, { callback_slot_minutes: 241 }, { callback_slot_minutes: 30.5 }, { callback_days_ahead: 0 }, { callback_days_ahead: 15 }, { callback_slot_capacity: 0 }, { callback_slot_capacity: 101 }, { callback_slots_enabled: 'yes' }]) {
      expect((await put(patch)).status, JSON.stringify(patch)).toBe(400);
    }
  });
});

describe('PUT settings: rolling deploy', () => {
  it('a database without 277: a save naming one of its settings answers 503 migration_pending, others save', async () => {
    state.row = oldRow();
    state.has277 = false;
    for (const code of ['PGRST204', '42703'] as const) {
      state.missingCode = code;
      const res = await put({ launcher_style: 'pill' });
      expect(res.status, code).toBe(503);
      expect(res.body).toEqual({ error: 'migration_pending' });
    }
    expect((await put({ display_name: 'Still works', widget_position: 'left' })).status).toBe(200);
    expect(state.row).toMatchObject({ display_name: 'Still works', widget_position: 'left' });
  });

  it('an old dashboard\'s whole save (as its save() sends it) goes through', async () => {
    state.row = oldRow();
    state.has277 = false;
    const res = await put({
      enabled: true, allowed_domains: ['shop.example'], widget_position: 'bottom-right', widget_template_id: 'default', widget_theme: {},
      display_name: 'Support', voice_enabled: true, video_enabled: true, callback_enabled: true, pre_call_form_enabled: false,
      pre_call_form_schema: [], business_hours: { ...(oldRow().business_hours as Row) }, offline_behavior: 'show_callback',
      recording_enabled: false, recording_consent_required: false, operator_video_visible_to_visitor: true, routing_mode: 'broadcast',
      default_department_id: null, widget_default_locale: null, widget_enabled_locales: null, widget_custom_texts: null,
    });
    expect(res.status).toBe(200);
    expect(state.row.widget_position).toBe('right');
  });
});

describe('GET settings', () => {
  it('normalises the placement and the style', async () => {
    state.row = { ...row277(), widget_position: 'bottom-left', launcher_style: 'hologram' };
    const { body } = await get();
    expect(body.settings).toMatchObject({ widget_position: 'left', launcher_style: 'round_label' });
  });

  it('sends the 277 settings only when the row has them', async () => {
    state.row = oldRow();
    const { body } = await get();
    for (const key of DESIGN_COLUMNS) expect(body.settings, key).not.toHaveProperty(key);
    expect(body.settings?.widget_position).toBe('right');
    state.row = row277();
    const again = await get();
    for (const key of DESIGN_COLUMNS) expect(again.body.settings, key).toHaveProperty(key);
  });
});

describe('PUT /agents/me/presence', () => {
  it('drops the public presence on every process (callpresence:<ws>)', async () => {
    const seen: Array<string | null> = [];
    const off = onInvalidate('callpresence', (key) => { seen.push(key); });
    const res = await server.put(`/api/call-center/agents/me/presence?workspaceId=${WS}`, { status: 'away' });
    off();
    expect(res.status).toBe(200);
    expect(seen).toEqual([WS]);
  });
});

describe('no code path inserts a call_center_settings row naming a 277 column', () => {
  it('every insert/upsert into call_center_settings in server/ leaves them to the database defaults', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== 'dist') walk(p); }
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) files.push(p);
      }
    };
    walk(resolve(process.cwd(), 'server'));
    let inserts = 0;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const re = /from\(\s*['"]call_center_settings['"]\s*\)\s*\.(?:insert|upsert)\(([\s\S]*?)\)\s*[.;]/g;
      for (const m of src.matchAll(re)) {
        inserts++;
        for (const col of DESIGN_COLUMNS) expect(m[1], `${file}: ${col}`).not.toContain(col);
      }
    }
    expect(inserts).toBeGreaterThan(0);
  });
});
