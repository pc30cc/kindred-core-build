import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { cn } from '@/lib/utils';
import { useState, useMemo } from 'react';
import {
  User, CreditCard, Settings, MessageSquare, Inbox, Mail,
  BookOpen, BarChart3, ChevronDown, ChevronLeft, ChevronRight,
  Globe, Palette, Languages, Plug, Shield, Users,
  MessageCircleReply, ShieldCheck, Monitor, UserCog,
} from 'lucide-react';

interface SettingsGroup {
  key: string;
  icon: React.ElementType;
  items: { key: string; labelKey: string; subPath: string }[];
}

const settingsGroupsDef: SettingsGroup[] = [
  {
    key: 'account', icon: User,
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
    key: 'billing', icon: CreditCard,
    items: [{ key: 'billing', labelKey: 'billing', subPath: '/billing' }],
  },
  {
    key: 'workspace', icon: Settings,
    items: [
      { key: 'general', labelKey: 'general', subPath: '/settings/general' },
      { key: 'integrations', labelKey: 'integrations', subPath: '/settings/integrations' },
      { key: 'branding', labelKey: 'branding', subPath: '/settings/branding' },
      { key: 'domains', labelKey: 'domains', subPath: '/settings/domains' },
      { key: 'privacyRequests', labelKey: 'privacyRequests', subPath: '/settings/privacy-requests' },
    ],
  },
  {
    key: 'people', icon: Users,
    items: [
      { key: 'teamDepartments', labelKey: 'teamDepartments', subPath: '/settings/team-departments' },
      { key: 'staffAccess', labelKey: 'staffAccess', subPath: '/settings/staff-access' },
    ],
  },
  {
    key: 'chatbox', icon: MessageSquare,
    items: [{ key: 'widget', labelKey: 'widget', subPath: '/widget' }],
  },
  {
    key: 'inbox', icon: Inbox,
    items: [
      { key: 'canned-responses', labelKey: 'cannedResponses', subPath: '/settings/canned-responses' },
    ],
  },
  {
    key: 'integrations', icon: Plug,
    items: [{ key: 'providers', labelKey: 'providers', subPath: '/settings/providers' }],
  },
  {
    key: 'email', icon: Mail,
    items: [{ key: 'email', labelKey: 'email', subPath: '/email' }],
  },
  {
    key: 'knowledgeBase', icon: BookOpen,
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

  // Build resolved paths
  const settingsGroups = useMemo(() =>
    settingsGroupsDef.map(g => ({
      ...g,
      items: g.items.map(i => ({ ...i, path: wsPath(i.subPath) })),
    })),
    [wsPath]
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

  return (
    <div className="flex h-full">
      {/* Settings secondary sidebar */}
      <div className="w-[260px] shrink-0 border-e border-border/60 bg-card/50 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-card/80 backdrop-blur-sm border-b border-border/40 px-5 py-4 flex items-center gap-3">
          <button
            onClick={() => navigate(wsPath(''))}
            className="p-1 rounded-md hover:bg-accent/50 text-muted-foreground transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h2 className="text-base font-semibold text-foreground">{t('settings.title')}</h2>
        </div>

        {/* Navigation groups */}
        <nav className="p-3 space-y-0.5">
          {settingsGroups.map(group => {
            const isExpanded = expandedGroups[group.key] ?? false;
            const hasActiveItem = group.items.some(i => isActive(i.path));

            return (
              <div key={group.key}>
                <button
                  onClick={() => toggleGroup(group.key)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all',
                    hasActiveItem
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  )}
                >
                  <group.icon className="h-[18px] w-[18px] shrink-0 opacity-70" />
                  <span className="flex-1 text-start">{t(`settingsNav.groups.${group.key}`)}</span>
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform duration-200 opacity-50',
                      isExpanded && 'rotate-180'
                    )}
                  />
                </button>

                {isExpanded && (
                  <div className="ms-[34px] space-y-0.5 mt-0.5 mb-1">
                    {group.items.map(item => (
                      <Link
                        key={item.key}
                        to={item.path}
                        className={cn(
                          'block px-3 py-1.5 rounded-md text-[13px] transition-all',
                          isActive(item.path)
                            ? 'text-primary font-medium bg-primary/5'
                            : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
                        )}
                      >
                        {t(`settingsNav.items.${item.labelKey}`)}
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
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-8">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
