/**
 * The operator's live Inbox, wherever they are in the panel.
 *
 * The workspace inbox subscription, the chime and the browser banner used to
 * be mounted by the Inbox page alone. An operator watching the Visitors page
 * or editing a canned reply in Settings is still "present" (the heartbeat
 * runs on every page, AppLayout), so routing hands them chats — and they
 * heard nothing, and the sidebar's counters stood still until the next focus.
 * The app shell mounts this once instead:
 *
 *   - useInboxListRealtime: the conversation lists and the sidebar's counters;
 *   - the chime and the banner for a visitor's message in a conversation that
 *     is this operator's to answer (passesScope);
 *   - the "assigned to you" alert;
 *   - the operator's notification preferences, read once, so all of them
 *     honour the settings without the Settings page having been opened.
 *
 * Only for members who have the Inbox (shared/chatRoles.ts): staff without
 * one are refused its channel and its routes.
 */
import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole';
import { useInboxListRealtime } from '@/hooks/useInboxListRealtime';
import { fetchNotificationPrefs } from '@/lib/notifications-api';
import { canSeeAllConversations, readStoredInboxScope } from '@/lib/inboxAccess';
import { canUseInbox } from '../../../shared/chatRoles';
import { useOperatorMessageChime } from './operatorMessageSound';
import { useOperatorBrowserNotifications } from './operatorBrowserNotification';
import { useOperatorAssignmentAlerts } from './operatorAssignmentAlert';

export function useOperatorInboxAlerts(workspaceId: string | undefined): void {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const { data: role, isSuccess: roleKnown } = useWorkspaceRole(workspaceId);
  const ws = workspaceId && roleKnown && canUseInbox(role) ? workspaceId : undefined;

  // Same key and shape as Settings → Notifications, which shares the entry.
  useQuery({
    queryKey: ['notification-prefs'],
    queryFn: fetchNotificationPrefs,
    enabled: !!ws,
    staleTime: 5 * 60_000,
  });

  useInboxListRealtime(ws);

  const roleRef = useRef(role);
  roleRef.current = role;
  // A supervisor who is watching "All conversations" hears colleagues' too.
  const othersVisible = useCallback(
    () => canSeeAllConversations(roleRef.current) && readStoredInboxScope() === 'all',
    [],
  );
  const openConversation = useCallback(
    (conversationId: string) => navigate(`${wsPath('/inbox')}?c=${encodeURIComponent(conversationId)}`),
    [navigate, wsPath],
  );

  useOperatorMessageChime(ws, { viewerId: user?.id, othersVisible });
  useOperatorBrowserNotifications({
    workspaceId: ws,
    viewerId: user?.id,
    title: t('notifications.browserTitle'),
    fallbackBody: t('notifications.browserFallback'),
    onOpenConversation: openConversation,
    othersVisible,
  });
  useOperatorAssignmentAlerts({
    workspaceId: ws,
    viewerId: user?.id,
    title: t('notifications.assignedTitle'),
    body: t('notifications.assignedBody'),
    openLabel: t('notifications.assignedOpen'),
    onOpenConversation: openConversation,
  });
}
