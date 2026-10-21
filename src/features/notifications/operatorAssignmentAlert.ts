/**
 * "A conversation was assigned to you", in the web panel.
 *
 * Until now only the phone heard about an assignment (push/dispatch.ts): an
 * operator at their desk was handed a chat — by routing, by a colleague's
 * transfer, by a reassignment after a timeout — and the panel said nothing,
 * not even a sound, until the visitor wrote again.
 *
 * Fed by `inbox:conversation-event`, which useInboxListRealtime dispatches
 * for every operator event on the workspace inbox channel. An event that
 * moves a conversation to this operator, done by somebody else (routing has
 * no actor), rings the chime and shows:
 *   - a toast with "Open" while the tab is in front of them;
 *   - a browser notification when it is not (and the browser allows it),
 *     else the toast, which waits for them.
 * The operator's own preferences decide: "disable all", quiet hours, the
 * assignments switch (push_assignments) and, for the sound, "play a sound".
 */
import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { NotificationPrefs } from '@/lib/notifications-api';
import { assigneeQueryKey, isWithinQuietHours, notificationIcon } from './operatorBrowserNotification';
import { chimeAllowedByPrefs, playOperatorChime } from './operatorMessageSound';

export interface ConversationEventDetail {
  workspaceId?: string;
  payload?: {
    kind?: string;
    conversation_id?: string;
    workspace_id?: string;
    actor_id?: string | null;
    changes?: { assigned_to?: { from?: string | null; to?: string | null } | null } | null;
  } | null;
}

/** The assignee an event moves a conversation to; `undefined` when it does not say. */
export function assigneeChange(detail: ConversationEventDetail | null | undefined): string | null | undefined {
  const change = detail?.payload?.changes?.assigned_to;
  if (!change || typeof change !== 'object' || !('to' in change)) return undefined;
  return change.to ?? null;
}

/**
 * The conversation this event hands to the viewer, or null: an assignment
 * TO them, made by somebody else (or by routing, which has no actor), and
 * not one they already had.
 */
export function assignmentForViewer(
  detail: ConversationEventDetail | null | undefined,
  viewerId: string | null | undefined,
): string | null {
  const payload = detail?.payload;
  if (!payload || !viewerId || !payload.conversation_id) return null;
  if (assigneeChange(detail) !== viewerId) return null;
  if (payload.actor_id && payload.actor_id === viewerId) return null;
  if (payload.changes?.assigned_to?.from === viewerId) return null;
  return String(payload.conversation_id);
}

/** Whether the operator's preferences let an assignment alert through at all. */
export function assignmentAlertAllowed(prefs: NotificationPrefs | null | undefined, now: Date = new Date()): boolean {
  if (!prefs) return true;
  if (prefs.disable_all) return false;
  if (prefs.push_assignments === false) return false;
  return !isWithinQuietHours(prefs, now);
}

/** Keeps the one-conversation assignee cache (resolveAssignee) in step with realtime. */
export function rememberAssignee(qc: QueryClient, detail: ConversationEventDetail | null | undefined): void {
  const workspaceId = detail?.workspaceId ?? detail?.payload?.workspace_id;
  const conversationId = detail?.payload?.conversation_id;
  if (!workspaceId || !conversationId) return;
  const key = assigneeQueryKey(workspaceId, String(conversationId));
  const to = assigneeChange(detail);
  if (to !== undefined) {
    qc.setQueryData(key, to);
  } else if (detail?.payload?.changes && 'assigned_to' in detail.payload.changes) {
    // "assigned_to changed" without the new value: read it again next time.
    qc.removeQueries({ queryKey: key, exact: true });
  }
}

function isBeingWatched(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function useOperatorAssignmentAlerts(options: {
  workspaceId: string | undefined;
  viewerId: string | undefined;
  title: string;
  body: string;
  openLabel: string;
  onOpenConversation: (conversationId: string) => void;
}): void {
  const qc = useQueryClient();
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onEvent = (evt: Event) => {
      const detail = (evt as CustomEvent<ConversationEventDetail>).detail;
      const { workspaceId, viewerId, title, body, openLabel, onOpenConversation } = latest.current;
      if (!detail || !workspaceId) return;
      if (detail.workspaceId && detail.workspaceId !== workspaceId) return;
      rememberAssignee(qc, detail);

      const conversationId = assignmentForViewer(detail, viewerId);
      if (!conversationId) return;
      const prefs = qc.getQueryData<{ prefs: NotificationPrefs }>(['notification-prefs'])?.prefs ?? null;
      if (!assignmentAlertAllowed(prefs)) return;

      if (chimeAllowedByPrefs(prefs)) playOperatorChime();

      const open = () => onOpenConversation(conversationId);
      const canNotify = 'Notification' in window && Notification.permission === 'granted';
      if (!isBeingWatched() && canNotify) {
        try {
          const n = new Notification(title, {
            body,
            tag: `assigned-${conversationId}`,
            icon: notificationIcon(),
            badge: notificationIcon(),
          } as NotificationOptions);
          n.onclick = () => {
            try { window.focus(); open(); } catch { /* tab gone */ } finally { n.close(); }
          };
          return;
        } catch {
          // Fall through to the toast: some browsers throw instead of no-op.
        }
      }
      toast(title, {
        id: `assigned-${conversationId}`,
        description: body,
        action: { label: openLabel, onClick: open },
        duration: 10_000,
      });
    };
    window.addEventListener('inbox:conversation-event', onEvent);
    return () => window.removeEventListener('inbox:conversation-event', onEvent);
  }, [qc]);
}
