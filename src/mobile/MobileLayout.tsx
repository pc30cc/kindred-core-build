/**
 * Native (iOS) app shell — fixed tab bar, no page-level scrolling.
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
    <div dir={dir} className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      {/* Screens own their own scrolling; the shell never scrolls. */}
      <main className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </main>

      <nav className="shrink-0 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
        <div className="flex items-stretch">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                cn(
                  'flex flex-1 flex-col items-center justify-center gap-1 pb-1.5 pt-2 transition-colors',
                  isActive ? 'text-primary' : 'text-muted-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <tab.icon
                    className={cn('h-[22px] w-[22px] transition-transform', isActive && 'scale-110')}
                    strokeWidth={isActive ? 2.4 : 1.9}
                  />
                  <span className="text-[10.5px] font-medium leading-none">{tab.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
