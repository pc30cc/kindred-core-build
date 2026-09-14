/**
 * Operator + platform-admin widget configuration routes.
 *
 * Replaces direct browser `supabase.from('widget_settings' | 'widget_prechat_settings'
 * | 'widget_platform_settings')` calls, which relied on RLS evaluating
 * `auth.uid()` against a Supabase Auth JWT the browser no longer holds
 * (first-party auth uses the `gs_session` cookie instead). Authorization here
 * mirrors the RLS policies being replaced exactly, including the
 * `workspace_owner_phone_verified` gate on workspace-level writes
 * (supabase/migrations/20260801214300_...sql).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess, requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { assertPhoneVerificationSatisfied } from '../services/phoneVerification/index.js';
import { PhoneVerificationError } from '../services/phoneVerification/types.js';
import { invalidateWorkspaceOriginCache } from '../services/widget/public.js';
import {
  resolveWidgetEntitlements,
  guardWidgetSettingsPatch,
} from '../services/widget/entitlements.js';


export const widgetSettingsRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

async function requireManageWithPhoneVerified(
  req: any,
  res: any,
  workspaceId: string,
): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return null;
  try {
    await assertPhoneVerificationSatisfied(serverConfigOf(req), {
      actorUserId: auth.userId,
      purpose: 'widget_access',
      workspaceId,
    });
  } catch (err) {
    if (err instanceof PhoneVerificationError) {
      res.status(err.status).json({ error: err.code });
      return null;
    }
    throw err;
  }
  return { userId: auth.userId };
}

// ── widget_settings (per workspace) ───────────────────────────────

widgetSettingsRouter.get('/:workspaceId', async (req, res) => {
  const config = serverConfigOf(req);
  // Widget configuration is an owner/admin surface: operators are denied at
  // the API layer, not only in the sidebar/route guards.
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('widget_settings')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});

/**
 * Explicit allowlist of columns a workspace owner/admin may write on their
 * own `widget_settings` row via this generic PATCH — fail-closed by
 * construction (`.strict()`): any key not named here, including one added
 * to the table by a future migration, is REJECTED (400), never silently
 * dropped or passed through. This replaces a prior `z.object({}).passthrough()`
 * that accepted and wrote whatever columns a request body named — the
 * mass-assignment hole that let `debug_mode` (which makes the widget
 * verbose for every visitor) reach a production workspace with no
 * dedicated UI and no audit trail.
 *
 * Every field below is verified against the ACTUAL current caller
 * (src/pages/app/WidgetPage.tsx's `setField`/`handleToggle`/domain-list/
 * business-hours writers, cross-checked against server/services/widget/
 * entitlements.ts's own WIDGET_SETTING_CAPABILITY /
 * WIDGET_CUSTOMIZATION_CAPABILITY maps) — not guessed. A field the UI does
 * not currently write (e.g. `launcher_text`, `theme`, `secondary_color`,
 * `greeting_message`, the `fab_*` styling columns beyond label/scale/icon/
 * image, `read_receipts_enabled`, `mobile_behavior`) is deliberately left
 * OUT: adding real UI for one of those later means deliberately adding it
 * here too, which is the point.
 *
 * Explicitly and permanently excluded, whatever the UI ever does: `id`,
 * `workspace_id`, `created_at`, `updated_at` (identity/ownership/managed by
 * the server), `debug_mode` (platform-support only — see the dedicated
 * `/debug` endpoint below), `round_robin_cursor_user_id` (server-internal
 * routing state), and any platform-owned URL/config column (those live on
 * `widget_platform_settings`, a different table this router already keeps
 * separate).
 */
const widgetSettingsPatchSchema = z.object({
  // Appearance
  primary_color: z.string().max(32).optional(),
  brand_name: z.string().max(200).nullable().optional(),
  reply_time_text: z.string().max(500).nullable().optional(),
  welcome_message: z.string().max(2000).nullable().optional(),
  placeholder_text: z.string().max(500).nullable().optional(),
  position: z.enum(['bottom-right', 'bottom-left']).optional(),
  locale: z.string().max(16).optional(),
  show_logo: z.boolean().optional(),
  show_team_avatars: z.boolean().optional(),
  show_powered_by: z.boolean().optional(),
  // Launcher (FAB)
  fab_label: z.string().max(100).nullable().optional(),
  fab_scale: z.number().min(50).max(300).optional(),
  fab_icon: z.string().max(50).nullable().optional(),
  fab_image_url: z.string().max(2000).nullable().optional(),
  // Master + per-feature toggles
  enabled: z.boolean().optional(),
  chat_enabled: z.boolean().optional(),
  kb_enabled: z.boolean().optional(),
  visitor_tracking_enabled: z.boolean().optional(),
  attachments_enabled: z.boolean().optional(),
  voice_notes_enabled: z.boolean().optional(),
  emoji_enabled: z.boolean().optional(),
  live_chat_enabled: z.boolean().optional(),
  smart_engagement_enabled: z.boolean().optional(),
  store_raw_ip: z.boolean().optional(),
  // Domains
  allowed_domains: z.array(z.string().max(255)).max(1000).optional(),
  allow_subdomains: z.boolean().optional(),
  // Assignment / availability
  assignment_mode: z.enum(['auto', 'round_robin', 'manual']).optional(),
  offline_mode: z.enum(['hide_widget', 'show_offline_message', 'capture_message']).optional(),
  offline_message_localized: z.record(z.string(), z.string()).nullable().optional(),
  availability_labels: z.record(z.string(), z.record(z.string(), z.string())).nullable().optional(),
  business_hours: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

widgetSettingsRouter.patch('/:workspaceId', async (req, res) => {
  const config = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  const parsed = widgetSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid input',
      // Zod names exactly which key(s) were rejected (unknown, wrong type,
      // out of range) — surfaced so a legitimate caller can see what to fix,
      // without ever echoing the rejected VALUE back.
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const auth = await requireManageWithPhoneVerified(req, res, workspaceId);
  if (!auth) return;

  // Plan enforcement — never let the operator UI (or a crafted request) turn
  // on a widget behaviour the workspace plan does not grant, or exceed the
  // embed-domain cap.
  const entitlements = await resolveWidgetEntitlements(config, workspaceId);
  const guard = guardWidgetSettingsPatch(parsed.data as Record<string, any>, entitlements);
  if (!guard.ok) {
    return res.status(403).json({
      error: 'plan_upgrade_required',
      denied: guard.denied,
      maxWidgetDomains: entitlements.maxDomains,
    });
  }

  // The powered-by footer may only be switched OFF by the workspace when the
  // plan grants that right; otherwise it stays forced ON.
  const patch = { ...(parsed.data as Record<string, any>) };
  if ('show_powered_by' in patch && entitlements.features.widget_powered_by_toggle !== true) {
    patch.show_powered_by = true;
  }

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('widget_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Embed allow-list / subdomain policy is read on every widget request from
  // a short-lived cache — drop it now so the change is live immediately
  // instead of after the TTL.
  invalidateWorkspaceOriginCache(workspaceId);
  return res.json({ settings: data });
});

// ── widget_settings.debug_mode (per workspace, platform-admin only) ──
// Deliberately isolated from the generic PATCH above — see the comment
// there. Flips widget diagnostics on/off for EVERY visitor of this
// workspace; a platform-support tool for actively troubleshooting one
// customer, gated the same way as the platform-wide settings further
// below (requirePlatformAdmin), never the workspace's own `manage` check.
// Kept as its own tiny endpoint/schema rather than folded into the
// generic one so it can never be set as a side effect of an unrelated
// settings save.
const widgetDebugModeSchema = z.object({ debug_mode: z.boolean() }).strict();

widgetSettingsRouter.patch('/:workspaceId/debug', async (req, res) => {
  const config = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  const parsed = widgetDebugModeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input — expects { debug_mode: boolean }' });
  const actorUserId = await requirePlatformAdmin(req, res);
  if (!actorUserId) return;
  const sb = getServiceClient(config);

  // Read the current value first — the audit event below needs old AND new,
  // and this also lets us skip both the write and the audit row when the
  // request is a genuine no-op (already at the requested value).
  const { data: before, error: beforeErr } = await sb
    .from('widget_settings')
    .select('debug_mode')
    .eq('workspace_id', workspaceId)
    .single();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });

  const oldValue = !!before?.debug_mode;
  const newValue = parsed.data.debug_mode;

  const { data, error } = await sb
    .from('widget_settings')
    .update({ debug_mode: newValue, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .select('workspace_id, debug_mode')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  if (oldValue !== newValue) {
    // Durable audit trail — reuses the existing audit_logs table (the SAME
    // one server/routes/adminManagement.ts's audit viewer already reads),
    // not a second audit subsystem. This field flips widget diagnostics on
    // for every visitor of the workspace, so who changed it and when is a
    // compliance-relevant fact worth its own row, not just an updated_at
    // bump on widget_settings. No token, session, or visitor PII is ever
    // in scope here — old_value/new_value are strictly {debug_mode: boolean}.
    try {
      await sb.from('audit_logs').insert({
        workspace_id: workspaceId,
        user_id: actorUserId,
        entity_type: 'widget_settings',
        entity_id: workspaceId,
        action: 'widget_settings.debug_mode_changed',
        old_value: { debug_mode: oldValue },
        new_value: { debug_mode: newValue },
      });
    } catch (auditErr: any) {
      // Best-effort, matches every other audit writer in this codebase
      // (see server/services/privacy/audit.ts) — a logging failure must
      // never fail the actual setting change.
      console.warn('[widget-settings-debug] audit_logs insert failed:', auditErr?.message || auditErr);
    }
  }

  return res.json({ settings: data });
});

// ── widget_prechat_settings (per workspace) ───────────────────────

widgetSettingsRouter.get('/:workspaceId/prechat', async (req, res) => {
  const config = serverConfigOf(req);
  // Widget configuration is an owner/admin surface: operators are denied at
  // the API layer, not only in the sidebar/route guards.
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('widget_prechat_settings')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});

/**
 * Explicit allowlist for `widget_prechat_settings` — same fail-closed
 * `.strict()` principle as the generic widget_settings PATCH above, derived
 * from the real caller (src/hooks/useWidgetIdentity.ts's
 * `WidgetPrechatSettings` type, as actually sent by
 * src/components/app/widget/PrechatSection.tsx). `workspace_id` is
 * deliberately NOT accepted from the client at all — the server injects it
 * from the URL param below, so a request body can never target a
 * different workspace's row. `created_at`/`updated_at` are excluded the
 * same way as on widget_settings.
 */
const widgetPrechatPatchSchema = z.object({
  ask_name: z.boolean().optional(),
  ask_email: z.boolean().optional(),
  ask_phone: z.boolean().optional(),
  require_name: z.boolean().optional(),
  require_email: z.boolean().optional(),
  require_phone: z.boolean().optional(),
  verify_email: z.boolean().optional(),
  verify_phone: z.boolean().optional(),
  prechat_timing: z.enum(['always', 'after_handoff', 'never']).optional(),
  history_continue_window_hours: z.number().int().min(0).max(8760).optional(),
}).strict();

widgetSettingsRouter.put('/:workspaceId/prechat', async (req, res) => {
  const config = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  const parsed = widgetPrechatPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid input',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const auth = await requireManageWithPhoneVerified(req, res, workspaceId);
  if (!auth) return;

  // Plan enforcement — the pre-chat form is a plan-gated tab.
  const prechatEnt = await resolveWidgetEntitlements(config, workspaceId);
  if (prechatEnt.features.widget_prechat_form === false) {
    return res.status(403).json({ error: 'plan_upgrade_required', denied: ['widget_prechat_form'] });
  }

  const sb = getServiceClient(config);
  // workspace_id comes from the URL param (the authorized workspace), never
  // from the request body — parsed.data cannot carry it (the schema above
  // has no such field, and .strict() would reject it if the client tried).
  const { data, error } = await sb
    .from('widget_prechat_settings')
    .upsert({ ...parsed.data, workspace_id: workspaceId }, { onConflict: 'workspace_id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});

// ── Public (non-admin) projection of the platform singleton ───────
// Workspace owners need the platform-owned embed URLs, embed comments and
// "Powered by" wording to render their Install snippet. Only a safe subset is
// exposed — never admin notes, limits or feature locks.
widgetSettingsRouter.get('/platform/public', async (req, res) => {
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('widget_platform_settings')
    .select(
      'id, widget_loader_base_url, widget_asset_base_url, widget_public_base_url, widget_api_base_url, embed_header_comment, embed_footer_comment, powered_by_enabled, powered_by_text, powered_by_brand_text, powered_by_url',
    )
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data ?? null });
});

// ── widget_platform_settings (global singleton, platform admin only) ──


widgetSettingsRouter.get('/platform/config', async (req, res) => {
  const config = serverConfigOf(req);
  if (!(await requirePlatformAdmin(req, res))) return;
  const sb = getServiceClient(config);

  const fail = (stage: string, error: any) =>
    res.status(500).json({
      error: `widget_platform_settings ${stage} failed: ${error?.message || 'unknown error'}`,
      detail: error?.details || undefined,
      hint:
        error?.code === '42P01'
          ? 'Table public.widget_platform_settings is missing — run database/migrations/044_widget_platform_settings.sql (and 046) against your database.'
          : error?.code === '42501'
            ? 'Permission denied — the backend must use the Supabase service_role key (SUPABASE_SERVICE_ROLE_KEY).'
            : error?.hint || undefined,
      code: error?.code || undefined,
    });

  const { data, error } = await sb
    .from('widget_platform_settings')
    .select('*')
    .limit(1)
    .maybeSingle();
  if (error) return fail('read', error);
  if (data) return res.json({ settings: data });

  // Self-host installs may have the table without the seeded singleton row
  // (or the row was deleted). Create it on demand — the table enforces a
  // singleton unique index, so concurrent seeds are safe.
  const seed = await sb.from('widget_platform_settings').insert({}).select().single();
  if (seed.error) {
    const retry = await sb.from('widget_platform_settings').select('*').limit(1).maybeSingle();
    if (retry.data) return res.json({ settings: retry.data });
    return fail('seed', seed.error);
  }
  return res.json({ settings: seed.data });
});



/**
 * Dedicated schema for the platform singleton — separate from
 * widgetSettingsPatchSchema on purpose (different table, different threat
 * model: this route is already requirePlatformAdmin-only, a much smaller
 * and more trusted caller set than a workspace's own owner/admin). Still
 * `.strict()`, not `z.object({}).passthrough()`: even a trusted-admin
 * surface should not silently accept a column a future migration adds
 * before anyone has decided whether platform admins should be able to set
 * it, and immutable identifiers must never be writable through a generic
 * update regardless of who is calling.
 *
 * `id` is accepted here only to select WHICH row (this table is a
 * singleton, so there is exactly one, but the existing call convention
 * requires the id) — it is stripped from the write payload below exactly
 * as before. `created_at`/`updated_at` are never accepted; `updated_by` is
 * set by the server from the authenticated admin, never trusted from the
 * client. `alert_webhook_secret` is deliberately excluded: no current UI
 * writes it and it is a credential, not a setting — if a legitimate need
 * to rotate it via this API ever exists, it deserves the same treatment
 * debug_mode got (its own isolated, explicitly-audited endpoint), not a
 * slot in the general-purpose PATCH.
 */
const widgetPlatformConfigPatchSchema = z.object({
  id: z.string().uuid(),
  prechat_name_policy: z.enum(['force_on', 'force_off', 'default_on', 'default_off']).optional(),
  prechat_email_policy: z.enum(['force_on', 'force_off', 'default_on', 'default_off']).optional(),
  prechat_phone_policy: z.enum(['force_on', 'force_off', 'default_on', 'default_off']).optional(),
  default_allow_subdomains: z.boolean().optional(),
  max_allowed_domains_per_workspace: z.number().int().min(1).max(1000).optional(),
  enforce_domain_validation: z.boolean().optional(),
  default_debug_mode: z.boolean().optional(),
  force_chat_enabled: z.enum(['allow', 'force_on', 'force_off']).optional(),
  force_kb_enabled: z.enum(['allow', 'force_on', 'force_off']).optional(),
  force_visitor_tracking: z.enum(['allow', 'force_on', 'force_off']).optional(),
  max_message_length: z.number().int().min(1).max(50000).optional(),
  rate_limit_messages_per_minute: z.number().int().min(1).max(1000).optional(),
  admin_notes: z.string().max(10000).nullable().optional(),
  default_welcome_message: z.string().max(2000).optional(),
  widget_loader_base_url: z.string().max(2000).nullable().optional(),
  widget_asset_base_url: z.string().max(2000).nullable().optional(),
  widget_public_base_url: z.string().max(2000).nullable().optional(),
  widget_api_base_url: z.string().max(2000).nullable().optional(),
  embed_header_comment: z.string().max(5000).nullable().optional(),
  embed_footer_comment: z.string().max(5000).nullable().optional(),
  typing_rate_limit_enabled: z.boolean().optional(),
  typing_rate_limit_window_ms: z.number().int().min(0).optional(),
  typing_rate_limit_max_events: z.number().int().min(0).optional(),
  realtime_stale_resubscribe_guard_enabled: z.boolean().optional(),
  realtime_reconnect_jitter_pct: z.number().int().min(0).max(100).optional(),
  realtime_token_ttl_seconds: z.number().int().min(0).optional(),
  realtime_idle_disposal_ms: z.number().int().min(0).optional(),
  realtime_pending_max: z.number().int().min(0).optional(),
  realtime_message_dedupe_enabled: z.boolean().optional(),
  realtime_message_dedupe_window: z.number().int().min(0).optional(),
  observability_metrics_enabled: z.boolean().optional(),
  observability_structured_logs_enabled: z.boolean().optional(),
  observability_log_level: z.string().max(20).optional(),
  alerting_enabled: z.boolean().optional(),
  alert_webhook_url: z.string().max(2000).nullable().optional(),
  perf_memory_budget_mb: z.number().int().min(1).optional(),
  powered_by_enabled: z.boolean().optional(),
  powered_by_text: z.string().max(500).optional(),
  powered_by_brand_text: z.string().max(200).nullable().optional(),
  powered_by_url: z.string().max(2000).nullable().optional(),
}).strict();

widgetSettingsRouter.patch('/platform/config', async (req, res) => {
  const config = serverConfigOf(req);
  const parsed = widgetPlatformConfigPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid input',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const userId = await requirePlatformAdmin(req, res);
  if (!userId) return;
  const { id, ...updates } = parsed.data;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('widget_platform_settings')
    .update({ ...updates, updated_by: userId })
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});
