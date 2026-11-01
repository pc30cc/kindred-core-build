import { Outlet, Link, useLocation, Navigate } from 'react-router-dom';
import { useWorkspacePath, useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentCapabilities } from '@/hooks/useAiAgentCapabilities';
import { useAiAgentSettings } from '@/hooks/useAiAgent';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useTranslation, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { Bot, Loader2 } from 'lucide-react';
import { PlanAccessGate } from '@/components/plan/PlanAccessGate';
import { AI_ACCENT } from '@/components/ai-agent/AiPageHeader';
import { canAccessAiAgentAdvancedTools } from '@/features/ai-agent/AdvancedAiAgentGuard';
import { aiSectionForPath, aiSubPath, aiTabMatches, visibleAiMenu } from './aiAgentMenu';

type AgentState = 'on' | 'suggest' | 'off';

const STATE_LABEL: Record<AgentState, TranslationKey> = {
  on: 'aiAgent.menu.stateOn',
  suggest: 'aiAgent.menu.stateSuggest',
  off: 'aiAgent.menu.stateOff',
};

/** On, off or suggestions only, for the chip in the list's header. */
function useAgentState(workspaceId: string | undefined): AgentState | null {
  const { data } = useAiAgentSettings(workspaceId);
  if (!data) return null;
  if (!data.enabled || data.mode === 'off') return 'off';
  if (data.mode === 'suggest_only') return 'suggest';
  return 'on';
}

/**
 * The AI section's frame: the platform switches and the plan, then a short
 * list of sections (aiAgentMenu.ts) beside the open page, whose sibling
 * pages show as tabs above it. On a phone the list is a row above the page.
 */
export function AiAgentLayout() {
  const wsPath = useWorkspacePath();
  const { t } = useTranslation();
  const location = useLocation();
  const { workspace } = useActiveWorkspace();
  const { data: capabilities, isLoading, isError } = useAiAgentCapabilities(workspace?.id || null);
  const { data: isAdmin } = useIsGlobalAdmin();
  const agentState = useAgentState(workspace?.id);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Fail-closed on capability lookup error.
  if (isError) {
    return <Navigate to={wsPath('/inbox')} replace />;
  }

  // Platform kill switch ONLY — plan state must never cause a redirect;
  // a plan-off workspace must reach the upgrade screen below.
  const platformDisabled =
    !capabilities ||
    capabilities.ai_agent_enabled !== true ||
    capabilities.customer_ai_agent_visible !== true;
  if (platformDisabled) {
    return <Navigate to={wsPath('/inbox')} replace />;
  }

  const navFlags = capabilities.customer_nav;
  const advancedAllowed = canAccessAiAgentAdvancedTools({
    isGlobalAdmin: isAdmin === true,
    devOverride: import.meta.env.VITE_ENABLE_AI_ADVANCED_TOOLS === 'true',
  });
  // max_customer_visible_nav_items counts sections; super admins ignore it.
  const cap = capabilities.max_customer_visible_nav_items;
  const sections = visibleAiMenu({
    navFlags,
    advancedAllowed,
    cap: !isAdmin && typeof cap === 'number' ? cap : null,
  });
  const sub = aiSubPath(location.pathname);
  // The open page's section, even when the cap left it out of the list, so
  // its tabs still show.
  const current = aiSectionForPath(sub, visibleAiMenu({ navFlags, advancedAllowed, cap: null }));

  // Phase 6-S5-R1 — the plan gate wraps the ENTIRE AI layout (including the
  // inner AI sidebar), so nothing AI-related mounts without `ai_assistant`.
  return (
    <PlanAccessGate moduleKey="ai_assistant">
    <div data-section-layout="ai-agent" className="flex h-full flex-col md:flex-row">
      <div
        data-section-nav="ai-agent"
        className="w-full shrink-0 border-b border-border/60 bg-gradient-to-b from-indigo-500/[0.06] via-violet-500/[0.03] to-transparent md:w-[264px] md:overflow-y-auto md:border-b-0 md:border-e"
      >
        <div data-section-nav-header className="sticky top-0 z-10 hidden items-center gap-3 border-b border-border/40 bg-background/70 px-5 py-4 backdrop-blur-xl md:flex">
          <div data-section-nav-mark className="w-9 h-9 shrink-0 rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-lg shadow-violet-500/25 flex items-center justify-center">
            <Bot className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold leading-tight text-foreground truncate">{t('aiAgent.title')}</h2>
            {agentState ? (
              <Link
                to={wsPath('/ai-agent/activation')}
                data-ai-agent-state={agentState}
                className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    agentState === 'on' && 'bg-emerald-500',
                    agentState === 'suggest' && 'bg-amber-500',
                    agentState === 'off' && 'bg-muted-foreground/50',
                  )}
                />
                <span className="truncate">{t(STATE_LABEL[agentState])}</span>
              </Link>
            ) : (
              <p className="text-[11px] text-muted-foreground truncate">{t('aiAgent.subtitle')}</p>
            )}
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto p-2 md:block md:overflow-visible md:p-3">
          <div className="flex md:block">
            <div className="flex gap-1 md:block md:space-y-1">
              {sections.map((section) => {
                const active = current?.id === section.id;
                const a = AI_ACCENT[section.accent];
                return (
                  <Link
                    key={section.id}
                    to={wsPath(`/ai-agent/${section.tabs[0].path}`)}
                    data-section-nav-item
                    data-ai-section={section.id}
                    data-active={active}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex shrink-0 items-center gap-3 whitespace-nowrap rounded-xl px-2.5 py-2 text-[13px] transition-all duration-200 md:whitespace-normal',
                      active
                        ? 'bg-background shadow-sm ring-1 ring-border/70 font-semibold text-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-background/60',
                    )}
                  >
                    <span data-section-nav-icon className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-all duration-200',
                      active
                        ? cn('bg-gradient-to-br text-white shadow-md', a.grad)
                        : cn('ring-1', a.chip, 'group-hover:scale-105'),
                    )}>
                      <section.icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">{t(section.label)}</span>
                      <span data-section-nav-desc className="hidden truncate text-[11px] font-normal text-muted-foreground lg:block">
                        {t(section.desc)}
                      </span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>
      </div>
      <div data-section-content className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-4 sm:p-6 md:p-8">
          {current && current.tabs.length > 1 && (
            <nav
              data-section-tabs
              aria-label={t(current.label)}
              className="relative mb-6 flex gap-1 overflow-x-auto border-b border-border/60 pb-2"
            >
              {current.tabs.map((tab) => {
                const active = aiTabMatches(sub, tab.path);
                return (
                  <Link
                    key={tab.path}
                    to={wsPath(`/ai-agent/${tab.path}`)}
                    data-ai-tab={tab.path}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex items-center whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors',
                      active
                        ? 'font-semibold text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <span>{t(tab.label)}</span>
                    {/* The open tab's underline (as on the Call Center's rail). */}
                    <span
                      className={cn(
                        'absolute inset-x-2 -bottom-2 h-0.5 rounded-full transition-all',
                        active ? 'bg-primary opacity-100' : 'bg-transparent opacity-0',
                      )}
                    />
                  </Link>
                );
              })}
            </nav>
          )}
          <Outlet />
        </div>
      </div>
    </div>
    </PlanAccessGate>
  );
}
