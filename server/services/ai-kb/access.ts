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
import {
  checkKnowledgeBasePermission,
  type KnowledgeBasePermission,
} from '../knowledge-base/access.js';

export type AiKbEntitlementKey = 'ai_assistant' | 'ai_kb_builder';

export type AiKbDenialCode =
  | 'ai_assistant_plan_required'
  | 'ai_kb_builder_feature_required'
  | 'ai_platform_disabled'
  | 'knowledge_base_permission_denied';

export interface AiKbDenialBody {
  error: AiKbDenialCode;
  module?: 'ai_assistant';
  feature?: 'ai_kb_builder';
  permission?: KnowledgeBasePermission;
  upgrade_required?: boolean;
}

export interface AiKbAccessResult {
  ok: boolean;
  denial?: { status: number; body: AiKbDenialBody };
}

const OK: AiKbAccessResult = { ok: true };

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
    const denied = await checkKnowledgeBasePermission(config, workspaceId, opts.userId, permission);
    if (denied) {
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
    let allowed = false;
    try {
      const r = await checkModuleAccess(
        config.supabaseUrl,
        config.supabaseServiceRoleKey,
        workspaceId,
        m.key,
      );
      allowed = r.allowed === true;
    } catch {
      allowed = false; // fail closed on lookup error
    }
    if (allowed) continue;
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
  let featureAllowed = false;
  try {
    const r = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      'ai_kb_builder',
    );
    featureAllowed = r.allowed === true && r.reason !== 'rpc_error' && r.reason !== 'exception';
  } catch {
    featureAllowed = false;
  }
  if (!featureAllowed) {
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
  if (!platform.ok) {
    return { ok: false, denial: { status: 403, body: { error: 'ai_platform_disabled' } } };
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
}

export async function readAiKbCapabilities(
  config: ServerConfig,
  workspaceId: string,
): Promise<AiKbCapabilitySnapshot> {
  const safeModule = async (key: 'ai_assistant'): Promise<boolean> => {
    try {
      const r = await checkModuleAccess(
        config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, key,
      );
      return r.allowed === true;
    } catch { return false; }
  };
  const safeFeature = async (): Promise<boolean> => {
    try {
      const r = await checkEntitlementFromDB(
        config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'ai_kb_builder',
      );
      return r.allowed === true && r.reason !== 'rpc_error' && r.reason !== 'exception';
    } catch { return false; }
  };
  const [ai_assistant, ai_kb_builder, platform] = await Promise.all([
    safeModule('ai_assistant'),
    safeFeature(),
    assertAiAgentPlatformEnabledForWorkspace(config, workspaceId),
  ]);
  return { knowledge_base: true, ai_assistant, ai_kb_builder, platform_enabled: platform.ok };
}
