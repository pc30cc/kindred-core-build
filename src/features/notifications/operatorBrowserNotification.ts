/**
 * Operator-side browser notifications.
 *
 * Settings → Notifications asked for the browser's permission and then never
 * used it: nothing in this app has ever constructed a `Notification`. An
 * operator granted it, closed the tab, missed a customer, and came back to a
 * settings page that said their notifications were on. The chime was the only
 * thing that ever fired, and a chime is no use to a tab in the background of
 * another window.
 *
 * So this is the other half. Same event as the chime —
 * `inbox:new-message`, dispatched by `useInboxListRealtime` — and the same
 * preferences, which are the operator's own row for THIS surface: the phone
 * keeps its own.
 *
 * Only while the tab is not being looked at. A banner over the very
 * conversation list that is already redrawing itself is noise, and every
 * messaging app in the world agrees.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { NotificationPrefs } from '@/lib/notifications-api';

/** At most one banner per conversation per this long. */
const THROTTLE_MS = 4000;
/** Long enough to read at a glance; a lock-screen preview is not an essay. */
const PREVIEW_MAX = 140;

const lastShownAt = new Map<string, number>();

export interface IncomingMessageDetail {
  workspaceId?: string;
  conversation_id?: string;
  sender_type?: string;
  payload?: { text?: string; body?: string; sender_name?: string | null } | null;
}

/** Whether the operator is looking at this tab right now. */
function isBeingWatched(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  return document.hasFocus();
}

/**
 * Quiet hours, in the operator's own zone.
 *
 * The zone matters and used to be dropped: this page never sent one, so the
 * server evaluated a Tehran operator's 22:00–08:00 window in UTC and silenced
 * them from half past one in the morning. Here the browser's own clock is the
 * right one — it IS the operator's zone — so the comparison is local.
 */
export function isWithinQuietHours(
  prefs: Pick<NotificationPrefs, 'quiet_hours_enabled' | 'quiet_hours_start' | 'quiet_hours_end'>,
  now: Date = new Date(),
): boolean {
  if (!prefs.quiet_hours_enabled) return false;
  const start = parseHhMm(prefs.quiet_hours_start);
  const end = parseHhMm(prefs.quiet_hours_end);
  if (start == null || end == null || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end; // wraps past midnight
}

function parseHhMm(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Who a conversation belongs to, from whatever the list has already cached.
 *
 * The realtime event carries a conversation id and nothing about assignment,
 * and refetching the row to decide whether to draw a banner would be a
 * network round trip per message. The inbox list is already in the cache and
 * already carries `assigned_to`.
 *
 * `undefined` means "not in the cache" — a conversation this operator has
 * never had on screen. That is NOT the same as unassigned, so a scope that
 * would otherwise filter it out lets it through: the cost of one banner too
 * many is nothing beside the cost of a missed customer.
 */
export function assigneeFromCache(
  qc: QueryClient,
  workspaceId: string | undefined,
  conversationId: string,
): string | null | undefined {
  const caches = qc.getQueriesData<unknown>({
    queryKey: workspaceId ? ['conversations', workspaceId] : ['conversations'],
  });
  for (const [, value] of caches) {
    for (const row of flattenConversations(value)) {
      if (String(row.id) === conversationId) return row.assigned_to ?? null;
    }
  }
  return undefined;
}

/** The list endpoint is paged and has been reshaped before; be forgiving. */
function flattenConversations(value: unknown): Array<{ id: string; assigned_to?: string | null }> {
  if (!value) return [];
  if (Array.isArray(value)) return value as Array<{ id: string; assigned_to?: string | null }>;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.conversations)) {
    return obj.conversations as Array<{ id: string; assigned_to?: string | null }>;
  }
  if (Array.isArray(obj.pages)) {
    return (obj.pages as unknown[]).flatMap(flattenConversations);
  }
  return [];
}

/**
 * Whether this message is worth a banner, given the operator's scope.
 *
 * The browser has no mention information on this event, so 'mentions' is the
 * one scope it cannot honour by itself — and rather than guess, it shows
 * nothing under that setting and leaves mentions to the phone, which is told
 * by the server. 'none' is the operator saying so outright.
 */
export function passesScope(
  scope: NotificationPrefs['push_scope'],
  assignedTo: string | null | undefined,
  viewerId: string | undefined,
): boolean {
  if (scope === 'none' || scope === 'mentions') return false;
  if (scope === 'assigned') {
    if (assignedTo === undefined) return true; // unknown — never silently drop
    if (assignedTo === null) return false;
    return !!viewerId && assignedTo === viewerId;
  }
  return true;
}

/** The text a banner carries, or nothing when previews are off. */
export function previewText(detail: IncomingMessageDetail, showPreview: boolean): string | null {
  if (!showPreview) return null;
  const raw = detail.payload?.text ?? detail.payload?.body ?? '';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

/**
 * Mount once at the workspace shell, beside the chime.
 *
 * `title` and `fallbackBody` come from the caller so the copy is translated
 * by the app's own i18n rather than by a second table in here.
 */
export function useOperatorBrowserNotifications(options: {
  workspaceId: string | undefined;
  viewerId: string | undefined;
  title: string;
  fallbackBody: string;
  onOpenConversation?: (conversationId: string) => void;
}): void {
  const qc = useQueryClient();
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    const onIncoming = (evt: Event) => {
      const detail = (evt as CustomEvent<IncomingMessageDetail>).detail;
      if (!detail) return;

      const { workspaceId, viewerId, title, fallbackBody, onOpenConversation } = latest.current;
      if (detail.workspaceId && workspaceId && detail.workspaceId !== workspaceId) return;
      // Customer messages only — never an echo of the operator's own reply,
      // and never the AI answering on their behalf.
      if (detail.sender_type && detail.sender_type !== 'contact') return;

      if (Notification.permission !== 'granted') return;
      // The tab is open and being read. The list in front of them is already
      // updating; a banner on top of it is noise.
      if (isBeingWatched()) return;

      const cached = qc.getQueryData<{ prefs: NotificationPrefs }>(['notification-prefs']);
      const prefs = cached?.prefs;
      if (prefs) {
        if (prefs.disable_all) return;
        if (isWithinQuietHours(prefs)) return;
        const conversationId = detail.conversation_id ? String(detail.conversation_id) : '';
        const assignee = conversationId
          ? assigneeFromCache(qc, workspaceId, conversationId)
          : undefined;
        if (!passesScope(prefs.push_scope, assignee, viewerId)) return;
      }

      const key = detail.conversation_id ? String(detail.conversation_id) : 'workspace';
      const now = Date.now();
      const previous = lastShownAt.get(key) ?? 0;
      if (now - previous < THROTTLE_MS) return;
      lastShownAt.set(key, now);

      const body = previewText(detail, prefs?.push_preview !== false) ?? fallbackBody;

      try {
        const notification = new Notification(title, {
          body,
          // One banner per conversation: a customer sending three lines
          // replaces its own notification rather than stacking three.
          tag: `webyar-conversation-${key}`,
          renotify: false,
          icon: '/favicon-192.png',
          badge: '/favicon-192.png',
        } as NotificationOptions);

        notification.onclick = () => {
          try {
            window.focus();
            if (detail.conversation_id && onOpenConversation) {
              onOpenConversation(String(detail.conversation_id));
            }
          } catch {
            /* the tab may already be gone */
          } finally {
            notification.close();
          }
        };
      } catch {
        // Permission can be revoked between the check and the construction,
        // and some browsers throw rather than no-op. A missing banner is not
        // worth an unhandled rejection in the inbox.
      }
    };

    window.addEventListener('inbox:new-message', onIncoming as EventListener);
    return () => window.removeEventListener('inbox:new-message', onIncoming as EventListener);
  }, [qc]);
}
