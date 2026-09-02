import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useWorkspacePath, useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import { cn } from '@/lib/utils';
import { useState, useMemo } from 'react';
import { AI_ACCENT, type AiAccent } from '@/components/ai-agent/AiPageHeader';
import {
  User, CreditCard, Settings, MessageSquare, Inbox, Mail,
  BookOpen, BarChart3, ChevronDown, ChevronLeft, ChevronRight,
  Globe, Palette, Languages, Plug, Shield, Users,
  MessageCircleReply, ShieldCheck, Monitor, UserCog,
} from 'lucide-react';

const ADMIN_ONLY_GROUPS = new Set(['workspace', 'people', 'chatbox', 'integrations', 'email', 'knowledgeBase', 'billing']);

interface SettingsGroup {
  key: string;
  icon: React.ElementType;
  accent: AiAccent;
  items: { key: string; labelKey: string; subPath: string }[];
}

const settingsGroupsDef: SettingsGroup[] = [
  {
    key: 'account', icon: User, accent: 'indigo',
    items: [
      { key: 'profile', labelKey: 'profile', subPath: '/settings/profile' },
      { key: 'notifications', labelKey: 'notifications', subPath: '/settings/notifications' },
      { key: 'availability', labelKey: 'availability', subPath: '/settings/availability' },
      { key: 'security', labelKey: 'security', subPath: '/settings/security' },
      { key: 'privacy', labelKey: 'privacy', subPath: '/settings/privacy' },
      { key: 'interface', labelKey: 'interface', subPath: '/settings/interface' },
    ],
  },
  {
    key: 'billing', icon: CreditCard, accent: 'emerald',
    items: [{ key: 'billing', labelKey: 'billing', subPath: '/billing' }],
  },
  {
    key: 'workspace', icon: Settings, accent: 'violet',
    items: [
      { key: 'general', labelKey: 'general', subPath: '/settings/general' },
      { key: 'integrations', labelKey: 'integrations', subPath: '/settings/integrations' },
      { key: 'domains', labelKey: 'domains', subPath: '/settings/domains' },
      { key: 'privacyRequests', labelKey: 'privacyRequests', subPath: '/settings/privacy-requests' },
    ],
  },
  {
    key: 'people', icon: Users, accent: 'sky',
    items: [
      { key: 'teamDepartments', labelKey: 'teamDepartments', subPath: '/settings/team-departments' },
      { key: 'staffAccess', labelKey: 'staffAccess', subPath: '/settings/staff-access' },
      { key: 'operatorActivity', labelKey: 'operatorActivity', subPath: '/settings/operator-activity' },
    ],
  },
  {
    key: 'chatbox', icon: MessageSquare, accent: 'cyan',
    items: [{ key: 'widget', labelKey: 'widget', subPath: '/widget' }],
  },
  {
    key: 'inbox', icon: Inbox, accent: 'amber',
    items: [
      { key: 'canned-responses', labelKey: 'cannedResponses', subPath: '/settings/canned-responses' },
    ],
  },
  {
    key: 'integrations', icon: Plug, accent: 'rose',
    items: [{ key: 'providers', labelKey: 'providers', subPath: '/settings/providers' }],
  },
  {
    key: 'email', icon: Mail, accent: 'sky',
    items: [{ key: 'email', labelKey: 'email', subPath: '/email' }],
  },
  {
    key: 'knowledgeBase', icon: BookOpen, accent: 'cyan',
    items: [
      { key: 'translations', labelKey: 'translations', subPath: '/settings/translations' },
    ],
  },
];

export function SettingsLayout() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const workspace = useCurrentWorkspace();
  const { data: wsRole } = useWorkspaceRole(workspace?.id);
  const canSeeAdminSettings = isWorkspaceAdmin(wsRole);

  // Build resolved paths
  const settingsGroups = useMemo(() =>
    settingsGroupsDef
      .filter(g => canSeeAdminSettings || !ADMIN_ONLY_GROUPS.has(g.key))
      .map(g => ({
      ...g,
      items: g.items.map(i => ({ ...i, path: wsPath(i.subPath) })),
      })),
    [wsPath, canSeeAdminSettings]
  );

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    settingsGroups.forEach(g => {
      if (g.items.some(i => location.pathname === i.path || location.pathname.startsWith(i.path))) {
        initial[g.key] = true;
      }
    });
    return initial;
  });

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const isActive = (path: string) => location.pathname === path;

  // Active group/item drives the colorful hero band above the page content.
  const activeGroup = settingsGroups.find(g => g.items.some(i => isActive(i.path)));
  const activeItem = activeGroup?.items.find(i => isActive(i.path));
  const heroAccent = AI_ACCENT[activeGroup?.accent ?? 'indigo'];
  const HeroIcon = activeGroup?.icon ?? Settings;

  return (
    <div className="flex h-full min-h-0">
      {/* Settings secondary sidebar */}
      <div className="w-[252px] shrink-0 border-e border-border/60 bg-gradient-to-b from-primary/[0.06] via-violet-500/[0.03] to-transparent overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-background/70 backdrop-blur-xl border-b border-border/40 px-3 py-3 flex items-center gap-2.5">
          <button
            onClick={() => navigate(wsPath(''))}
            className="p-1 rounded-lg hover:bg-accent/50 text-muted-foreground transition-colors"
          >
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          </button>
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-primary via-indigo-500 to-violet-500 text-white shadow-lg shadow-primary/25">
            <Settings className="h-4 w-4" />
          </div>
          <h2 className="text-[15px] font-semibold text-foreground">{t('settings.title')}</h2>
        </div>

        {/* Navigation groups */}
        <nav className="p-3 space-y-1">
          {settingsGroups.map(group => {
            const isExpanded = expandedGroups[group.key] ?? false;
            const hasActiveItem = group.items.some(i => isActive(i.path));
            const a = AI_ACCENT[group.accent];

            return (
              <div key={group.key}>
                <button
                  onClick={() => toggleGroup(group.key)}
                  className={cn(
                    'group w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-[13px] font-medium transition-all duration-200',
                    hasActiveItem
                      ? 'bg-background shadow-sm ring-1 ring-border/70 font-semibold text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-background/60'
                  )}
                >
                  <span className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-all duration-200',
                    hasActiveItem
                      ? cn('bg-gradient-to-br text-white shadow-md', a.grad)
                      : cn('ring-1 group-hover:scale-105', a.chip)
                  )}>
                    <group.icon className="h-4 w-4" />
                  </span>
                  <span className="flex-1 text-start">{t(`settingsNav.groups.${group.key}` as Parameters<typeof t>[0])}</span>
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform duration-200 opacity-50',
                      isExpanded && 'rotate-180'
                    )}
                  />
                </button>

                {isExpanded && (
                  <div className="ms-[34px] space-y-0.5 mt-1 mb-1.5 border-s border-border/50 ps-2">
                    {group.items.map(item => (
                      <Link
                        key={item.key}
                        to={item.path}
                        className={cn(
                          'block px-3 py-1.5 rounded-lg text-[13px] transition-all',
                          isActive(item.path)
                            ? cn('font-semibold ring-1', a.chip)
                            : 'text-muted-foreground hover:text-foreground hover:bg-background/60'
                        )}
                      >
                        {t(`settingsNav.items.${item.labelKey}` as Parameters<typeof t>[0])}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* Settings content area */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-5 space-y-5">
          {activeItem && (
            <div className={cn(
              'relative overflow-hidden rounded-2xl border border-border/60 p-5 bg-gradient-to-br to-transparent',
              heroAccent.soft,
            )}>
              <div className={cn('pointer-events-none absolute -top-16 -end-12 h-44 w-44 rounded-full blur-3xl', heroAccent.glow)} />
              <div className="relative flex items-center gap-3.5">
                <div className={cn(
                  'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg',
                  heroAccent.grad,
                )}>
                  <HeroIcon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-xl font-bold tracking-tight leading-tight truncate">
                    {t(`settingsNav.items.${activeItem.labelKey}` as Parameters<typeof t>[0])}
                  </h1>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {t(`settingsNav.groups.${activeGroup!.key}` as Parameters<typeof t>[0])}
                  </p>
                </div>
              </div>
            </div>
          )}
          <Outlet />
        </div>
      </div>
    </div>
  );
}
