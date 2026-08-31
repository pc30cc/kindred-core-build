/**
 * Widget capability resolution — the single authority that decides which
 * widget behaviours a workspace's plan actually allows.
 *
 * Consumers:
 *  - PATCH /api/widget-settings/:workspaceId  → rejects enabling a behaviour
 *    the plan does not grant, and caps the embed-domain allowlist.
 *  - POST  /api/widget/bootstrap (config)     → intersects every behaviour
 *    flag with the plan, so a downgrade disables the feature in widgets that
 *    are already installed on customer sites.
 *
 * Fallback contract: `check_workspace_entitlement` is fail-closed and returns
 * `feature_not_in_plan` for any key a plan JSON has never heard of. New
 * registry keys therefore fall back to their registry default — and only for
 * that one reason. Every other failure (missing plan, RPC error) stays denied.
 */
import type { ServerConfig } from '../../config.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';
import { CAPABILITY_REGISTRY } from '../billing/capabilityRegistry.js';

/** Widget setting column → capability key. Modules are reused, not cloned. */
export const WIDGET_SETTING_CAPABILITY: Record<string, string> = {
  chat_enabled: 'chat',
  live_chat_enabled: 'chat',
  kb_enabled: 'knowledge_base',
  knowledge_base_enabled: 'knowledge_base',
  visitor_tracking_enabled: 'visitor_tracking',
  attachments_enabled: 'widget_attachments',
  voice_notes_enabled: 'widget_voice_notes',
  emoji_enabled: 'widget_emoji',
  smart_engagement_enabled: 'widget_smart_engagement',
  store_raw_ip: 'widget_raw_ip_storage',
  show_team_avatars: 'widget_team_avatars',
  show_logo: 'widget_workspace_logo',
};

/**
 * Appearance fields the workspace may only author when the plan allows it.
 * When denied the column is reset to `reset` (null → locale/platform default)
 * both on save and in the outgoing bootstrap payload.
 */
export const WIDGET_CUSTOMIZATION_CAPABILITY: Record<string, { capability: string; reset: unknown }> = {
  reply_time_text: { capability: 'widget_reply_time_text', reset: null },
  welcome_message: { capability: 'widget_welcome_message', reset: null },
  fab_label: { capability: 'widget_launcher_label', reset: null },
  fab_scale: { capability: 'widget_launcher_size', reset: 100 },
  fab_icon: { capability: 'widget_launcher_icon', reset: 'chat' },
  placeholder_text: { capability: 'widget_composer_placeholder', reset: null },
};

const MODULE_KEYS = new Set(['chat', 'knowledge_base', 'visitor_tracking']);


export interface WidgetEntitlements {
  /** capability key → allowed */
  features: Record<string, boolean>;
  /** Maximum allowed embed domains; -1 = unlimited. */
  maxDomains: number;
}

function registryDefault(key: string): boolean | number {
  const def = CAPABILITY_REGISTRY.find((c) => c.key === key);
  if (!def) return false;
  return (def.defaultValue as boolean | number) ?? false;
}

/** A key the plan JSON never mentions falls back to the registry default. */
function isUnknownToPlan(reason?: string): boolean {
  return reason === 'feature_not_in_plan';
}

export const WIDGET_CAPABILITY_KEYS = [
  'chat',
  'knowledge_base',
  'visitor_tracking',
  'widget_attachments',
  'widget_voice_notes',
  'widget_emoji',
  'widget_smart_engagement',
  'widget_business_hours',
  'widget_domain_allowlist',
  'widget_assignment_routing',
  'widget_raw_ip_storage',
  'widget_reply_time_text',
  'widget_welcome_message',
  'widget_launcher_label',
  'widget_launcher_size',
  'widget_launcher_icon',
  'widget_composer_placeholder',
  'widget_team_avatars',
  'widget_workspace_logo',
] as const;

async function resolveBoolean(
  config: ServerConfig,
  workspaceId: string,
  key: string,
): Promise<boolean> {
  if (MODULE_KEYS.has(key)) {
    // A workspace-level module override is authoritative on its own.
    try {
      const sb = getServiceClient(config);
      const { data } = await sb
        .from('workspace_module_overrides')
        .select('enabled')
        .eq('workspace_id', workspaceId)
        .eq('module_key', key)
        .maybeSingle();
      if (data) return data.enabled === true;
    } catch {
      /* fall through to the plan check */
    }
  }
  const res = await checkEntitlementFromDB(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    workspaceId,
    key,
    { selfHostBillingUnlimited: config.selfHostBillingUnlimited === true },
  );
  if (res.allowed) return true;
  if (isUnknownToPlan(res.reason)) return registryDefault(key) === true;
  return false;
}

export async function resolveWidgetEntitlements(
  config: ServerConfig,
  workspaceId: string,
): Promise<WidgetEntitlements> {
  const features: Record<string, boolean> = {};
  await Promise.all(
    WIDGET_CAPABILITY_KEYS.map(async (key) => {
      features[key] = await resolveBoolean(config, workspaceId, key);
    }),
  );

  const limitRes = await checkEntitlementFromDB(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    workspaceId,
    'max_widget_domains',
    { numeric: true, selfHostBillingUnlimited: config.selfHostBillingUnlimited === true },
  );
  let maxDomains: number;
  if (limitRes.allowed && limitRes.limitValid && typeof limitRes.limit === 'number') {
    maxDomains = limitRes.limit;
  } else if (isUnknownToPlan(limitRes.reason) || limitRes.allowed) {
    maxDomains = Number(registryDefault('max_widget_domains')) || 0;
  } else {
    maxDomains = 0;
  }

  return { features, maxDomains };
}

/** Force every plan-denied behaviour flag off in an outgoing settings row. */
export function applyWidgetEntitlementsToSettings<T extends Record<string, any>>(
  settings: T,
  ent: WidgetEntitlements,
): T {
  const out: Record<string, any> = { ...settings };
  for (const [column, capability] of Object.entries(WIDGET_SETTING_CAPABILITY)) {
    if (!(column in out)) continue;
    if (ent.features[capability] === false) out[column] = false;
  }
  // Appearance fields the plan does not allow authoring fall back to default.
  for (const [column, def] of Object.entries(WIDGET_CUSTOMIZATION_CAPABILITY)) {
    if (!(column in out)) continue;
    if (ent.features[def.capability] === false) out[column] = def.reset;
  }
  if (ent.features.widget_business_hours === false && out.business_hours) {
    out.business_hours = { ...(out.business_hours as any), enabled: false };
  }
  // Plans without automatic routing fall back to manual assignment.
  if (ent.features.widget_assignment_routing === false && 'assignment_mode' in out) {
    out.assignment_mode = 'manual';
  }
  return out as T;
}

export interface PatchGuardResult {
  ok: boolean;
  /** Capability keys the patch tried to use without entitlement. */
  denied: string[];
}

/**
 * Reject a settings patch that turns ON a behaviour the plan denies, or that
 * grows the embed allowlist past the plan's cap.
 */
export function guardWidgetSettingsPatch(
  patch: Record<string, any>,
  ent: WidgetEntitlements,
): PatchGuardResult {
  const denied: string[] = [];

  for (const [column, capability] of Object.entries(WIDGET_SETTING_CAPABILITY)) {
    if (!(column in patch)) continue;
    if (patch[column] === true && ent.features[capability] === false) denied.push(capability);
  }

  if ('assignment_mode' in patch
      && patch.assignment_mode !== 'manual'
      && ent.features.widget_assignment_routing === false) {
    denied.push('widget_assignment_routing');
  }

  if (patch.business_hours && (patch.business_hours as any).enabled === true
      && ent.features.widget_business_hours === false) {
    denied.push('widget_business_hours');
  }

  if ('allowed_domains' in patch || 'allow_subdomains' in patch) {
    const list = Array.isArray(patch.allowed_domains) ? patch.allowed_domains : null;
    if (ent.features.widget_domain_allowlist === false && (list?.length || patch.allow_subdomains === true)) {
      denied.push('widget_domain_allowlist');
    } else if (list && ent.maxDomains >= 0 && list.length > ent.maxDomains) {
      denied.push('max_widget_domains');
    }
  }

  return { ok: denied.length === 0, denied };
}
