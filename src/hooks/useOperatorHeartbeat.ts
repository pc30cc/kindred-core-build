/**
 * Sends a lightweight heartbeat every 2 minutes while the operator panel is
 * mounted — INCLUDING when the tab is hidden. The server uses each beat for:
 *   - ANALYTICS: at most one 5-minute bucket row for the "Operator activity"
 *     report (never a liveness signal).
 *   - LIVE PRESENCE FALLBACK: refreshing the `operator_presence_live` lease.
 *   - INTERNAL ACTIVITY: only when `interacted` is true, i.e. the operator
 *     really typed/clicked/focused since the last beat. Idle beats keep the
 *     connection alive but let internal presence fall to "away" after 5
 *     minutes.
 *
 * Each tab names itself in its beats (a random source id), and when the tab
 * goes away it says so with a beacon (R-11): `pagehide` (closing, reloading,
 * navigating away, or the page entering the back/forward cache), and on
 * iPhone and iPad also `visibilitychange` to hidden, since iOS often suspends
 * or discards a hidden page without any pagehide. The server then ends only
 * this tab's part of the lease (migration 282b), so routing stops picking an
 * operator who just left instead of for up to 5 minutes, while their other
 * tabs and the desktop app keep their own presence. Coming back (visible
 * again, or restored from the back/forward cache) beats at once under a new
 * id. A hidden tab on a computer is not "gone": it keeps beating.
 *
 * Nothing here influences customer-facing availability: a hidden tab, a
 * sleeping laptop or a dropped network never make the team look offline to
 * visitors. That is decided solely by manual status + personal schedule.
 */
import { useEffect } from 'react';
import { sendOperatorHeartbeat, sendOperatorLeave } from '@/lib/operator-activity-api';

/** One beat per 2 minutes: half the server liveness window, so a single
 *  missed beat never drops the operator offline. The server skips the
 *  analytics write when the 5-minute bucket is already recorded. */
const INTERVAL_MS = 120_000;

/** A new id for this tab's presence (server: 8–64 of [A-Za-z0-9_-]). */
export function newPresenceSourceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `tab-${crypto.randomUUID()}`;
  } catch { /* below */ }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * iPhone and iPad (every browser there is WebKit), where a hidden page is
 * suspended or discarded, often without a pagehide: the tab counts as gone
 * once hidden. iPadOS reports itself as a Mac with touch.
 */
export function leavesWhenHidden(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { platform?: string } | undefined =
  typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  if (!nav) return false;
  if (/iP(hone|od|ad)/.test(nav.userAgent || '')) return true;
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
}

export function useOperatorHeartbeat(workspaceId: string | undefined) {
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let source = newPresenceSourceId();
    // True between this tab's beacon and its return.
    let gone = false;
    const hiddenIsGone = leavesWhenHidden();

    // Cheap, passive interaction latch — no network traffic per event.
    let interacted = true;
    const markInteracted = () => { interacted = true; };
    const events = ['keydown', 'pointerdown', 'focus'] as const;
    for (const ev of events) window.addEventListener(ev, markInteracted, { passive: true });

    const beat = () => {
      if (cancelled || gone) return;
      const didInteract = interacted;
      interacted = false;
      void sendOperatorHeartbeat(workspaceId, didInteract, source);
    };

    const leave = () => {
      if (gone) return;
      gone = true;
      sendOperatorLeave(workspaceId, source);
      // The next beat is a new source: no stale write memo can skip it.
      source = newPresenceSourceId();
    };

    const comeBack = () => {
      if (cancelled || !gone) return;
      gone = false;
      interacted = true;
      beat();
    };

    const onPageHide = () => leave();
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) comeBack(); };
    const onVisibility = () => {
      if (!hiddenIsGone) return;
      if (document.visibilityState === 'hidden') leave();
      else if (document.visibilityState === 'visible') comeBack();
    };

    beat();
    const id = setInterval(beat, INTERVAL_MS);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      // The panel left this workspace (switched, signed out): this tab is
      // not here for it any more.
      leave();
      cancelled = true;
      clearInterval(id);
      for (const ev of events) window.removeEventListener(ev, markInteracted);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [workspaceId]);
}
