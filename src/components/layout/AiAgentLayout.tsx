import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  Beaker, BarChart3, ToggleLeft, Settings, CreditCard,
  Route, ScrollText, MessageCircleQuestion, Globe, FileText,
  Tags, Workflow, Bell, Plug, Bot, LayoutDashboard, Compass, Database, GraduationCap, Search, ShieldAlert, FlaskConical,
} from 'lucide-react';

interface NavItem { key: string; label: string; subPath: string; icon: React.ElementType; }
interface NavGroup { key: string; label: string; items: NavItem[]; }

const groups: NavGroup[] = [
  {
    key: 'evaluate', label: 'Evaluate', items: [
      { key: 'overview', label: 'Overview', subPath: '/ai-agent/overview', icon: LayoutDashboard },
      { key: 'playground', label: 'Playground', subPath: '/ai-agent/playground', icon: Beaker },
      { key: 'analytics', label: 'Analytics', subPath: '/ai-agent/analytics', icon: BarChart3 },
      { key: 'retrievalDebugger', label: 'Retrieval Debugger', subPath: '/ai-agent/debug/retrieval', icon: Search },
      { key: 'sourceHealth', label: 'Source Health', subPath: '/ai-agent/source-health', icon: ShieldAlert },
      { key: 'testCases', label: 'Test Cases', subPath: '/ai-agent/test-cases', icon: FlaskConical },
      { key: 'suggestedTests', label: 'Suggested Tests', subPath: '/ai-agent/suggested-tests', icon: FlaskConical },
      { key: 'assistAnalytics', label: 'Assist Analytics', subPath: '/ai-agent/operator-assist-analytics', icon: BarChart3 },
    ],
  },
  {
    key: 'agent', label: 'Agent', items: [
      { key: 'activation', label: 'Activation', subPath: '/ai-agent/activation', icon: ToggleLeft },
      { key: 'settings', label: 'Settings', subPath: '/ai-agent/settings', icon: Settings },
      { key: 'billing', label: 'Billing', subPath: '/ai-agent/billing', icon: CreditCard },
    ],
  },
  {
    key: 'guidance', label: 'Guidance', items: [
      { key: 'guidance', label: 'Guidance rules', subPath: '/ai-agent/guidance', icon: Compass },
      { key: 'routing', label: 'Routing', subPath: '/ai-agent/routing', icon: Route },
      { key: 'instructions', label: 'Instructions', subPath: '/ai-agent/instructions', icon: ScrollText },
    ],
  },
  {
    key: 'train', label: 'Train', items: [
      { key: 'dataHub', label: 'Data Hub', subPath: '/ai-agent/train', icon: Database },
      { key: 'qna', label: 'Questions & Answers', subPath: '/ai-agent/qna', icon: MessageCircleQuestion },
      { key: 'learningCandidates', label: 'Learning Candidates', subPath: '/ai-agent/learning-candidates', icon: GraduationCap },
      { key: 'webPages', label: 'Web pages', subPath: '/ai-agent/web-pages', icon: Globe },
      { key: 'files', label: 'Files', subPath: '/ai-agent/files', icon: FileText },
    ],
  },
  {
    key: 'automate', label: 'Automate', items: [
      { key: 'topics', label: 'Topic detection', subPath: '/ai-agent/topics', icon: Tags },
      { key: 'workflow', label: 'Workflow builder', subPath: '/ai-agent/workflow', icon: Workflow },
      { key: 'triggers', label: 'Message triggers', subPath: '/ai-agent/triggers', icon: Bell },
      { key: 'integrations', label: 'Integrations & MCP', subPath: '/ai-agent/integrations', icon: Plug },
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