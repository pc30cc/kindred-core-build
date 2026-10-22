/**
 * An in-memory stand-in for the supabase-js query builder, for the widget
 * config tests: enough of the API (select / eq / in / is / gt / order /
 * limit / maybeSingle / single / rpc) for the bootstrap, config and snapshot
 * paths, and a counter of every `from()` and `rpc()` call so a test can
 * prove how many database operations a request issued.
 *
 * Writes are accepted and ignored. Unknown builder methods return the builder
 * (a filter this fake does not model simply does not filter).
 */
export type Row = Record<string, unknown>;

export interface FakeDbOptions {
  /** rpc(fn, args) → result. Default: `{ data: null, error: null }`. */
  rpc?: (fn: string, args: Record<string, unknown> | undefined) => { data: unknown; error: unknown };
  /** Tables whose reads answer with an error (to exercise degraded paths). */
  failingTables?: Set<string>;
}

export interface FakeDb {
  client: { from(table: string): unknown; rpc(fn: string, args?: Record<string, unknown>): unknown };
  tables: Record<string, Row[]>;
  calls: { from: number; rpc: number; log: string[] };
  resetCalls(): void;
  options: FakeDbOptions;
}

function project(row: Row, columns: string): Row {
  const cols = columns.split(',').map((c) => c.trim()).filter(Boolean);
  if (!cols.length || cols.includes('*')) return { ...row };
  const out: Row = {};
  for (const col of cols) {
    if (col.includes('(')) continue; // embedded resources are not modelled
    const name = col.includes(':') ? col.split(':')[1].trim() : col;
    const alias = col.includes(':') ? col.split(':')[0].trim() : col;
    if (name in row) out[alias] = row[name];
  }
  return out;
}

export function createFakeDb(tables: Record<string, Row[]>, options: FakeDbOptions = {}): FakeDb {
  const calls = { from: 0, rpc: 0, log: [] as string[] };

  function builder(table: string) {
    let columns = '*';
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    let mode: 'many' | 'maybe' | 'single' = 'many';
    let write = false;

    function run(): { data: unknown; error: unknown } {
      if (options.failingTables?.has(table)) {
        return { data: null, error: { message: `fake failure on ${table}`, code: 'XX000' } };
      }
      if (write) return { data: null, error: null };
      let rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => {
          const x = a[col] as number | string;
          const y = b[col] as number | string;
          if (x === y) return 0;
          return (x > y ? 1 : -1) * (asc ? 1 : -1);
        });
      }
      if (limit !== null) rows = rows.slice(0, limit);
      const projected = rows.map((r) => project(r, columns));
      if (mode === 'many') return { data: projected, error: null };
      if (projected.length > 1) return { data: null, error: { message: 'multiple rows', code: 'PGRST116' } };
      if (!projected.length) {
        return mode === 'single'
          ? { data: null, error: { message: 'no rows', code: 'PGRST116' } }
          : { data: null, error: null };
      }
      return { data: projected[0], error: null };
    }

    const api: Record<string, unknown> = {
      select(cols?: string) { if (!write) columns = cols || '*'; return proxy; },
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: unknown) { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return proxy; },
      is(col: string, val: unknown) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      gt(col: string, val: number) { filters.push((r) => Number(r[col]) > val); return proxy; },
      order(col: string, opts?: { ascending?: boolean }) { orderBy = { col, asc: opts?.ascending !== false }; return proxy; },
      limit(n: number) { limit = n; return proxy; },
      maybeSingle() { mode = 'maybe'; return Promise.resolve(run()); },
      single() { mode = 'single'; return Promise.resolve(run()); },
      insert() { write = true; return proxy; },
      update() { write = true; return proxy; },
      upsert() { write = true; return proxy; },
      delete() { write = true; return proxy; },
      then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(ok, err);
      },
    };
    const proxy: unknown = new Proxy(api, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        if (typeof prop === 'symbol') return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  const client = {
    from(table: string) {
      calls.from += 1;
      calls.log.push(`from:${table}`);
      return builder(table);
    },
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.rpc += 1;
      calls.log.push(`rpc:${fn}`);
      const result = options.rpc ? options.rpc(fn, args) : { data: null, error: null };
      const p = Promise.resolve(result) as Promise<unknown> & { range?: () => unknown };
      p.range = () => p;
      return p;
    },
  };

  return {
    client,
    tables,
    calls,
    options,
    resetCalls() {
      calls.from = 0;
      calls.rpc = 0;
      calls.log = [];
    },
  };
}

/** Entitlement RPC answers: everything allowed, numeric limits unlimited. */
export function allowAllRpc(fn: string, args: Record<string, unknown> | undefined): { data: unknown; error: unknown } {
  if (fn === 'check_workspace_entitlement') {
    const feature = String(args?._feature || '');
    if (feature.startsWith('max_')) return { data: { allowed: true, plan: 'pro', limit: -1 }, error: null };
    return { data: { allowed: true, plan: 'pro' }, error: null };
  }
  if (fn === 'check_module_access') return { data: { allowed: true, plan: 'pro' }, error: null };
  if (fn === 'billing_locks_enabled') return { data: false, error: null };
  return { data: null, error: null };
}

export const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
export const USER_A = '1a2b3c4d-0000-4000-8000-00000000000a';
export const USER_B = '1a2b3c4d-0000-4000-8000-00000000000b';
export const SHOP_ORIGIN = 'https://shop.example';

export interface ScenarioOptions {
  edition: 'iran' | 'international';
  ai: boolean;
  smart: boolean;
  /** widget_settings.locale / widget_language */
  locale?: string;
}

/** A realistic workspace: two members, avatars, a logo, a launcher image, rules. */
export function widgetScenarioTables(opts: ScenarioOptions): Record<string, Row[]> {
  const locale = opts.locale ?? (opts.edition === 'iran' ? 'fa' : 'tr');
  return {
    workspaces: [{ id: WS, name: 'Acme Store' }],
    widget_settings: [{
      workspace_id: WS,
      enabled: true,
      allowed_domains: ['shop.example'],
      allow_subdomains: false,
      primary_color: '#112233',
      secondary_color: null,
      welcome_message: 'Hello! How can we help you?',
      launcher_text: 'Chat with us',
      reply_time_text: null,
      brand_name: null,
      locale,
      widget_language: 'auto',
      position: 'bottom-left',
      theme: 'modern',
      fab_icon: 'chat',
      fab_image_storage_key: `workspace/${WS}/widget/fab.png`,
      fab_image_url: null,
      smart_engagement_enabled: opts.smart,
      attachments_enabled: true,
      attachments_max_size_mb: 40,
      attachments_allowed_mimes: [],
      voice_notes_enabled: true,
      show_powered_by: !opts.smart,
      debug_mode: false,
      business_hours: {
        enabled: true,
        timezone: 'Asia/Tehran',
        weekly: { sat: [{ from: '09:00', to: '17:00' }], sun: [{ from: '09:00', to: '17:00' }], tue: [{ from: '09:00', to: '17:00' }], wed: [{ from: '09:00', to: '17:00' }] },
        overrides: [],
      },
      offline_mode: 'accept_messages',
      availability_labels: { en: { online: 'Here', offline: 'Away' } },
      offline_message: 'Leave a message',
      offline_message_localized: { fa: 'پیام بگذارید' },
      live_chat_enabled: true,
      store_raw_ip: false,
    }],
    workspace_branding: [{ workspace_id: WS, logo_url: null, logo_storage_key: `workspace/${WS}/branding/logo.png`, primary_color: '#445566' }],
    widget_platform_settings: [{
      id: 'wps-1',
      widget_loader_base_url: 'https://app.test',
      widget_asset_base_url: 'https://app.test',
      widget_public_base_url: 'https://app.test',
      widget_api_base_url: 'https://api.test',
      default_welcome_message: 'Welcome!',
      powered_by_enabled: true,
      powered_by_text: 'Powered by',
      powered_by_brand_text: null,
      powered_by_url: 'https://brand.example',
      prechat_name_policy: 'default_on',
      prechat_email_policy: 'force_on',
      prechat_phone_policy: 'default_off',
    }],
    platform_branding_localized: [
      { locale: 'en', platform_name: 'WebYar' },
      { locale: 'fa', platform_name: 'وبیار' },
      { locale: 'tr', platform_name: 'WebYar TR' },
    ],
    platform_settings: [{ region_mode: opts.edition === 'iran' ? 'iran' : 'multi', active_locales: ['en', 'tr', 'fa'] }],
    workspace_subscriptions: [{ workspace_id: WS, plan_id: 'plan-pro', status: 'active', trial_end: null, free_fallback_at: null, cancel_at_period_end: false, current_period_end: '2099-01-01T00:00:00Z' }],
    billing_plans: [
      { id: 'plan-pro', slug: 'pro', entitlements: { widget_powered_by: true } },
      { id: 'plan-free', slug: 'free', entitlements: {} },
    ],
    feature_flags: [{ workspace_id: WS, key: 'widget_prechat_phone', enabled: true }],
    workspace_members: [{ workspace_id: WS, user_id: USER_A, role: 'owner' }, { workspace_id: WS, user_id: USER_B, role: 'agent' }],
    user_availability_prefs: [
      { user_id: USER_A, workspace_id: null, force_offline: false, available_when_using_app: true, schedule_enabled: false, timezone: 'UTC', weekly_schedule: null },
      { user_id: USER_B, workspace_id: null, force_offline: true, available_when_using_app: true, schedule_enabled: false, timezone: 'UTC', weekly_schedule: null },
    ],
    profiles: [
      { id: USER_A, full_name: 'Sara', avatar_storage_key: `users/${USER_A}/avatar/a.png` },
      { id: USER_B, full_name: null, avatar_storage_key: null },
    ],
    ai_agent_settings: opts.ai
      ? [{
          workspace_id: WS,
          enabled: true,
          mode: 'auto_reply_always',
          ai_intro_enabled: true,
          agent_name: 'Ava',
          agent_logo_url: null,
          metadata: { ai_avatar_storage_key: `workspace/${WS}/ai-agent/avatar.png` },
          handoff_prechat_message_localized: { en: 'Leave your details' },
        }]
      : [],
    platform_ai_agent_settings: [{ singleton_key: true, ai_agent_enabled: opts.ai, disabled_message: opts.ai ? null : 'AI is off', ai_proactive_nudge_enabled: opts.ai }],
    widget_ai_nudge_settings: [{ workspace_id: WS, enabled: true, mode: 'balanced' }],
    widget_smart_rules: [
      {
        id: 'rule-live', workspace_id: WS, status: 'active', priority: 5, schema_version: 1, published_version: 2,
        published_trigger_config: { type: 'time_on_page', seconds: 5 },
        published_audience_config: {},
        published_content_config: { default_locale: 'en', locales: { en: { title: '<b>Hi</b>', body: 'Need help?', cta_label: 'Chat' } } },
        published_presentation_config: { mode: 'bubble', action: 'open_chat', url: 'javascript:alert(1)' },
        published_schedule_config: { end_at: '2099-01-01T00:00:00Z' },
        published_frequency_config: null,
        published_behavior_config: null,
        published_priority: 5, published_schema_version: 1, published_at: '2026-10-01T00:00:00Z',
      },
      {
        id: 'rule-expired', workspace_id: WS, status: 'active', priority: 3, schema_version: 1, published_version: 1,
        published_trigger_config: { type: 'exit_intent' },
        published_audience_config: {},
        published_content_config: { default_locale: 'en', locales: { en: { title: 'Old', body: 'Expired', cta_label: '' } } },
        published_presentation_config: { mode: 'bubble' },
        published_schedule_config: { end_at: '2026-10-14T09:59:00Z' },
        published_frequency_config: null,
        published_behavior_config: null,
        published_priority: 3, published_schema_version: 1, published_at: '2026-09-01T00:00:00Z',
      },
    ],
    app_runtime_config: [
      { key: 'default_storage_provider', value: { provider_name: 'local', config: { public_url: 'https://cdn.test' } } },
      { key: 'default_ai_provider', value: { provider: 'openai', api_key: 'sk-test', model: 'gpt-4o-mini' } },
    ],
    provider_configs: [],
    workspace_provider_settings: [],
    workspace_module_overrides: [],
    workspace_domains: [],
    realtime_failover_state: [],
  };
}
