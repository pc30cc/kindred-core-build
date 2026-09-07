/**
 * Legacy `/ai-agent/files` URL — file management now lives in the unified
 * Knowledge Base page (Articles / Q&A / Files tabs), not under AI Agent.
 */
import { Navigate } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';

export function WorkspaceFilesRedirect() {
  const wsPath = useWorkspacePath();
  return <Navigate to={`${wsPath('/knowledge-base')}?tab=files`} replace />;
}

export default WorkspaceFilesRedirect;
