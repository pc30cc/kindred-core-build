import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Building2, Plug, Server,
  Flag, Palette, Globe, FileText, CreditCard, Shield,
  Database,
  ChevronLeft, ChevronRight, LogOut, ArrowLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/AuthContext';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

const adminNav = [
  { key: 'Dashboard', path: '/admin', icon: LayoutDashboard },
  { key: 'Users', path: '/admin/users', icon: Users },
  { key: 'Workspaces', path: '/admin/workspaces', icon: Building2 },
  { key: 'Providers', path: '/admin/providers', icon: Plug },
  { key: 'System', path: '/admin/system', icon: Server },
  { key: 'Feature Flags', path: '/admin/feature-flags', icon: Flag },
  { key: 'Branding', path: '/admin/branding', icon: Palette },
  { key: 'Domains', path: '/admin/domains', icon: Globe },
  { key: 'Audit Logs', path: '/admin/audit-logs', icon: FileText },
  { key: 'Billing', path: '/admin/billing', icon: CreditCard },
  { key: 'Database', path: '/admin/database', icon: Database },
  { key: 'Security', path: '/admin/security', icon: Shield },
] as const;

export function AdminSidebar() {
  const location = useLocation();
  const { signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  const isActive = (path: string) => {
    if (path === '/admin') return location.pathname === '/admin';
    return location.pathname.startsWith(path);
  };

  return (
    <aside
      className={cn(
        'flex h-screen flex-col border-e transition-all duration-200',
        'bg-slate-900 text-slate-200 border-slate-700',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      <div className="flex h-14 items-center justify-between px-4 border-b border-slate-700">
        {!collapsed && (
          <span className="text-sm font-bold tracking-wide text-red-400 uppercase">
            Super Admin
          </span>
        )}
        <button onClick={() => setCollapsed(!collapsed)} className="p-1 rounded hover:bg-slate-800">
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
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
                ? 'bg-slate-700 text-white font-medium'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white'
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{item.key}</span>}
          </Link>
        ))}
      </nav>

      <div className="border-t border-slate-700 p-2 space-y-1">
        <Link
          to="/app"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          {!collapsed && <span>Back to App</span>}
        </Link>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-3 text-slate-400 hover:text-white hover:bg-slate-800"
          onClick={signOut}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && <span>Sign Out</span>}
        </Button>
      </div>
    </aside>
  );
}
