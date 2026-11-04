/**
 * Whether this member may use the AI section's Advanced tools, by the one
 * rule (shared/aiAdvancedTools.ts) the server's guard also applies: the Super
 * Admin always; otherwise the workspace's plan has `ai_advanced_tools` and
 * the member is its owner or an admin. Read by AdvancedAiAgentGuard (the
 * pages) and AiAgentLayout (the menu), so the section is offered exactly
 * where its pages open.
 *
 * `loading` while the admin check, the plan snapshot or the role is still
 * being read: nothing advanced is offered or opened then (no flash of a
 * section that then disappears). An unreadable plan or role is a no.
 */
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { usePlanAccess } from '@/hooks/useEntitlements';
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole';
import { AI_ADVANCED_TOOLS_KEY, aiAdvancedToolsAllowed } from '../../../shared/aiAdvancedTools';

export type AiAdvancedToolsAccess = 'loading' | 'allowed' | 'denied';

/** The non-production override, as before (never set in a production build). */
export function aiAdvancedToolsDevOverride(): boolean {
  return import.meta.env.VITE_ENABLE_AI_ADVANCED_TOOLS === 'true';
}

export function useAiAdvancedToolsAccess(): AiAdvancedToolsAccess {
  const { workspace } = useActiveWorkspace();
  const workspaceId = workspace?.id ?? null;
  const admin = useIsGlobalAdmin();
  const plan = usePlanAccess(workspaceId);
  const role = useWorkspaceRole(workspaceId ?? undefined);

  if (aiAdvancedToolsDevOverride() || admin.data === true) return 'allowed';
  if (admin.isLoading) return 'loading';
  if (!workspaceId || plan.status === 'loading' || role.isLoading) return 'loading';
  return aiAdvancedToolsAllowed({
    isPlatformAdmin: false,
    planValue: plan.status === 'ready' && plan.feature(AI_ADVANCED_TOOLS_KEY),
    role: role.isError ? null : role.data ?? null,
  })
    ? 'allowed'
    : 'denied';
}
