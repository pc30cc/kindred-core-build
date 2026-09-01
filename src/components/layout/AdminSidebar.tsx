import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Building2, Plug, Server,
  Flag, Palette, Globe, FileText, CreditCard, Shield,
  Database, Crown, MessageSquare, MapPin, PhoneCall,
  ChevronLeft, ChevronRight, LogOut, ArrowLeft, ArrowRight, Activity, Video, Sparkles,

} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

const adminNav = [
  { key: 'dashboard', path: '/admin', icon: LayoutDashboard },
  { key: 'users', path: '/admin/users', icon: Users },
  { key: 'workspaces', path: '/admin/workspaces', icon: Building2 },
  { key: 'providers', path: '/admin/providers', icon: Plug },
  { key: 'mapGeo', path: '/admin/map-geo', icon: MapPin },
  { key: 'widgetSettings', path: '/admin/widget-settings', icon: MessageSquare },
  { key: 'voiceVideo', path: '/admin/voice-video', icon: Video },
  { key: 'callCenter', path: '/admin/call-center', icon: PhoneCall },
  { key: 'aiAgent', path: '/admin/ai-agent', icon: Sparkles },
  { key: 'aiBilling', path: '/admin/ai-billing', icon: CreditCard },
  { key: 'system', path: '/admin/system', icon: Server },
  { key: 'observability', path: '/admin/observability', icon: Activity },
  { key: 'featureFlags', path: '/admin/feature-flags', icon: Flag },
  { key: 'plugins', path: '/admin/plugins', icon: Plug },
  { key: 'branding', path: '/admin/branding', icon: Palette },
  { key: 'domains', path: '/admin/domains', icon: Globe },
  { key: 'auditLogs', path: '/admin/audit-logs', icon: FileText },
  { key: 'billing', path: '/admin/billing', icon: CreditCard },
  { key: 'plans', path: '/admin/plans', icon: Crown },
  { key: 'database', path: '/admin/database', icon: Database },
  { key: 'security', path: '/admin/security', icon: Shield },
] as const;

export function AdminSidebar() {
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

  return (
    <aside
      className={cn(
        'flex h-screen flex-col border-e transition-all duration-200',
        'bg-sidebar text-sidebar-foreground border-border',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      <div className="flex h-14 items-center justify-between px-4 border-b border-border">
        {!collapsed && (
          <span className="text-sm font-bold tracking-wide text-primary uppercase">
            {t('admin.nav.title' as any)}
          </span>
        )}
        <button onClick={() => setCollapsed(!collapsed)} className="p-1 rounded hover:bg-sidebar-accent">
          <CollapseIcon className="h-4 w-4" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
        {adminNav.map(item => (
          <Link
            key={item.key}
            to={item.path}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              isActive(item.path)
                ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{t(`admin.nav.${item.key}` as any)}</span>}
          </Link>
        ))}
      </nav>

      <div className="border-t border-border p-2 space-y-1">
        <Link
          to="/app"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
        >
          <BackIcon className="h-4 w-4 shrink-0" />
          {!collapsed && <span>{t('admin.nav.backToApp' as any)}</span>}
        </Link>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-3 text-sidebar-muted-foreground hover:text-sidebar-accent-foreground hover:bg-sidebar-accent"
          onClick={signOut}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && <span>{t('auth.logout')}</span>}
        </Button>
      </div>
    </aside>
  );
}
