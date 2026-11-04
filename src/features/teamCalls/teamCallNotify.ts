/**
 * The system notification of a ringing colleague call (TEAM_CALLS.md, "Web
 * panel"): shown through the Notification API while the tab is hidden, and
 * only when the member has allowed notifications. Permission is asked once,
 * from the call button (a click), never on page load. No web push: a closed
 * panel does not ring; the phones do.
 */
const ASKED_KEY = 'team_call_notify_asked';

function api(): typeof Notification | null {
  return typeof window !== 'undefined' && typeof window.Notification === 'function' ? window.Notification : null;
}

/** From the call button only: asks once, while the browser has no answer yet. */
export function askNotificationPermissionOnce(): void {
  const N = api();
  if (!N || N.permission !== 'default') return;
  try {
    if (window.localStorage.getItem(ASKED_KEY)) return;
    window.localStorage.setItem(ASKED_KEY, '1');
  } catch {
    // Without storage, the browser's own "default" state is the guard.
  }
  try {
    const answer = N.requestPermission();
    if (answer && typeof (answer as Promise<NotificationPermission>).catch === 'function') {
      (answer as Promise<NotificationPermission>).catch(() => { /* the member said nothing */ });
    }
  } catch { /* an old browser without the API's promise form */ }
}

export interface RingNotice {
  title: string;
  body: string;
  /** One notification per call: a second one for the same call replaces it. */
  tag: string;
  icon?: string | null;
  /** Called when the notification is actually shown. */
  onShown?: () => void;
}

/**
 * Shows the notification while the tab is hidden (now, or when it is hidden
 * later in the ring) and closes it when the tab comes back; the returned
 * function closes it for good. A click brings the tab forward.
 */
export function watchRingNotification(notice: RingNotice): () => void {
  const N = api();
  if (!N || typeof document === 'undefined') return () => {};
  let shown: Notification | null = null;
  const close = () => {
    try { shown?.close(); } catch { /* gone */ }
    shown = null;
  };
  const sync = () => {
    if (document.visibilityState !== 'hidden') {
      close();
      return;
    }
    if (shown || N.permission !== 'granted') return;
    try {
      shown = new N(notice.title, {
        body: notice.body,
        tag: notice.tag,
        requireInteraction: true,
        ...(notice.icon ? { icon: notice.icon } : {}),
      });
      shown.onclick = () => {
        try { window.focus(); } catch { /* not allowed */ }
        close();
      };
    } catch {
      shown = null;
    }
    if (shown) {
      try { notice.onShown?.(); } catch { /* the caller's own failure */ }
    }
  };
  sync();
  document.addEventListener('visibilitychange', sync);
  return () => {
    document.removeEventListener('visibilitychange', sync);
    close();
  };
}
