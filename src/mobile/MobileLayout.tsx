/**
 * Native (iOS) app shell — fixed tab bar, no page-level scrolling.
 * Only mounted inside the Capacitor shell; the web dashboard keeps AppLayout.
 */
import { useEffect } from 'react';
import { NavLink, Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { MessageCircle, Users, Radar, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace, useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useConversations } from '@/hooks/useConversations';
import { WorkspaceNotFound } from '@/features/workspace/WorkspaceNotFound';
import { cn } from '@/lib/utils';
import { initNativePush, setPushNavigationHandler, syncBadge } from '@/lib/push/nativePush';

export function MobileLayout() {
  const { t, dir } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const { notFound } = useActiveWorkspace();
  const workspace = useCurrentWorkspace();
  const { data: openConversations } = useConversations(workspace?.id, 'open', 'main');
  const navigate = useNavigate();
  const location = useLocation();

  // Native push: permission + token registration once a workspace is known,
  // and notification taps routed to the EXACT conversation inside the mobile
  // routes (never the desktop dashboard). The payload IDs are routing hints
  // only — the conversation screen loads through the normal authorized API.
  useEffect(() => {
    if (!workspace?.id) return;
    void initNativePush(workspace.id);
    setPushNavigationHandler((target) => {
      if (target.workspaceId !== workspace.id) return;
      navigate(`/${slug}/inbox/${target.conversationId}`);
    });
    return () => setPushNavigationHandler(null);
  }, [workspace?.id, slug, navigate]);

  // Badge reconciles from the server whenever the inbox changes (read,
  // resolve, another device) instead of drifting from local increments.
  useEffect(() => {
    if (workspace?.id) void syncBadge(workspace.id);
  }, [workspace?.id, openConversations]);

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

  // Detail screens (a conversation thread, a contact card) are pushed
  // full-screen like a native navigation stack — the floating tab bar hides so
  // it can never sit on top of the composer.
  const isDetail = /\/(inbox|contacts)\/[^/]+$/.test(location.pathname);
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => location.pathname.startsWith(tab.to)),
  );

  return (
    <div dir={dir} className="fixed inset-0 flex flex-col overflow-hidden bg-muted/40">
      {/* Screens own their own scrolling; the shell never scrolls. */}
      <main className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </main>

      {!isDetail && (
        <nav
          className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-3"
          style={{
            paddingBottom: 'calc(max(6px, env(safe-area-inset-bottom) - 10px) + var(--kb-inset, 0px))',
          }}
        >
          <div className="pointer-events-auto relative mx-auto flex max-w-md items-stretch rounded-[26px] border border-border/60 bg-card/85 p-1.5 shadow-[0_10px_30px_-12px_hsl(220_40%_20%/0.45)] backdrop-blur-2xl">
            {/* The animated bubble slides between tabs. */}
            <span
              className="absolute inset-y-1.5 rounded-[20px] bg-primary/12 transition-[inset-inline-start] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{
                width: `calc(${100 / tabs.length}% - 12px)`,
                insetInlineStart: `calc(${(activeIndex * 100) / tabs.length}% + 6px)`,
              }}
            />
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) =>
                  cn(
                    'relative z-10 flex flex-1 flex-col items-center justify-center gap-1 rounded-[20px] py-2 transition-colors active:scale-95',
                    isActive ? 'text-primary' : 'text-muted-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span className="relative">
                      <tab.icon
                        className={cn(
                          'h-[22px] w-[22px] transition-transform duration-300',
                          isActive && '-translate-y-px scale-110',
                        )}
                        strokeWidth={isActive ? 2.4 : 1.9}
                      />
                      {tab.badge > 0 && (
                        <span className="absolute -end-2.5 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground ring-2 ring-card">
                          {tab.badge > 99 ? '99+' : tab.badge}
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        'text-[10.5px] leading-none transition-all',
                        isActive ? 'font-bold' : 'font-medium opacity-80',
                      )}
                    >
                      {tab.label}
                    </span>
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}

