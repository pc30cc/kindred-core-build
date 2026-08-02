/**
 * Phase 6-S5-R1 — legacy Knowledge Base URL redirect.
 * Always resolves to the CANONICAL KB route of the CURRENT workspace,
 * never a relative path and never the inbox.
 */
import { Navigate } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';

export function WorkspaceKnowledgeBaseRedirect() {
  const wsPath = useWorkspacePath();
  return <Navigate to={wsPath('/knowledge-base')} replace />;
}

export default WorkspaceKnowledgeBaseRedirect;
