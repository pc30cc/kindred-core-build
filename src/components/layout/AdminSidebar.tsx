import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Building2, Plug, Server,
  Flag, Palette, Globe, FileText, CreditCard, Shield,
  Database, Crown, MessageSquare, MapPin, PhoneCall,
  ChevronLeft, ChevronRight, LogOut, ArrowLeft, ArrowRight, Activity, Video, Sparkles,
  X, ShieldCheck,

} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

const adminNav = [
  { group: 'overview', key: 'dashboard', path: '/admin', icon: LayoutDashboard },
  { group: 'overview', key: 'users', path: '/admin/users', icon: Users },
  { group: 'overview', key: 'workspaces', path: '/admin/workspaces', icon: Building2 },
  { group: 'platform', key: 'providers', path: '/admin/providers', icon: Plug },
  { group: 'platform', key: 'mapGeo', path: '/admin/map-geo', icon: MapPin },
  { group: 'experience', key: 'widgetSettings', path: '/admin/widget-settings', icon: MessageSquare },
  { group: 'experience', key: 'voiceVideo', path: '/admin/voice-video', icon: Video },
  { group: 'experience', key: 'callCenter', path: '/admin/call-center', icon: PhoneCall },
  { group: 'experience', key: 'aiAgent', path: '/admin/ai-agent', icon: Sparkles },
  { group: 'experience', key: 'aiBilling', path: '/admin/ai-billing', icon: CreditCard },
  { group: 'operations', key: 'system', path: '/admin/system', icon: Server },
  { group: 'operations', key: 'observability', path: '/admin/observability', icon: Activity },
  { group: 'operations', key: 'featureFlags', path: '/admin/feature-flags', icon: Flag },
  { group: 'operations', key: 'plugins', path: '/admin/plugins', icon: Plug },
  { group: 'governance', key: 'branding', path: '/admin/branding', icon: Palette },
  { group: 'governance', key: 'domains', path: '/admin/domains', icon: Globe },
  { group: 'governance', key: 'auditLogs', path: '/admin/audit-logs', icon: FileText },
  { group: 'governance', key: 'billing', path: '/admin/billing', icon: CreditCard },
  { group: 'governance', key: 'plans', path: '/admin/plans', icon: Crown },
  { group: 'governance', key: 'database', path: '/admin/database', icon: Database },
  { group: 'governance', key: 'security', path: '/admin/security', icon: Shield },
] as const;

export function AdminSidebar({ mobileOpen = false, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  const location = useLocation();
  const { signOut } = useAuth();
  const { t, dir } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  const isActive = (path: string) => {
    if (path === '/admin') return location.pathname === '/admin';
    return location.pathname.startsWith(path);
  };

  const isRtl = dir === 'rtl';
  const CollapseIcon = isRtl
    ? (collapsed ? ChevronLeft : ChevronRight)
    : (collapsed ? ChevronRight : ChevronLeft);
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;

  let lastGroup = '';
  const content = (
    <aside
      className={cn(
        'flex h-dvh flex-col border-e border-border/70 bg-sidebar/95 text-sidebar-foreground shadow-2xl shadow-black/10 backdrop-blur-xl transition-[width] duration-300',
        collapsed ? 'w-[4.5rem]' : 'w-72'
      )}
    >
      <div className="flex h-16 items-center justify-between border-b border-border/70 px-3">
        {!collapsed && (
          <div className="flex min-w-0 items-center gap-3 px-1">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-violet-500 text-primary-foreground shadow-lg shadow-primary/20"><ShieldCheck className="h-5 w-5" /></span>
            <div className="min-w-0"><p className="truncate text-sm font-bold">{t('admin.nav.title' as any)}</p><p className="truncate text-[11px] text-sidebar-muted-foreground">{t('admin.nav.platformManagement' as any)}</p></div>
          </div>
        )}
        <button onClick={() => setCollapsed(!collapsed)} className="hidden rounded-lg p-2 text-sidebar-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground lg:block" aria-label={t('admin.nav.collapseMenu' as any)}>
          <CollapseIcon className="h-4 w-4" />
        </button>
        <button onClick={onMobileClose} className="rounded-lg p-2 text-sidebar-muted-foreground hover:bg-sidebar-accent lg:hidden" aria-label={t('admin.nav.closeMenu' as any)}><X className="h-5 w-5" /></button>
      </div>

      <nav className="admin-scrollbar flex-1 overflow-y-auto px-2 py-3">
        {adminNav.map(item => {
          const showGroup = !collapsed && item.group !== lastGroup;
          lastGroup = item.group;
          return <div key={item.key}>
          {showGroup && <p className="mb-1 mt-4 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-muted-foreground first:mt-1">{t(`admin.nav.groups.${item.group}` as any)}</p>}
          <Link
            key={item.key}
            to={item.path}
            onClick={onMobileClose}
            title={collapsed ? t(`admin.nav.${item.key}` as any) : undefined}
            className={cn(
              'group relative mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all duration-200',
              isActive(item.path)
                ? 'bg-primary/12 font-semibold text-primary shadow-sm ring-1 ring-primary/15'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/80 hover:text-sidebar-accent-foreground'
            )}
          >
            {isActive(item.path) && <span className="absolute inset-y-2 start-0 w-0.5 rounded-full bg-primary" />}
            <item.icon className="h-[18px] w-[18px] shrink-0 transition-transform group-hover:scale-105" />
            {!collapsed && <span className="truncate">{t(`admin.nav.${item.key}` as any)}</span>}
          </Link>
          </div>;
        })}
      </nav>

      <div className="space-y-1 border-t border-border/70 bg-sidebar-accent/20 p-2">
        <Link
          to="/app"
          className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-sidebar-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <BackIcon className="h-4 w-4 shrink-0" />
          {!collapsed && <span>{t('admin.nav.backToApp' as any)}</span>}
        </Link>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-3 rounded-xl text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={signOut}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && <span>{t('auth.logout')}</span>}
        </Button>
      </div>
    </aside>
  );
  return <>
    <div className="hidden lg:block">{content}</div>
    {mobileOpen && <button className="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm lg:hidden" onClick={onMobileClose} aria-label={t('admin.nav.closeMenu' as any)} />}
    <div className={cn('fixed inset-y-0 start-0 z-50 transition-transform duration-300 lg:hidden', mobileOpen ? 'translate-x-0' : isRtl ? 'translate-x-full' : '-translate-x-full')}>{content}</div>
  </>;
}
