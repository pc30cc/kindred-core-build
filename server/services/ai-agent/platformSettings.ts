/**
 * E12 — Platform-wide AI Agent settings service.
 *
 * Singleton-row config that controls global kill-switch + advanced/QA tool
 * visibility + per-feature enable flags. Managed exclusively via the Super
 * Admin Control Center; workspace UI must read the redacted capability
 * snapshot via getWorkspaceAiAgentCapabilities.
 *
 * SELF-HOSTED. PROVIDER-AGNOSTIC (no provider internals leak to clients).
 * Defaults to fully-enabled when the row is missing so an empty self-host
 * deployment still works out of the box.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { isGlobalAdmin } from '../../middleware/adminBypass.js';
import { checkModuleAccess } from '../../middleware/featureGating.js';

export interface PlatformAiAgentSettings {
  id: string;
  ai_agent_enabled: boolean;
  customer_ai_agent_visible: boolean;
  advanced_tools_enabled: boolean;
  regression_runner_enabled: boolean;
  source_health_visible_to_customers: boolean;
  test_harness_visible_to_customers: boolean;
  operator_assist_enabled: boolean;
  auto_answer_enabled: boolean;
  learning_enabled: boolean;
  files_enabled: boolean;
  websites_enabled: boolean;
  qna_enabled: boolean;
  kb_enabled: boolean;
  max_customer_visible_nav_items: number;
  disabled_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const DEFAULTS: Omit<PlatformAiAgentSettings, 'id' | 'created_at' | 'updated_at'> = {
  ai_agent_enabled: true,
  customer_ai_agent_visible: true,
  advanced_tools_enabled: false,
  regression_runner_enabled: false,
  source_health_visible_to_customers: false,
  test_harness_visible_to_customers: false,
  operator_assist_enabled: true,
  auto_answer_enabled: true,
  learning_enabled: true,
  files_enabled: true,
  websites_enabled: true,
  qna_enabled: true,
  kb_enabled: true,
  max_customer_visible_nav_items: 6,
  disabled_message: null,
  metadata: {},
};

/** Fields permitted in PATCH bodies. Any other key is ignored. */
const PATCHABLE_KEYS = new Set<keyof PlatformAiAgentSettings>([
  'ai_agent_enabled',
  'customer_ai_agent_visible',
  'advanced_tools_enabled',
  'regression_runner_enabled',
  'source_health_visible_to_customers',
  'test_harness_visible_to_customers',
  'operator_assist_enabled',
  'auto_answer_enabled',
  'learning_enabled',
  'files_enabled',
  'websites_enabled',
  'qna_enabled',
  'kb_enabled',
  'max_customer_visible_nav_items',
  'disabled_message',
]);

const CACHE_TTL_MS = 15_000;
let cache: { value: PlatformAiAgentSettings; ts: number } | null = null;

function applyDefaults(row: Partial<PlatformAiAgentSettings>): PlatformAiAgentSettings {
  const now = new Date().toISOString();
  return {
    id: row.id || 'default',
    created_at: row.created_at || now,
    updated_at: row.updated_at || now,
    ...DEFAULTS,
    ...row,
    metadata: (row.metadata as any) || {},
  } as PlatformAiAgentSettings;
}

export async function getPlatformAiAgentSettings(
  config: ServerConfig,
): Promise<PlatformAiAgentSettings> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.value;

  let value: PlatformAiAgentSettings;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('platform_ai_agent_settings' as any)
      .select('*')
      .eq('singleton_key', true)
      .maybeSingle();
    value = applyDefaults((data as any) || {});
  } catch {
    value = applyDefaults({});
  }
  cache = { value, ts: now };
  return value;
}

export function __resetPlatformAiAgentSettingsCache(): void {
  cache = null;
}

export async function updatePlatformAiAgentSettings(
  config: ServerConfig,
  patch: Partial<PlatformAiAgentSettings>,
  actorUserId: string,
): Promise<PlatformAiAgentSettings> {
  const ok = await isGlobalAdmin(config, actorUserId);
  if (!ok) throw new Error('forbidden');

  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!PATCHABLE_KEYS.has(k as any)) continue;
    sanitized[k] = v;
  }
  if (Object.keys(sanitized).length === 0) {
    return getPlatformAiAgentSettings(config);
  }

  const sb = getServiceClient(config);
  const current = await getPlatformAiAgentSettings(config);

  // Build audit summary: only changed keys with old → new values.
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const [k, v] of Object.entries(sanitized)) {
    const oldV = (current as any)[k];
    if (JSON.stringify(oldV) !== JSON.stringify(v)) {
      changes[k] = { old: oldV, new: v };
    }
  }
  const mergedMetadata: Record<string, unknown> = {
    ...(current.metadata || {}),
    last_updated_by: actorUserId,
    last_updated_at: new Date().toISOString(),
    last_change_summary: changes,
  };
  sanitized.metadata = mergedMetadata;
  sanitized.updated_at = new Date().toISOString();

  // Upsert by singleton_key=true (table has UNIQUE(singleton_key)).
  const { error } = await sb
    .from('platform_ai_agent_settings' as any)
    .update(sanitized)
    .eq('singleton_key', true);
  if (error) throw new Error(error.message);

  // Belt-and-suspenders: insert canonical row if none exists.
  const { data: post } = await sb
    .from('platform_ai_agent_settings' as any)
    .select('id')
    .eq('singleton_key', true)
    .maybeSingle();
  if (!post) {
    const { error: insErr } = await sb
      .from('platform_ai_agent_settings' as any)
      .insert([{ ...DEFAULTS, ...sanitized, singleton_key: true }]);
    if (insErr) throw new Error(insErr.message);
  }

  __resetPlatformAiAgentSettingsCache();
  const next = await getPlatformAiAgentSettings(config);

  // Pass E12-Hardening — when the platform kill switch (or customer
  // visibility, or auto-answer) just transitioned OFF, scrub
  // ai_state='ai_managed' from open conversations so they re-appear in
  // Main Inbox without waiting for a fresh visitor message.
  try {
    const wentOff =
      (current.ai_agent_enabled === true && next.ai_agent_enabled === false) ||
      (current.customer_ai_agent_visible === true && next.customer_ai_agent_visible === false) ||
      (current.auto_answer_enabled === true && next.auto_answer_enabled === false);
    if (wentOff) {
      const reason = !next.ai_agent_enabled
        ? 'platform_ai_disabled'
        : !next.customer_ai_agent_visible
          ? 'customer_ai_hidden'
          : 'auto_answer_disabled';
      await repairPlatformOffConversations(config, reason as any);
    }
  } catch (e) {
    console.warn('[platformSettings] repair after toggle-off failed:', (e as any)?.message || e);
  }
  return next;
}

/**
 * Pass E12-Hardening — sweep open conversations stuck in ai_managed and
 * restore them to Main Inbox. Idempotent. Service-role only.
 */
export async function repairPlatformOffConversations(
  config: ServerConfig,
  reason: 'platform_ai_disabled' | 'customer_ai_hidden' | 'auto_answer_disabled',
  opts?: { workspaceId?: string },
): Promise<{ scanned: number; repaired: number; skipped_closed: number }> {
  const sb = getServiceClient(config);
  const { clearAiManagementForPlatformOff } = await import('./handoffState.js');
  let q: any = sb
    .from('conversations')
    .select('id, workspace_id, status, metadata, ai_state')
    .eq('ai_state', 'ai_managed');
  if (opts?.workspaceId) q = q.eq('workspace_id', opts.workspaceId);
  const { data } = await q;
  const rows = (data as any[]) || [];
  let repaired = 0;
  let skipped_closed = 0;
  for (const r of rows) {
    if (r.status === 'closed') { skipped_closed++; continue; }
    try {
      const out = await clearAiManagementForPlatformOff(config, {
        workspaceId: r.workspace_id,
        conversationId: r.id,
        reason,
      });
      if (out.changed) repaired++;
    } catch { /* best-effort */ }
  }
  return { scanned: rows.length, repaired, skipped_closed };
}

/** Redacted capability snapshot intended for workspace customers. */
export interface WorkspaceAiAgentCapabilities {
  /** TRUE platform kill switch (Super Admin). Never affected by plan. */
  ai_agent_enabled: boolean;
  /** TRUE platform customer-visibility switch. Never affected by plan. */
  customer_ai_agent_visible: boolean;

  /** Plan state (independent from platform state). */
  plan_ai_assistant_enabled: boolean;
  plan_knowledge_base_enabled: boolean;
  plan_ai_kb_builder_enabled: boolean;
  plan_name: string | null;
  plan_slug: string | null;
  upgrade_required: boolean;
  entitlement_error: boolean;

  /** Derived state (platform AND plan). */
  effective_ai_agent_available: boolean;
  effective_ai_kb_builder_available: boolean;

  operator_assist_enabled: boolean;
  auto_answer_enabled: boolean;
  learning_enabled: boolean;
  files_enabled: boolean;
  websites_enabled: boolean;
  qna_enabled: boolean;
  kb_enabled: boolean;
  customer_nav: {
    overview: boolean;
    knowledge: boolean;
    behavior: boolean;
    operatorAssist: boolean;
    activity: boolean;
    settings: boolean;
  };
  advanced: {
    debug_visible: boolean;
    regression_visible: boolean;
    source_health_visible: boolean;
    test_harness_visible: boolean;
  };
  disabled_message: string | null;
  max_customer_visible_nav_items: number;
  /** Nested mirror of the same data (Phase 6-S5-R1). */
  platform: { enabled: boolean; customerVisible: boolean; disabledMessage: string | null };
  plan: {
    aiAssistantEnabled: boolean;
    knowledgeBaseEnabled: boolean;
    aiKbBuilderEnabled: boolean;
    planName: string | null;
    planSlug: string | null;
  };
  effective: { aiAgentAvailable: boolean; aiKbBuilderAvailable: boolean };
}

export async function getWorkspaceAiAgentCapabilities(
  config: ServerConfig,
  workspaceId: string,
  userId: string | null,
): Promise<WorkspaceAiAgentCapabilities> {
  const s = await getPlatformAiAgentSettings(config);
  const isAdmin = userId ? await isGlobalAdmin(config, userId).catch(() => false) : false;

  // ── Phase 6-S5-R1 — platform state and plan state are SEPARATE. ──
  // Platform fields below reflect ONLY the Super Admin toggles. Plan
  // entitlements live in their own fields; the UI derives `effective_*`.
  let entitlementError = false;
  const lookup = async (key: string) => {
    if (!workspaceId) return { allowed: false, plan: null as string | null };
    try {
      const r = await checkModuleAccess(
        config.supabaseUrl,
        config.supabaseServiceRoleKey,
        workspaceId,
        key,
      );
      if (r.reason === 'rpc_error' || r.reason === 'exception') entitlementError = true;
      return { allowed: !!r.allowed, plan: (r.plan as string | undefined) ?? null };
    } catch {
      entitlementError = true;
      return { allowed: false, plan: null as string | null };
    }
  };

  const aiPlan = await lookup('ai_assistant');
  const kbPlan = await lookup('knowledge_base');
  const builderPlan = await lookup('ai_kb_builder');

  const platformEnabled = s.ai_agent_enabled === true;
  const customerVisible = s.customer_ai_agent_visible === true;
  // Super admins bypass plan for diagnostics only (never the kill switch).
  const aiPlanEnabled = aiPlan.allowed || isAdmin;
  const kbPlanEnabled = kbPlan.allowed || isAdmin;
  const builderPlanEnabled = builderPlan.allowed || isAdmin;

  const effectiveAiAvailable = platformEnabled && customerVisible && aiPlanEnabled;
  const effectiveBuilderAvailable = effectiveAiAvailable && kbPlanEnabled && builderPlanEnabled;

  // Nav/advanced flags describe what an *entitled* user may see. They stay
  // driven by the platform toggles; the plan gate is applied by the client
  // (non-mounting PlanAccessGate) and by the server middleware.
  const killOn = !platformEnabled;
  const customerCanSee = platformEnabled && customerVisible;
  const advVisible = (customerFlag: boolean) => {
    if (killOn) return false;
    if (isAdmin) return true;
    return customerCanSee && s.advanced_tools_enabled && customerFlag;
  };
  const navOk = (flag: boolean) => !killOn && (isAdmin || (customerCanSee && flag));

  const planName = aiPlan.plan || kbPlan.plan || null;

  return {
    ai_agent_enabled: platformEnabled,
    customer_ai_agent_visible: customerVisible,

    plan_ai_assistant_enabled: aiPlanEnabled,
    plan_knowledge_base_enabled: kbPlanEnabled,
    plan_ai_kb_builder_enabled: builderPlanEnabled,
    plan_name: planName,
    plan_slug: planName,
    upgrade_required: platformEnabled && customerVisible && !aiPlanEnabled,
    entitlement_error: entitlementError,

    effective_ai_agent_available: effectiveAiAvailable,
    effective_ai_kb_builder_available: effectiveBuilderAvailable,

    operator_assist_enabled: s.operator_assist_enabled,
    auto_answer_enabled: s.auto_answer_enabled,
    learning_enabled: s.learning_enabled,
    files_enabled: s.files_enabled,
    websites_enabled: s.websites_enabled,
    qna_enabled: s.qna_enabled,
    kb_enabled: s.kb_enabled,
    customer_nav: {
      overview: !killOn && (isAdmin || customerCanSee),
      knowledge: navOk(s.files_enabled || s.websites_enabled || s.qna_enabled || s.kb_enabled),
      behavior: !killOn && (isAdmin || customerCanSee),
      operatorAssist: navOk(s.operator_assist_enabled),
      activity: !killOn && (isAdmin || customerCanSee),
      settings: !killOn && (isAdmin || customerCanSee),
    },
    advanced: {
      debug_visible: advVisible(false),
      regression_visible: advVisible(s.regression_runner_enabled),
      source_health_visible: advVisible(s.source_health_visible_to_customers),
      test_harness_visible: advVisible(s.test_harness_visible_to_customers),
    },
    disabled_message: s.disabled_message,
    max_customer_visible_nav_items: s.max_customer_visible_nav_items,
    platform: {
      enabled: platformEnabled,
      customerVisible,
      disabledMessage: s.disabled_message,
    },
    plan: {
      aiAssistantEnabled: aiPlanEnabled,
      knowledgeBaseEnabled: kbPlanEnabled,
      aiKbBuilderEnabled: builderPlanEnabled,
      planName,
      planSlug: planName,
    },
    effective: {
      aiAgentAvailable: effectiveAiAvailable,
      aiKbBuilderAvailable: effectiveBuilderAvailable,
    },
  };
}
