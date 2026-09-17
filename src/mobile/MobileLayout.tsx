/**
 * Native (iOS) app shell.
 *
 * A real UIKit shell rather than a page with a bottom nav:
 *   • a navigation stack that pushes and pops detail screens, with the system
 *     edge-swipe-back gesture (src/mobile/ios/NavStack.tsx),
 *   • a translucent tab bar that hides on a pushed screen, exactly as iOS
 *     hides it behind a detail view controller,
 *   • push registration and the server-authoritative app badge.
 *
 * The status bar tint and the launch-image handoff are NOT here: they are set
 * up in src/main.tsx, because they have to apply to the login screen too.
 *
 * Only mounted inside the Capacitor shell; the web dashboard keeps AppLayout.
 */
import { useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { MessageCircle, Users, Radar, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace, useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useConversations } from '@/hooks/useConversations';
import { WorkspaceNotFound } from '@/features/workspace/WorkspaceNotFound';
import { initNativePush, setPushNavigationHandler, syncBadge } from '@/lib/push/nativePush';
import { isNativePlatform } from '@/lib/native';
import { NavStack } from './ios/NavStack';
import { TabBar, type TabItem } from './ios/TabBar';

/** A pushed screen is one level deeper than its tab root. */
const DETAIL_ROUTE = /\/(inbox|contacts)\/[^/]+$|\/settings\/[^/]+$/;

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
    (sum: number, c: { unread_count?: number | null }) => sum + (c.unread_count || 0),
    0,
  );

  const tabs: TabItem[] = [
    { to: `/${slug}/inbox`, icon: MessageCircle, label: t('nav.inbox'), badge: unread },
    { to: `/${slug}/contacts`, icon: Users, label: t('nav.contacts'), badge: 0 },
    { to: `/${slug}/visitors`, icon: Radar, label: t('nav.visitors'), badge: 0 },
    { to: `/${slug}/settings`, icon: SettingsIcon, label: t('nav.settings'), badge: 0 },
  ];

  const isDetail = DETAIL_ROUTE.test(location.pathname);

  return (
    <div dir={dir} className="fixed inset-0 flex flex-col overflow-hidden bg-muted/40">
      {/* Screens own their own scrolling; the shell never scrolls. */}
      <main className="relative min-h-0 flex-1">
        <NavStack depth={isDetail ? 1 : 0} enabled={isNativePlatform()} rtl={dir === 'rtl'} />
      </main>

      {/* iOS hides the tab bar behind a pushed detail view; so do we, which
          also keeps it off the conversation composer. */}
      {!isDetail && <TabBar tabs={tabs} />}
    </div>
  );
}
