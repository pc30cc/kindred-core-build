/**
 * /team surface.
 *
 * Owners and admins are redirected to the canonical Team & Departments
 * settings page (the single shared InvitationManagement implementation).
 * Operators (agents/viewers) get a read-only colleague directory with
 * internal 1:1 messaging — no management capabilities at all.
 */
import { Navigate } from 'react-router-dom';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import TeamChatPanel from '@/components/inbox/TeamChatPanel';

export default function TeamPage() {
  const workspace = useCurrentWorkspace();
  const { data: role, isPending } = useWorkspaceRole(workspace?.id);

  if (isPending) return <div className="h-full w-full" />;
  if (isWorkspaceAdmin(role)) return <Navigate to="../settings/team-departments" replace />;

  return (
    <div className="h-full w-full overflow-hidden">
      <TeamChatPanel />
    </div>
  );
}
