import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useI18n } from '@/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { SUPPORTED_LOCALES, LOCALE_CONFIG } from '@/i18n/config';
import {
  LayoutDashboard, Inbox, Users, Eye, BookOpen, MessageSquare,
  Bot, Mail, UserPlus, CreditCard, Settings, Globe, Palette,
  Languages, User, Plug, LogOut, Shield, Search, Package, Rocket,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/AuthContext';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useMemo } from 'react';

const mainNav = [
  { key: 'inbox', path: '/app/inbox', icon: Inbox, badge: true },
  { key: 'ai', path: '/app/ai', icon: Bot },
  { key: 'visitors', path: '/app/visitors', icon: Eye },
  { key: 'contacts', path: '/app/contacts', icon: Users },
  { key: 'knowledgeBase', path: '/app/knowledge-base', icon: BookOpen },
] as const;

const bottomNav = [
  { key: 'search', path: '#', icon: Search },
  { key: 'widget', path: '/app/widget', icon: Package },
  { key: 'settings', path: '/app/settings/general', icon: Settings },
] as const;

export function AppSidebar() {
  const { t, dir } = useTranslation();
  const { locale, setLocale } = useI18n();
  const location = useLocation();
  const { signOut, user } = useAuth();
  const { data: isAdmin } = useIsGlobalAdmin();
  const { platformName } = useBrandingContext();

  const brandLetter = useMemo(() => (platformName || 'A').charAt(0), [platformName]);

  const isActive = (path: string) => {
    if (path === '/app') return location.pathname === '/app';
    if (path === '/app/settings/general') return location.pathname.startsWith('/app/settings');
    return location.pathname.startsWith(path);
  };

  const userName = user?.fullName || user?.email?.split('@')[0] || '';
  const userEmail = user?.email || '';

  return (
    <aside className="flex h-screen w-[220px] flex-col bg-sidebar border-e border-sidebar-border">
      {/* Workspace header */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
            <span className="text-xs font-black text-primary-foreground">{brandLetter}</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-sidebar-foreground truncate">{platformName || 'Workspace'}</p>
          </div>
        </div>
      </div>

      {/* Get Started button */}
      <div className="px-3 mb-1">
        <Link
          to="/app"
          className={cn(
            'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold transition-all',
            isActive('/app')
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'bg-primary/10 text-primary hover:bg-primary/15'
          )}
        >
          <Rocket className="h-4 w-4 shrink-0" />
          <span>{t('wizard.getStarted')}</span>
        </Link>
      </div>

      {/* Main navigation */}
      <nav className="flex-1 overflow-y-auto pt-3 px-3 space-y-0.5">
        {mainNav.map(item => (
          <Link
            key={item.key}
            to={item.path}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all',
              isActive(item.path)
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
            )}
          >
            <item.icon className="h-[18px] w-[18px] shrink-0" />
            <span>{t(`nav.${item.key}` as any)}</span>
          </Link>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="px-3 pb-2 space-y-0.5">
        {bottomNav.map(item => (
          <Link
            key={item.key}
            to={item.path}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all',
              isActive(item.path)
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
            )}
          >
            <item.icon className="h-[18px] w-[18px] shrink-0" />
            <span>{t(`nav.${item.key}` as any)}</span>
          </Link>
        ))}

        {isAdmin && (
          <Link
            to="/admin"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-destructive hover:bg-destructive/10 transition-all"
          >
            <Shield className="h-[18px] w-[18px] shrink-0" />
            <span>Super Admin</span>
          </Link>
        )}
      </div>

      {/* User profile + language + logout */}
      <div className="border-t border-sidebar-border px-3 py-3 space-y-2">
        <div className="flex items-center gap-2.5 px-1">
          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <span className="text-xs font-semibold text-primary">{userName.charAt(0).toUpperCase()}</span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-sidebar-foreground truncate">{userName}</p>
            <p className="text-[11px] text-sidebar-muted-foreground truncate">{userEmail}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="h-7 text-xs flex-1 border-sidebar-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LOCALES.map(l => (
                <SelectItem key={l} value={l}>{LOCALE_CONFIG[l].nativeLabel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            onClick={signOut}
            className="h-7 w-7 flex items-center justify-center rounded-md text-sidebar-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
            title={t('auth.logout')}
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
