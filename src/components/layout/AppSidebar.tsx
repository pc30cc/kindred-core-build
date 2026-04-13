import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import {
  LayoutDashboard, Inbox, Users, Eye, BookOpen, MessageSquare,
  Bot, Mail, UserPlus, CreditCard, Settings, Globe, Palette,
  Languages, User, Plug, ChevronLeft, ChevronRight, LogOut, Shield,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/AuthContext';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

const mainNav = [
  { key: 'overview', path: '/app', icon: LayoutDashboard },
  { key: 'inbox', path: '/app/inbox', icon: Inbox },
  { key: 'contacts', path: '/app/contacts', icon: Users },
  { key: 'visitors', path: '/app/visitors', icon: Eye },
  { key: 'knowledgeBase', path: '/app/knowledge-base', icon: BookOpen },
  { key: 'widget', path: '/app/widget', icon: MessageSquare },
  { key: 'ai', path: '/app/ai', icon: Bot },
  { key: 'email', path: '/app/email', icon: Mail },
  { key: 'team', path: '/app/team', icon: UserPlus },
  { key: 'billing', path: '/app/billing', icon: CreditCard },
] as const;

const settingsNav = [
  { key: 'general', path: '/app/settings/general', icon: Settings },
  { key: 'branding', path: '/app/settings/branding', icon: Palette },
  { key: 'domains', path: '/app/settings/domains', icon: Globe },
  { key: 'providers', path: '/app/settings/providers', icon: Plug },
  { key: 'translations', path: '/app/settings/translations', icon: Languages },
  { key: 'profile', path: '/app/settings/profile', icon: User },
] as const;

export function AppSidebar() {
  const { t, dir } = useTranslation();
  const location = useLocation();
  const { signOut } = useAuth();
  const { data: isAdmin } = useIsGlobalAdmin();
  const [collapsed, setCollapsed] = useState(false);

  const isActive = (path: string) => {
    if (path === '/app') return location.pathname === '/app';
    return location.pathname.startsWith(path);
  };

  const CollapseIcon = dir === 'rtl' ? (collapsed ? ChevronLeft : ChevronRight) : (collapsed ? ChevronRight : ChevronLeft);

  return (
    <aside
      className={cn(
        'flex h-screen flex-col bg-sidebar text-sidebar-foreground border-e border-sidebar-border transition-all duration-200',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      <div className="flex h-14 items-center justify-between px-4 border-b border-sidebar-border">
        {!collapsed && <span className="text-sm font-semibold truncate">Workspace</span>}
        <button onClick={() => setCollapsed(!collapsed)} className="p-1 rounded hover:bg-sidebar-accent">
          <CollapseIcon className="h-4 w-4 text-sidebar-muted-foreground" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
        {mainNav.map(item => (
          <Link
            key={item.key}
            to={item.path}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              isActive(item.path)
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{t(`nav.${item.key}` as any)}</span>}
          </Link>
        ))}

        <div className="pt-4 pb-1 px-3">
          {!collapsed && (
            <span className="text-xs font-medium uppercase tracking-wider text-sidebar-muted-foreground">
              {t('nav.settings')}
            </span>
          )}
        </div>

        {settingsNav.map(item => (
          <Link
            key={item.key}
            to={item.path}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              isActive(item.path)
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{t(`nav.${item.key}` as any)}</span>}
          </Link>
        ))}
      </nav>

      <div className="border-t border-sidebar-border p-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-3 text-sidebar-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent"
          onClick={signOut}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && <span>{t('auth.logout')}</span>}
        </Button>
      </div>
    </aside>
  );
}
