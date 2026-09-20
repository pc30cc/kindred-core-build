/**
 * Global Admin bypass helpers.
 *
 * Used by backend feature gates (modules, monthly limits, diagnostics) to
 * allow platform owners (`has_role(uid,'admin')`) to operate across any
 * workspace without being blocked by plan entitlements.
 *
 * Security boundaries that are NEVER bypassed:
 *  - Authentication is still required.
 *  - Workspace context is still required where relevant.
 *  - No public/visitor access.
 *  - SSRF / private-IP / unsafe-URL protection still applies.
 *  - RLS / data-isolation rules still apply for non-admin contexts.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

export async function isGlobalAdmin(
  config: ServerConfig,
  userId: string,
): Promise<boolean> {
  if (!userId) return false;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.rpc('has_role', {
      _user_id: userId,
      _role: 'admin',
    });
    if (error) return false;
    return !!data;
  } catch {
    return false;
  }
}

export async function logGateBypass(
  config: ServerConfig,
  params: {
    userId: string;
    workspaceId?: string | null;
    moduleKey: string;
    route: string;
    reason?: string;
  },
): Promise<void> {
  try {
    // COMPLIANCE_AUDIT_LOGGING suppresses the DATABASE row only. The
    // structured ops line below still fires: this is the highest-privilege
    // escape hatch in the product, and an operator who turns off audit
    // logging should still be left with SOME trace of it in stdout rather
    // than none at all. Narrower is safer here than symmetric.
    if (config.complianceAuditLoggingEnabled !== false) {
      const sb = getServiceClient(config);
      await sb.from('admin_gate_bypass_log').insert({
        user_id: params.userId,
        workspace_id: params.workspaceId || null,
        module_key: params.moduleKey,
        route: params.route,
        reason: params.reason || null,
      });
    }
    // Structured log for ops:
    // eslint-disable-next-line no-console
    console.info(
      `[gate-bypass] feature_gate_bypassed_by_global_admin user=${params.userId} ws=${params.workspaceId || '-'} module=${params.moduleKey} route=${params.route}`,
    );
  } catch (err: any) {
    // Never fail the request because of audit logging.
    // eslint-disable-next-line no-console
    console.warn('[gate-bypass] audit log failed:', err?.message);
  }
}