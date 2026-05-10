import { NavLink, Outlet, useParams } from 'react-router-dom';
import { LayoutDashboard, ListOrdered, Phone, PhoneCall, Code2, Settings as SettingsIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { to: '', icon: LayoutDashboard, label: 'Overview', end: true },
  { to: 'queue', icon: ListOrdered, label: 'Live Queue' },
  { to: 'calls', icon: Phone, label: 'Calls' },
  { to: 'callbacks', icon: PhoneCall, label: 'Callbacks' },
  { to: 'install', icon: Code2, label: 'Install' },
  { to: 'settings', icon: SettingsIcon, label: 'Settings' },
];

export function CallCenterLayout() {
  const { slug } = useParams();
  const base = `/app/w/${slug}/call-center`;
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-semibold">Call Center</h1>
        <p className="text-xs text-muted-foreground">Standalone voice & video module.</p>
      </header>
      <nav className="flex gap-1 border-b border-border px-4">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            end={t.end as any}
            to={t.to ? `${base}/${t.to}` : base}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors',
                isActive
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )
            }
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </NavLink>
        ))}
      </nav>
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}