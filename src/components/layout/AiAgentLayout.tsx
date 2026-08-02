import { Outlet, NavLink, useLocation, Navigate } from 'react-router-dom';
import { useWorkspacePath, useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentCapabilities } from '@/hooks/useAiAgentCapabilities';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Bot, LayoutDashboard, BookOpen, Sliders, Sparkles, Activity, Settings as SettingsIcon } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { PlanAccessGate } from '@/components/plan/PlanAccessGate';

interface NavItem { key: string; label: string; subPath: string; icon: React.ElementType; }
interface NavGroup { key: string; label: string; items: NavItem[]; }

const groups: NavGroup[] = [
  {
    key: 'main', label: 'AI Agent', items: [
      { key: 'overview', label: 'Overview', subPath: '/ai-agent/overview', icon: LayoutDashboard },
      { key: 'knowledge', label: 'Knowledge Sources', subPath: '/ai-agent/knowledge', icon: BookOpen },
      { key: 'behavior', label: 'Behavior', subPath: '/ai-agent/behavior', icon: Sliders },
      { key: 'operatorAssist', label: 'Operator Assist', subPath: '/ai-agent/operator-assist', icon: Sparkles },
      { key: 'activity', label: 'Activity', subPath: '/ai-agent/activity', icon: Activity },
      { key: 'settings', label: 'Settings', subPath: '/ai-agent/settings', icon: SettingsIcon },
    ],
  },
];

export function AiAgentLayout() {
  const wsPath = useWorkspacePath();
  const { t } = useTranslation();
  const location = useLocation();
  const { workspace } = useActiveWorkspace();
  const { data: capabilities, isLoading, isError } = useAiAgentCapabilities(workspace?.id || null);
  const { data: isAdmin } = useIsGlobalAdmin();
  const tr = (k: string, fb: string) => {
    const v = t(`aiAgent.${k}` as any);
    return !v || v === `aiAgent.${k}` ? fb : v;
  };

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

  // Platform kill switch — bounce out of the section entirely.
  const platformDisabled =
    !!capabilities && (!capabilities.ai_agent_enabled || !capabilities.customer_ai_agent_visible);
  if (platformDisabled) {
    return <Navigate to={wsPath('/inbox')} replace />;
  }

  const navKey = (k: string) => {
    if (!capabilities) return true;
    return (capabilities.customer_nav as Record<string, boolean>)[k] !== false;
  };
  // Apply max_customer_visible_nav_items cap (super admins ignore the cap).
  const cap = capabilities?.max_customer_visible_nav_items;
  const visibleGroups = groups.map((g) => {
    const filtered = g.items.filter((it) => navKey(it.key));
    if (!isAdmin && typeof cap === 'number' && cap > 0) {
      return { ...g, items: filtered.slice(0, cap) };
    }
    return { ...g, items: filtered };
  });

  return (
    <div className="flex h-full">
      <div className="w-[260px] shrink-0 border-e border-border/60 bg-card/50 overflow-y-auto">
        <div className="sticky top-0 bg-card/80 backdrop-blur-sm border-b border-border/40 px-5 py-4 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center">
            <Bot className="h-4 w-4 text-primary-foreground" />
          </div>
          <h2 className="text-base font-semibold text-foreground">{tr('title', 'AI Agent')}</h2>
        </div>
        <nav className="p-3 space-y-3">
          {visibleGroups.map((g) => (
            <div key={g.key}>
              <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">
                {tr(`section.${g.key}`, g.label)}
              </p>
              <div className="space-y-0.5">
                {g.items.map((item) => {
                  const path = wsPath(item.subPath);
                  const active = location.pathname === path;
                  return (
                    <NavLink
                      key={item.key}
                      to={path}
                      className={cn(
                        'flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors',
                        active
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0 opacity-80" />
                      <span>{tr(`nav.${item.key}`, item.label)}</span>
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-y-auto">
        {/* Phase 6-S5 — non-mounting plan gate: when `ai_assistant` is not
            in the plan, AI child pages never mount and no AI request runs. */}
        <PlanAccessGate moduleKey="ai_assistant">
          <div className="max-w-5xl mx-auto p-8">
            <Outlet />
          </div>
        </PlanAccessGate>
      </div>
    </div>
  );
}