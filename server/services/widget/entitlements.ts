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
import {
  checkEntitlementFromDB,
  checkModuleAccess,
} from '../../middleware/featureGating.js';
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
] as const;

async function resolveBoolean(
  config: ServerConfig,
  workspaceId: string,
  key: string,
): Promise<boolean> {
  if (MODULE_KEYS.has(key)) {
    const mod = await checkModuleAccess(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      key,
    );
    // A workspace-level module override is authoritative on its own.
    if (mod.reason === 'override') return mod.allowed === true;
  }
  const res = await checkEntitlementFromDB(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    workspaceId,
    key,
    { selfHostBillingUnlimited: (config as any).selfHostBillingUnlimited === true },
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
    { numeric: true, selfHostBillingUnlimited: (config as any).selfHostBillingUnlimited === true },
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
  if (ent.features.widget_business_hours === false && out.business_hours) {
    out.business_hours = { ...(out.business_hours as any), enabled: false };
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
