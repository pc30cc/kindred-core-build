import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  Beaker, BarChart3, ToggleLeft, Settings, CreditCard,
  Route, ScrollText, MessageCircleQuestion, Globe, FileText,
  Tags, Workflow, Bell, Plug, Bot, LayoutDashboard, Compass, Database, GraduationCap, Search, ShieldAlert, FlaskConical,
} from 'lucide-react';
import { BookOpen, Sliders, Sparkles, Activity } from 'lucide-react';

interface NavItem { key: string; label: string; subPath: string; icon: React.ElementType; }
interface NavGroup { key: string; label: string; items: NavItem[]; }

const groups: NavGroup[] = [
  {
    key: 'main', label: 'AI Agent', items: [
      { key: 'overview', label: 'Overview', subPath: '/ai-agent/overview', icon: LayoutDashboard },
      { key: 'knowledge', label: 'Knowledge', subPath: '/ai-agent/knowledge', icon: BookOpen },
      { key: 'behavior', label: 'Behavior', subPath: '/ai-agent/behavior', icon: Sliders },
      { key: 'operatorAssist', label: 'Operator Assist', subPath: '/ai-agent/operator-assist', icon: Sparkles },
      { key: 'activity', label: 'Activity', subPath: '/ai-agent/activity', icon: Activity },
    ],
  },
];

export function AiAgentLayout() {
  const wsPath = useWorkspacePath();
  const { t } = useTranslation();
  const location = useLocation();
  const tr = (k: string, fb: string) => {
    const v = t(`aiAgent.${k}` as any);
    return !v || v === `aiAgent.${k}` ? fb : v;
  };

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
          {groups.map((g) => (
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
        <div className="max-w-5xl mx-auto p-8">
          <Outlet />
        </div>
      </div>
    </div>
  );
}