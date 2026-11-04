/**
 * Who may use the AI section's Advanced tools («ابزارهای پیشرفته»: test
 * cases, test runs, suggested tests, regression runs, source health, the
 * knowledge-search debugger and the answer inspector).
 *
 * A plan feature since 2026-11-03 (owner): the Super Admin turns it on per
 * plan (Super Admin → Plans, key `ai_advanced_tools`, off by default, so off
 * on every plan until a plan turns it on). It replaced the Super Admin's
 * platform switches for customer visibility (advanced_tools_enabled,
 * regression_runner_enabled, source_health_visible_to_customers,
 * test_harness_visible_to_customers), whose columns stay but no longer open
 * or close anything. See docs/operations/AI_ADVANCED_TOOLS.md.
 *
 * The rule, one for the web panel (src/features/ai-agent/AdvancedAiAgentGuard.tsx,
 * the AI section's menu) and the server (server/services/ai-agent/customerSafe.ts
 * canAccessAiAgentAdvancedToolsServer, the guard of the advanced endpoints):
 *   - a platform admin (Super Admin) always;
 *   - the non-production override (VITE_ENABLE_AI_ADVANCED_TOOLS on the
 *     client, ENABLE_AI_ADVANCED_TOOLS on a non-production server), as before;
 *   - otherwise the workspace's effective plan has `ai_advanced_tools`
 *     exactly `true` AND the member manages the workspace's AI (its owner or
 *     an admin, the role every AI settings write asks for). A plan not read
 *     yet, or unreadable, is off.
 *
 * Pure: no I/O.
 */

/** The plan key (server/services/billing/capabilityRegistry.ts). */
export const AI_ADVANCED_TOOLS_KEY = 'ai_advanced_tools';

/** The roles that manage a workspace's AI: its owner and admins. */
export function canManageWorkspaceAi(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export interface AiAdvancedToolsAccessInput {
  /** A platform admin (Super Admin). */
  isPlatformAdmin: boolean;
  /** The non-production override flag. */
  devOverride?: boolean;
  /** The workspace's effective `ai_advanced_tools`; anything but exactly true is off. */
  planValue: unknown;
  /** The member's role in that workspace (null: not a member, or not known yet). */
  role: string | null | undefined;
}

export function aiAdvancedToolsAllowed(input: AiAdvancedToolsAccessInput): boolean {
  if (input.isPlatformAdmin) return true;
  if (input.devOverride) return true;
  return input.planValue === true && canManageWorkspaceAi(input.role);
}
