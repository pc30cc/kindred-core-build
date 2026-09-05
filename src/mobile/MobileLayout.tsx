/**
 * Native (iOS) app shell — fixed tab bar, no page-level scrolling.
 * Only mounted inside the Capacitor shell; the web dashboard keeps AppLayout.
 */
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { MessageCircle, Users, Radar, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace, useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useConversations } from '@/hooks/useConversations';
import { WorkspaceNotFound } from '@/features/workspace/WorkspaceNotFound';
import { cn } from '@/lib/utils';

export function MobileLayout() {
  const { t, dir } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const { notFound } = useActiveWorkspace();
  const workspace = useCurrentWorkspace();
  const { data: openConversations } = useConversations(workspace?.id, 'open', 'main');

  if (notFound) return <WorkspaceNotFound />;

  const unread = (openConversations ?? []).reduce(
    (sum: number, c: any) => sum + (c.unread_count || 0),
    0,
  );

  const tabs = [
    { to: `/${slug}/inbox`, icon: MessageCircle, label: t('nav.inbox'), badge: unread },
    { to: `/${slug}/contacts`, icon: Users, label: t('nav.contacts'), badge: 0 },
    { to: `/${slug}/visitors`, icon: Radar, label: t('nav.visitors'), badge: 0 },
    { to: `/${slug}/settings`, icon: SettingsIcon, label: t('nav.settings'), badge: 0 },
  ];

  return (
    <div dir={dir} className="fixed inset-0 flex flex-col overflow-hidden bg-muted/40">
      {/* Screens own their own scrolling; the shell never scrolls. */}
      <main className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </main>

      <nav className="shrink-0 bg-card/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_0_hsl(var(--border)/0.7)] backdrop-blur-2xl">
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
                  <span className="relative">
                    <tab.icon
                      className={cn(
                        'h-[23px] w-[23px] transition-transform duration-200',
                        isActive && 'scale-110',
                      )}
                      strokeWidth={isActive ? 2.4 : 1.9}
                    />
                    {tab.badge > 0 && (
                      <span className="absolute -end-2.5 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground ring-2 ring-card">
                        {tab.badge > 99 ? '99+' : tab.badge}
                      </span>
                    )}
                  </span>
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
