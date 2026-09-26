/**
 * Which workspace sections this member sees — the plan (src/lib/planAccess.ts),
 * their role, and the platform's AI / call-center switches, combined once.
 *
 * The sidebar, the command palette, the mobile nav, the dashboard and the
 * route guards all ask here, so a section is either offered everywhere or
 * nowhere.
 */
import { useMemo } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { usePlanAccess } from '@/hooks/useEntitlements';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import { useAiAgentCapabilities } from '@/hooks/useAiAgentCapabilities';
import { useCallCenterCapabilities } from '@/hooks/useCallCenter';
import { sectionVisible, type AppSection, type SectionContext } from '@/lib/planAccess';

export interface WorkspaceSections extends SectionContext {
  workspaceId: string | null;
  /** False until the plan snapshot has resolved (in or unavailable). */
  ready: boolean;
  /** The member's role has resolved. */
  roleKnown: boolean;
  visible(section: AppSection): boolean;
}

export function useWorkspaceSections(): WorkspaceSections {
  const { workspace } = useActiveWorkspace();
  const workspaceId = workspace?.id ?? null;
  const plan = usePlanAccess(workspaceId);
  const { data: role, isSuccess: roleKnown } = useWorkspaceRole(workspaceId ?? undefined);
  const { data: ai, isError: aiError } = useAiAgentCapabilities(workspaceId);
  const { data: callCenter, isError: callCenterError } = useCallCenterCapabilities(workspaceId);

  return useMemo(() => {
    // Fail closed: an unreadable switch is off; an unread one is unknown (null).
    const ctx: SectionContext = {
      plan,
      isAdmin: isWorkspaceAdmin(role),
      aiSurface: aiError ? false : ai ? ai.ai_agent_enabled === true && ai.customer_ai_agent_visible === true : null,
      aiAutoAnswer: aiError ? false : ai ? ai.auto_answer_enabled === true : null,
      callCenterEnabled: callCenterError ? false : callCenter ? callCenter.workspace_call_center_visible === true : null,
    };
    return {
      ...ctx,
      workspaceId,
      ready: plan.status !== 'loading',
      roleKnown,
      visible: (section: AppSection) => sectionVisible(section, ctx),
    };
  }, [plan, role, roleKnown, ai, aiError, callCenter, callCenterError, workspaceId]);
}
