/**
 * Native (iOS) app shell — Telegram-style bottom tab bar.
 * Only mounted inside the Capacitor shell; the web dashboard keeps AppLayout.
 */
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { MessageCircle, Users, Radar, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { WorkspaceNotFound } from '@/features/workspace/WorkspaceNotFound';
import { cn } from '@/lib/utils';

export function MobileLayout() {
  const { t, dir } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const { notFound } = useActiveWorkspace();

  if (notFound) return <WorkspaceNotFound />;

  const tabs = [
    { to: `/${slug}/inbox`, icon: MessageCircle, label: t('nav.inbox') },
    { to: `/${slug}/contacts`, icon: Users, label: t('nav.contacts') },
    { to: `/${slug}/visitors`, icon: Radar, label: t('nav.visitors') },
    { to: `/${slug}/settings`, icon: SettingsIcon, label: t('nav.settings') },
  ];

  return (
    <div dir={dir} className="flex h-[100dvh] flex-col bg-background">
      <main className="flex-1 min-h-0 overflow-y-auto">
        <Outlet />
      </main>

      <nav className="shrink-0 border-t border-border bg-card/95 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-stretch">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                cn(
                  'flex-1 flex flex-col items-center justify-center gap-1 py-2 transition-colors',
                  isActive ? 'text-primary' : 'text-muted-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <tab.icon className={cn('h-6 w-6 transition-transform', isActive && 'scale-110')} />
                  <span className="text-[11px] font-medium leading-none">{tab.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
