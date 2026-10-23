/**
 * The open thread stays read while the operator is reading it.
 *
 * A thread is marked seen when it is opened (InboxPage, MobileConversationPage).
 * A visitor message that arrives while it stays open used to stay unread
 * until the operator opened the thread again: correct as far as the server
 * knew, but the Inbox badge (useInboxUnread) then said "1" for the very chat
 * on the operator's screen. So each new visitor message in the open thread
 * is marked seen too, while the tab is being looked at (isBeingWatched): at
 * most one request a second, the last of a burst included. A message that
 * arrives while the tab is hidden or in the background stays unread, so the
 * badge and the tab title show it, until the operator comes back to the tab.
 */
import { useCallback, useEffect, useRef } from 'react';
import { isBeingWatched } from './operatorBrowserNotification';

/** At most one mark per this long; a burst ends with one more. */
export const KEEP_SEEN_THROTTLE_MS = 1000;

type Payload = { sender_type?: string; conversation_id?: string } | null | undefined;

/**
 * Returns the `onMessage` handler for the open thread's realtime
 * subscription (useInboxRealtime). `markSeen` is the mark-seen mutation's
 * `mutate`; the latest one is always used.
 */
export function useKeepThreadSeen(
  conversationId: string | null | undefined,
  markSeen: (conversationId: string) => void,
): (payload: Payload) => void {
  const markRef = useRef(markSeen);
  markRef.current = markSeen;
  const idRef = useRef(conversationId);
  idRef.current = conversationId;
  const state = useRef({ pending: false, lastAt: 0, timer: null as ReturnType<typeof setTimeout> | null });

  const mark = useCallback(() => {
    const id = idRef.current;
    if (!id) return;
    state.current.pending = false;
    state.current.lastAt = Date.now();
    markRef.current(id);
  }, []);

  const markThrottled = useCallback(() => {
    const s = state.current;
    if (s.timer) return; // the trailing mark is already on its way
    const wait = s.lastAt + KEEP_SEEN_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      mark();
      return;
    }
    s.timer = setTimeout(() => {
      s.timer = null;
      if (isBeingWatched()) mark();
      else s.pending = true;
    }, wait);
  }, [mark]);

  useEffect(() => {
    const s = state.current;
    // Back to the tab: what arrived meanwhile is read now, once.
    const onBack = () => {
      if (s.pending && isBeingWatched()) mark();
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => {
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
      // Another thread (or none): nothing of this one is owed any more.
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      s.pending = false;
      s.lastAt = 0;
    };
  }, [conversationId, mark]);

  return useCallback((payload: Payload) => {
    if (payload?.sender_type !== 'contact' || !idRef.current) return;
    if (payload.conversation_id && payload.conversation_id !== idRef.current) return;
    if (isBeingWatched()) markThrottled();
    else state.current.pending = true;
  }, [markThrottled]);
}
