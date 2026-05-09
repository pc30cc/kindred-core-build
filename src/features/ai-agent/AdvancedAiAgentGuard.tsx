/**
 * AdvancedAiAgentGuard — protects internal/QA AI Agent routes from regular
 * workspace users. Customer-facing AI Agent has only Overview, Knowledge,
 * Behavior, Operator Assist, Activity, and Settings.
 *
 * Advanced routes (regression runs, retrieval debugger, source health,
 * test cases, run inspector, raw analytics, etc.) are reachable only if:
 *   - the current user is a global platform admin, OR
 *   - the dev override env flag VITE_ENABLE_AI_ADVANCED_TOOLS === 'true'
 *
 * Anything else is redirected to /ai-agent/overview to avoid leaking
 * internal data via direct URL access.
 */
import { Navigate } from 'react-router-dom';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { Loader2 } from 'lucide-react';

export function canAccessAiAgentAdvancedTools(opts: {
  isGlobalAdmin: boolean;
  devOverride?: boolean;
}): boolean {
  if (opts.isGlobalAdmin) return true;
  if (opts.devOverride) return true;
  return false;
}

export function AdvancedAiAgentGuard({ children }: { children: React.ReactNode }) {
  const { data: isAdmin, isLoading } = useIsGlobalAdmin();
  const wsPath = useWorkspacePath();
  const devOverride = import.meta.env.VITE_ENABLE_AI_ADVANCED_TOOLS === 'true';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canAccessAiAgentAdvancedTools({ isGlobalAdmin: !!isAdmin, devOverride })) {
    return <Navigate to={wsPath('/ai-agent/overview')} replace />;
  }

  return <>{children}</>;
}