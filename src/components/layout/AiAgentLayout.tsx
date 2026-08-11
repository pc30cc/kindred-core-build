import { Outlet, NavLink, useLocation, Navigate } from 'react-router-dom';
import { useWorkspacePath, useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentCapabilities } from '@/hooks/useAiAgentCapabilities';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Bot, LayoutDashboard, BookOpen, Sliders, Sparkles, Activity, Settings as SettingsIcon, Power } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { PlanAccessGate } from '@/components/plan/PlanAccessGate';
import { AI_ACCENT, type AiAccent } from '@/components/ai-agent/AiPageHeader';

interface NavItem { key: string; label: string; subPath: string; icon: React.ElementType; accent: AiAccent; }
interface NavGroup { key: string; label: string; items: NavItem[]; }

const groups: NavGroup[] = [
  {
    key: 'main', label: 'AI Agent', items: [
      { key: 'overview', label: 'Overview', subPath: '/ai-agent/overview', icon: LayoutDashboard, accent: 'indigo' },
      { key: 'activation', label: 'Activation', subPath: '/ai-agent/activation', icon: Power, accent: 'emerald' },
      { key: 'knowledge', label: 'Knowledge Sources', subPath: '/ai-agent/knowledge', icon: BookOpen, accent: 'cyan' },
      { key: 'behavior', label: 'Behavior', subPath: '/ai-agent/behavior', icon: Sliders, accent: 'violet' },
      { key: 'operatorAssist', label: 'Operator Assist', subPath: '/ai-agent/operator-assist', icon: Sparkles, accent: 'amber' },
      { key: 'activity', label: 'Activity', subPath: '/ai-agent/activity', icon: Activity, accent: 'sky' },
      { key: 'settings', label: 'Settings', subPath: '/ai-agent/settings', icon: SettingsIcon, accent: 'rose' },
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

  // Platform kill switch ONLY — plan state must never cause a redirect;
  // a plan-off workspace must reach the upgrade screen below.
  const platformDisabled =
    !capabilities ||
    capabilities.ai_agent_enabled !== true ||
    capabilities.customer_ai_agent_visible !== true;
  if (platformDisabled) {
    return <Navigate to={wsPath('/inbox')} replace />;
  }

  const navKey = (k: string) => {
    if (!capabilities) return true;
    // `activation` is part of the core owner flow and is not a
    // super-admin-toggleable nav entry; keep it always visible.
    if (k === 'activation') return true;
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

  // Phase 6-S5-R1 — the plan gate wraps the ENTIRE AI layout (including the
  // inner AI sidebar), so nothing AI-related mounts without `ai_assistant`.
  return (
    <PlanAccessGate moduleKey="ai_assistant">
    <div className="flex h-full">
      <div className="w-[264px] shrink-0 border-e border-border/60 bg-gradient-to-b from-indigo-500/[0.06] via-violet-500/[0.03] to-transparent overflow-y-auto">
        <div className="sticky top-0 z-10 bg-background/70 backdrop-blur-xl border-b border-border/40 px-5 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-lg shadow-violet-500/25 flex items-center justify-center">
            <Bot className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight text-foreground truncate">{tr('title', 'AI Agent')}</h2>
            <p className="text-[11px] text-muted-foreground truncate">{tr('subtitle', 'Automate your conversations')}</p>
          </div>
        </div>
        <nav className="p-3 space-y-4">
          {visibleGroups.map((g) => (
            <div key={g.key}>
              <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">
                {tr(`section.${g.key}`, g.label)}
              </p>
              <div className="space-y-1">
                {g.items.map((item) => {
                  const path = wsPath(item.subPath);
                  const active = location.pathname === path;
                  const a = AI_ACCENT[item.accent];
                  return (
                    <NavLink
                      key={item.key}
                      to={path}
                      className={cn(
                        'group relative flex items-center gap-3 px-2.5 py-2 rounded-xl text-[13px] transition-all duration-200',
                        active
                          ? 'bg-background shadow-sm ring-1 ring-border/70 font-semibold text-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-background/60',
                      )}
                    >
                      <span className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-all duration-200',
                        active
                          ? cn('bg-gradient-to-br text-white shadow-md', a.grad)
                          : cn('ring-1', a.chip, 'group-hover:scale-105'),
                      )}>
                        <item.icon className="h-4 w-4" />
                      </span>
                      <span className="truncate">{tr(`nav.${item.key}`, item.label)}</span>
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-8">
          <Outlet />
        </div>
      </div>
    </div>
    </PlanAccessGate>
  );
}