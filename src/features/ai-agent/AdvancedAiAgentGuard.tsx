/**
 * AdvancedAiAgentGuard — the AI section's Advanced tools («ابزارهای پیشرفته»:
 * test cases and runs, suggested tests, regression runs, source health, the
 * retrieval debugger, the run inspector, the AI billing stub).
 *
 * A plan feature since 2026-11-03 (owner): reachable when
 *   - the current user is a global platform admin (Super Admin), always, OR
 *   - the workspace's plan has `ai_advanced_tools` (Super Admin → Plans; off
 *     on every plan by default) and the member is its owner or an admin, OR
 *   - the dev override env flag VITE_ENABLE_AI_ADVANCED_TOOLS === 'true'.
 * The rule is shared/aiAdvancedTools.ts, which the server's guard of the same
 * endpoints applies too (server/services/ai-agent/customerSafe.ts).
 *
 * Anything else is redirected to /ai-agent/overview. While the admin check,
 * the plan or the role is still being read, a spinner shows (no flash).
 */
import { Navigate } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { Loader2 } from 'lucide-react';
import { aiAdvancedToolsAllowed } from '../../../shared/aiAdvancedTools';
import { useAiAdvancedToolsAccess } from './useAiAdvancedToolsAccess';

/** The rule, over what the page knows (shared/aiAdvancedTools.ts). */
export function canAccessAiAgentAdvancedTools(opts: {
  isGlobalAdmin: boolean;
  devOverride?: boolean;
  /** The workspace's effective `ai_advanced_tools` (PlanAccess.feature); omitted: off. */
  planHasAdvancedTools?: boolean;
  /** The member's workspace role; omitted: none. */
  role?: string | null;
}): boolean {
  return aiAdvancedToolsAllowed({
    isPlatformAdmin: opts.isGlobalAdmin,
    devOverride: opts.devOverride,
    planValue: opts.planHasAdvancedTools === true,
    role: opts.role,
  });
}

export function AdvancedAiAgentGuard({ children }: { children: React.ReactNode }) {
  const access = useAiAdvancedToolsAccess();
  const wsPath = useWorkspacePath();

  if (access === 'loading') {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (access !== 'allowed') {
    return <Navigate to={wsPath('/ai-agent/overview')} replace />;
  }

  return <>{children}</>;
}
