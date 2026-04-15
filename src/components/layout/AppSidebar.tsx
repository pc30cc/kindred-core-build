import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useI18n } from '@/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { SUPPORTED_LOCALES, LOCALE_CONFIG } from '@/i18n/config';
import {
  Inbox, Users, Eye, BookOpen, MessageSquare,
  Bot, Settings, Rocket, Search, Package,
  LogOut, Shield, ChevronDown, UserPlus, Plus,
  Zap, ShieldAlert, ExternalLink, Bell, EyeOff,
  Clock, UserCog, Building2, HelpCircle, Sparkles,
  AlertCircle, Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/AuthContext';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useProfile } from '@/hooks/useProfile';
import { useMemo, useState, useRef, useEffect } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { CreateWorkspaceDialog } from '@/features/workspace/CreateWorkspaceDialog';

export function AppSidebar() {
  const { t, dir } = useTranslation();
  const { locale, setLocale } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const { signOut, user } = useAuth();
  const { data: isAdmin } = useIsGlobalAdmin();
  const { platformName } = useBrandingContext();
  const { workspace, workspaces } = useActiveWorkspace();
  const { data: profile } = useProfile();
  const wsPath = useWorkspacePath();
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const wsMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const brandLetter = useMemo(() => (platformName || 'A').charAt(0), [platformName]);

  // Close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) {
        setWsMenuOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    if (wsMenuOpen || userMenuOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [wsMenuOpen, userMenuOpen]);

  const isActive = (subPath: string) => {
    const fullPath = wsPath(subPath);
    if (subPath === '') return location.pathname === fullPath;
    if (subPath === '/settings') return location.pathname.includes('/settings');
    if (subPath === '/inbox') return location.pathname.includes('/inbox');
    return location.pathname.includes(subPath);
  };

  const mainNav = [
    { key: 'ai', path: '/ai', icon: Bot },
    { key: 'visitors', path: '/visitors', icon: Eye },
    { key: 'contacts', path: '/contacts', icon: Users },
    { key: 'knowledgeBase', path: '/knowledge-base', icon: BookOpen },
  ] as const;

  const bottomNav = [
    { key: 'search', path: '#', icon: Search },
    { key: 'widget', path: '/widget', icon: Package },
    { key: 'settings', path: '/settings/general', icon: Settings },
  ] as const;

  const userName = (user?.metadata?.full_name as string) || user?.email?.split('@')[0] || '';
  const userEmail = user?.email || '';
  const companyName = profile?.company_name || workspace?.name || platformName || 'Workspace';
  const workspaceDomain = profile?.website_domain || '';
  const companyLetter = companyName.charAt(0).toUpperCase();

  return (
    <aside className="flex h-screen w-[220px] flex-col bg-sidebar border-e border-sidebar-border">
      {/* Workspace header with dropdown */}
      <div className="relative px-3 pt-4 pb-2" ref={wsMenuRef}>
        <button
          onClick={() => setWsMenuOpen(!wsMenuOpen)}
          className="flex items-center gap-2.5 w-full rounded-lg px-2 py-2 hover:bg-sidebar-accent/50 transition-colors"
        >
          <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center shrink-0">
            <span className="text-sm font-bold text-primary-foreground">{companyLetter}</span>
          </div>
          <div className="min-w-0 text-start flex-1">
            <p className="text-sm font-semibold text-sidebar-foreground truncate">{companyName}</p>
            <p className="text-[11px] text-sidebar-muted-foreground truncate">{workspaceDomain}</p>
          </div>
          <ChevronDown className={cn('h-3.5 w-3.5 text-sidebar-muted-foreground shrink-0 transition-transform', wsMenuOpen && 'rotate-180')} />
        </button>

        {/* Dropdown menu */}
        {wsMenuOpen && (
          <div className="absolute start-3 end-3 top-full mt-1 z-50 bg-popover border border-border rounded-xl shadow-xl py-2 animate-fade-in max-h-[60vh] overflow-y-auto">
            {/* Workspace list */}
            {workspaces.map(ws => {
              const isCurrentWs = workspace?.id === ws.id;
              return (
                <button
                  key={ws.id}
                  onClick={() => { navigate(`/app/w/${ws.slug}`); setWsMenuOpen(false); }}
                  className={cn(
                    'flex items-center gap-2.5 w-full px-3 py-2 text-sm rounded-md transition-colors',
                    isCurrentWs ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent'
                  )}
                >
                  <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0">
                    <span className="text-xs font-bold text-primary-foreground">{ws.name.charAt(0).toUpperCase()}</span>
                  </div>
                  <div className="min-w-0 flex-1 text-start">
                    <p className="text-[13px] font-medium truncate">{ws.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{ws.slug}</p>
                  </div>
                  {isCurrentWs && <Check className="h-4 w-4 text-primary shrink-0" />}
                </button>
              );
            })}

            <div className="border-t border-border mt-1.5 pt-1.5">
              <button className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-foreground hover:bg-accent rounded-md transition-colors">
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Plus className="h-3.5 w-3.5 text-primary" />
                </div>
                <div className="text-start">
                  <p className="text-[13px] font-medium">Create a new workspace</p>
                </div>
              </button>

              <button className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-foreground hover:bg-accent rounded-md transition-colors">
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <UserPlus className="h-3.5 w-3.5 text-primary" />
                </div>
                <div className="text-start">
                  <p className="text-[13px] font-medium">{t('nav.inviteOperator') || 'Invite an operator'}</p>
                </div>
              </button>
            </div>

            {workspaceDomain && (
              <div className="border-t border-border mt-1.5 pt-1.5">
                <a
                  href={`https://${workspaceDomain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground rounded-md transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span className="text-[13px]">{workspaceDomain}</span>
                </a>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Get Started button */}
      <div className="px-3 mb-1">
        <Link
          to={wsPath('')}
          className={cn(
            'flex items-center justify-between rounded-lg px-3 py-2 text-sm font-semibold transition-all',
            isActive('')
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'bg-primary/10 text-primary hover:bg-primary/15'
          )}
        >
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4 shrink-0" />
            <span>{t('wizard.getStarted')}</span>
          </div>
          <span className="bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">10</span>
        </Link>
      </div>

      {/* Inbox section */}
      <div className="px-3 mt-2">
        <Link
          to={wsPath('/inbox')}
          className={cn(
            'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all',
            isActive('/inbox')
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
          )}
        >
          <Inbox className="h-[18px] w-[18px] shrink-0" />
          <span>{t('nav.inbox')}</span>
        </Link>

        {isActive('/inbox') && (
          <div className="ms-5 mt-0.5 space-y-0.5 border-s border-sidebar-border ps-3">
            <p className="text-[11px] font-medium text-sidebar-muted-foreground uppercase tracking-wider px-2 pt-1.5 pb-1">Default Inboxes</p>
            <Link
              to={wsPath('/inbox')}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors',
                location.pathname === wsPath('/inbox')
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
              )}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0" />
              <span>Main Inbox</span>
            </Link>

            <p className="text-[11px] font-medium text-sidebar-muted-foreground uppercase tracking-wider px-2 pt-2 pb-1">Other Inboxes</p>
            <button className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors w-full">
              <Zap className="h-3.5 w-3.5 shrink-0" />
              <span>Automated</span>
            </button>
            <button className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors w-full">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
              <span>Spam</span>
            </button>
          </div>
        )}
      </div>

      {/* Main navigation */}
      <nav className="flex-1 overflow-y-auto pt-3 px-3 space-y-0.5">
        {mainNav.map(item => (
          <Link
            key={item.key}
            to={wsPath(item.path)}
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
            to={item.path === '#' ? '#' : wsPath(item.path)}
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

      {/* User profile — click to open menu */}
      <div className="relative border-t border-sidebar-border px-3 py-3" ref={userMenuRef}>
        {/* User menu dropdown — opens upward */}
        {userMenuOpen && (
          <div className="absolute start-2 end-2 bottom-full mb-2 z-50 bg-popover border border-border rounded-xl shadow-2xl py-1 animate-fade-in max-h-[70vh] overflow-y-auto">
            {/* User info header */}
            <div className="px-4 py-3 border-b border-border flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center shrink-0">
                <span className="text-sm font-bold text-primary-foreground">{userName.charAt(0).toUpperCase()}</span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{userName}</p>
                <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
              </div>
            </div>

            {/* Verify email alert */}
            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm hover:bg-accent transition-colors">
              <AlertCircle className="h-4 w-4 text-warning shrink-0" />
              <span className="text-warning font-medium">{t('auth.verifyEmail')}</span>
            </button>

            <div className="border-t border-border my-1" />

            {/* Main actions */}
            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.viewAlerts') || 'View alerts'}</span>
            </button>
            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors">
              <EyeOff className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.invisibleMode') || 'Enable invisible mode'}</span>
            </button>
            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.availability') || 'Availability settings'}</span>
            </button>

            <div className="border-t border-border my-1" />

            <RouterLink
              to={wsPath('/settings/profile')}
              onClick={() => setUserMenuOpen(false)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors"
            >
              <UserCog className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.manageAccount') || 'Manage account'}</span>
            </RouterLink>
            <RouterLink
              to={wsPath('/settings/general')}
              onClick={() => setUserMenuOpen(false)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors"
            >
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.workspaceSettings') || 'Workspace settings'}</span>
            </RouterLink>
            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors">
              <UserPlus className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.inviteOperator') || 'Invite an operator'}</span>
            </button>

            <div className="border-t border-border my-1" />

            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm hover:bg-accent transition-colors">
              <HelpCircle className="h-4 w-4 text-primary" />
              <span className="text-primary font-medium">{t('nav.getHelp') || `Get help using ${platformName}`}</span>
            </button>
            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.whatsNew') || "What's new?"}</span>
            </button>

            <div className="border-t border-border my-1" />

            <button
              onClick={() => { setUserMenuOpen(false); signOut(); }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            >
              <LogOut className="h-4 w-4" />
              <span>{t('auth.logout')}</span>
            </button>
          </div>
        )}

        {/* Clickable user row */}
        <button
          onClick={() => setUserMenuOpen(!userMenuOpen)}
          className="flex items-center gap-2.5 w-full rounded-lg px-1 py-1 hover:bg-sidebar-accent/50 transition-colors"
        >
          <div className="relative">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <span className="text-xs font-semibold text-primary">{userName.charAt(0).toUpperCase()}</span>
            </div>
            <div className="absolute -bottom-0.5 -end-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-sidebar" />
          </div>
          <div className="min-w-0 flex-1 text-start">
            <p className="text-xs font-medium text-sidebar-foreground truncate">{userName}</p>
            <p className="text-[11px] text-sidebar-muted-foreground truncate">{userEmail}</p>
          </div>
        </button>

        {/* Language selector — always visible below user */}
        <div className="mt-2">
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="h-7 text-xs w-full border-sidebar-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LOCALES.map(l => (
                <SelectItem key={l} value={l}>{LOCALE_CONFIG[l].nativeLabel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </aside>
  );
}
