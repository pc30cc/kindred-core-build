/**
 * Legacy `/ai-agent/qna` URL — Q&A authoring now lives in the unified
 * Knowledge Base page (Articles / Q&A tabs), not under AI Agent.
 */
import { Navigate } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';

export function WorkspaceQnaRedirect() {
  const wsPath = useWorkspacePath();
  return <Navigate to={`${wsPath('/knowledge-base')}?tab=qna`} replace />;
}

export default WorkspaceQnaRedirect;
