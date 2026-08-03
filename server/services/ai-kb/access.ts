/**
 * Phase 6-S5-R4 — central, typed AI KB Builder access guard.
 *
 * Entitlement type contract (must match server/services/billing/capabilityRegistry.ts):
 *   ai_assistant   → module   (check_module_access)
 *   ai_kb_builder  → feature  (check_workspace_entitlement)
 *
 * A feature is NEVER checked through the module RPC and vice versa.
 *
 * `knowledge_base` is deliberately NOT checked: the Knowledge Base is a core
 * product. Only the AI surfaces that WRITE into it are plan-gated.
 *
 * Evaluation order (fail-closed at every step):
 *   granular KB permission → ai_assistant module → ai_kb_builder feature
 *   → platform AI kill switch (+ customer visibility)
 */
import type { ServerConfig } from '../../config.js';
import { checkModuleAccess, checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { assertAiAgentPlatformEnabledForWorkspace } from '../ai-agent/platformGuards.js';
import { logGateBypass } from '../../middleware/adminBypass.js';
import { isUnreadableEntitlementReason } from '../billing/entitlementParse.js';
import {
  checkKnowledgeBasePermissionDetailed,
  type KnowledgeBasePermission,
} from '../knowledge-base/access.js';

export type AiKbEntitlementKey = 'ai_assistant' | 'ai_kb_builder';

export type AiKbDenialCode =
  | 'ai_assistant_plan_required'
  | 'ai_kb_builder_feature_required'
  | 'ai_platform_disabled'
  | 'ai_platform_kill_switch'
  | 'ai_customer_visibility_disabled'
  | 'ai_workspace_disabled'
  | 'ai_platform_status_unavailable'
  | 'entitlement_status_unavailable'
  | 'knowledge_base_permission_status_unavailable'
  | 'knowledge_base_permission_denied';

export interface AiKbDenialBody {
  error: AiKbDenialCode;
  module?: 'ai_assistant';
  feature?: 'ai_kb_builder';
  permission?: KnowledgeBasePermission;
  upgrade_required?: boolean;
}

/**
 * Phase 6-S5-R7.3 §2 — platform denials are NOT upgrade paths. A customer
 * whose access is blocked by the platform kill switch, by the customer
 * visibility switch, or by a per-workspace disable cannot fix it by buying a
 * bigger plan, so these codes are distinct from the plan denials above and
 * never carry `upgrade_required`.
 */
export const AI_KB_PLATFORM_DENIAL_CODES: readonly AiKbDenialCode[] = [
  'ai_platform_kill_switch',
  'ai_customer_visibility_disabled',
  'ai_workspace_disabled',
  'ai_platform_disabled',
];

/** Plan/feature denials — the ONLY denials that may render an upgrade CTA. */
export const AI_KB_PLAN_DENIAL_CODES: readonly AiKbDenialCode[] = [
  'ai_assistant_plan_required',
  'ai_kb_builder_feature_required',
];

export function isAiKbPlanDenial(code: AiKbDenialCode): boolean {
  return AI_KB_PLAN_DENIAL_CODES.includes(code);
}

export function isAiKbPlatformDenial(code: AiKbDenialCode): boolean {
  return AI_KB_PLATFORM_DENIAL_CODES.includes(code);
}

function platformDenialCode(
  reason: 'kill_switch' | 'customer_hidden' | 'workspace_disabled' | 'lookup_failed' | undefined,
): AiKbDenialCode {
  switch (reason) {
    case 'kill_switch': return 'ai_platform_kill_switch';
    case 'customer_hidden': return 'ai_customer_visibility_disabled';
    case 'workspace_disabled': return 'ai_workspace_disabled';
    default: return 'ai_platform_disabled';
  }
}

export interface AiKbAccessResult {
  ok: boolean;
  denial?: { status: number; body: AiKbDenialBody };
}

const OK: AiKbAccessResult = { ok: true };

/**
 * Phase 6-S5-R7.2 — an entitlement lookup that could not be evaluated is NOT
 * a denial. Reporting "your plan does not include this" when the RPC failed
 * is a lie the customer cannot act on (they upgrade and nothing changes), and
 * it hides a real outage. Infrastructure failures surface as retryable 503s;
 * only an authoritative `allowed: false` produces a 403.
 */
type LookupOutcome = 'allowed' | 'denied' | 'unavailable';

function classifyLookup(r: { allowed?: boolean; reason?: string }): LookupOutcome {
  // Phase 6-S5-R7.3 §4 — a structurally invalid RPC payload is unreadable,
  // exactly like an rpc_error, and must not read as an authoritative denial.
  if (isUnreadableEntitlementReason(r.reason)) return 'unavailable';
  return r.allowed === true ? 'allowed' : 'denied';
}

function unavailable(error: AiKbDenialCode): AiKbAccessResult {
  return { ok: false, denial: { status: 503, body: { error } } };
}

export interface AiKbAccessOptions {
  /** Granular KB permissions required for this route (evaluated first). */
  permissions?: KnowledgeBasePermission[];
  /** Global admin may bypass plan/permission gates; every bypass is audited. */
  isAdmin?: boolean;
  userId?: string;
  route?: string;
  /** Customer-facing surfaces also honour the platform customer-visibility flag. */
  customerFacing?: boolean;
}

async function bypass(
  config: ServerConfig,
  opts: AiKbAccessOptions,
  workspaceId: string,
  key: string,
): Promise<void> {
  if (!opts.userId) return;
  await logGateBypass(config, {
    userId: opts.userId,
    workspaceId,
    moduleKey: key,
    route: opts.route || 'ai-kb',
    reason: 'global_admin_bypass',
  });
}

/**
 * Single authoritative gate for every /api/ai-kb operation.
 * Returns `{ ok: true }` or a canonical, redacted denial.
 */
export async function checkAiKbAccess(
  config: ServerConfig,
  workspaceId: string,
  opts: AiKbAccessOptions = {},
): Promise<AiKbAccessResult> {
  // 1. Route-specific granular permission (admins bypass, audited).
  for (const permission of opts.permissions ?? []) {
    if (opts.isAdmin) {
      await bypass(config, opts, workspaceId, permission);
      continue;
    }
    if (!opts.userId) {
      return {
        ok: false,
        denial: {
          status: 403,
          body: { error: 'knowledge_base_permission_denied', permission },
        },
      };
    }
    const outcome = await checkKnowledgeBasePermissionDetailed(
      config, workspaceId, opts.userId, permission,
    );
    if (outcome === 'unavailable') {
      return unavailable('knowledge_base_permission_status_unavailable');
    }
    if (outcome === 'denied') {
      return {
        ok: false,
        denial: {
          status: 403,
          body: { error: 'knowledge_base_permission_denied', permission },
        },
      };
    }
  }

  // 2. Module — ai_assistant ONLY. `knowledge_base` is never gated.
  const modules: Array<{ key: 'ai_assistant'; error: AiKbDenialCode }> = [
    { key: 'ai_assistant', error: 'ai_assistant_plan_required' },
  ];
  for (const m of modules) {
    let outcome: LookupOutcome = 'unavailable';
    try {
      const r = await checkModuleAccess(
        config.supabaseUrl,
        config.supabaseServiceRoleKey,
        workspaceId,
        m.key,
      );
      outcome = classifyLookup(r);
    } catch {
      outcome = 'unavailable';
    }
    if (outcome === 'allowed') continue;
    // A lookup that could not run is retryable, and is NOT bypassable by an
    // admin either: nobody should act on state the system failed to read.
    if (outcome === 'unavailable') return unavailable('entitlement_status_unavailable');
    if (opts.isAdmin) {
      await bypass(config, opts, workspaceId, m.key);
      continue;
    }
    return {
      ok: false,
      denial: {
        status: 403,
        body: { error: m.error, module: m.key, upgrade_required: true },
      },
    };
  }

  // 3. Feature — ai_kb_builder, via the entitlement RPC (never the module RPC).
  let featureOutcome: LookupOutcome = 'unavailable';
  try {
    const r = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      'ai_kb_builder',
    );
    featureOutcome = classifyLookup(r);
  } catch {
    featureOutcome = 'unavailable';
  }
  if (featureOutcome === 'unavailable') return unavailable('entitlement_status_unavailable');
  if (featureOutcome === 'denied') {
    if (opts.isAdmin) {
      await bypass(config, opts, workspaceId, 'ai_kb_builder');
    } else {
      return {
        ok: false,
        denial: {
          status: 403,
          body: {
            error: 'ai_kb_builder_feature_required',
            feature: 'ai_kb_builder',
            upgrade_required: true,
          },
        },
      };
    }
  }

  // 4. Platform AI kill switch — hard, NOT bypassable by global admins.
  //    Customer-facing surfaces additionally honour customer visibility;
  //    global admins keep operating so they can diagnose the workspace.
  const platform = await assertAiAgentPlatformEnabledForWorkspace(config, workspaceId, {
    customerFacing: opts.customerFacing && !opts.isAdmin,
  });
  if (platform.ok !== true) {
    // Phase 6-S5-R6 — a failed platform lookup is TRANSIENT and must surface
    // as 503, not as a permanent 403 "your plan/platform disabled this".
    if (platform.reason === 'lookup_failed') {
      return {
        ok: false,
        denial: { status: 503, body: { error: 'ai_platform_status_unavailable' } },
      };
    }
    return {
      ok: false,
      denial: { status: 403, body: { error: platformDenialCode(platform.reason) } },
    };
  }

  return OK;
}

/**
 * Redacted capability snapshot for the upgrade-discovery surface.
 * Contains no private job data — only booleans the UI needs to render
 * the upgrade path.
 */
export interface AiKbCapabilitySnapshot {
  /** Always true — Knowledge Base is a core product, reported for the UI only. */
  knowledge_base: true;
  ai_assistant: boolean;
  ai_kb_builder: boolean;
  platform_enabled: boolean;
  /** True when platform state could NOT be resolved (transient, retryable). */
  platform_status_unavailable: boolean;
  /**
   * True when a plan/module entitlement lookup could not be resolved. The
   * `ai_assistant` / `ai_kb_builder` booleans are then NOT authoritative and
   * the UI must render a retry state, never an upgrade prompt.
   */
  entitlement_status_unavailable: boolean;
  /**
   * Non-null when the PLATFORM (not the plan) is what blocks this surface.
   * The UI must render an operator/support message, never an upgrade CTA.
   */
  platform_denial_code: AiKbDenialCode | null;
}

export async function readAiKbCapabilities(
  config: ServerConfig,
  workspaceId: string,
  opts: { customerFacing?: boolean } = {},
): Promise<AiKbCapabilitySnapshot> {
  const safeModule = async (key: 'ai_assistant'): Promise<LookupOutcome> => {
    try {
      const r = await checkModuleAccess(
        config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, key,
      );
      return classifyLookup(r);
    } catch { return 'unavailable'; }
  };
  const safeFeature = async (): Promise<LookupOutcome> => {
    try {
      const r = await checkEntitlementFromDB(
        config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'ai_kb_builder',
      );
      return classifyLookup(r);
    } catch { return 'unavailable'; }
  };
  const [ai_assistant, ai_kb_builder, platform] = await Promise.all([
    safeModule('ai_assistant'),
    safeFeature(),
    assertAiAgentPlatformEnabledForWorkspace(config, workspaceId, {
      customerFacing: opts.customerFacing,
    }),
  ]);
  const platformUnavailable = platform.ok === false && platform.reason === 'lookup_failed';
  return {
    knowledge_base: true,
    ai_assistant: ai_assistant === 'allowed',
    ai_kb_builder: ai_kb_builder === 'allowed',
    platform_enabled: platform.ok,
    platform_status_unavailable: platformUnavailable,
    entitlement_status_unavailable:
      ai_assistant === 'unavailable' || ai_kb_builder === 'unavailable',
    platform_denial_code:
      platform.ok === false && !platformUnavailable
        ? platformDenialCode(platform.reason)
        : null,
  };
}
