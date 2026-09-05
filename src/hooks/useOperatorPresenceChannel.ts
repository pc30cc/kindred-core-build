/**
 * INTERNAL LIVE PRESENCE — subscribes the operator panel to the operator-only
 * presence channel `ws:{workspaceId}:operators` for as long as the panel is
 * MOUNTED. Tab visibility is explicitly NOT a factor: switching tabs or
 * minimizing the browser keeps the subscription (and therefore the operator's
 * internal presence) alive. Only unmount/pagehide leaves the channel.
 *
 * Channel membership IS the internal connection signal: the backend reads it
 * through the Centrifugo presence API, so no periodic PostgreSQL write is
 * needed. It feeds `active`/`away`/`disconnected` for teammates ONLY —
 * customer-facing availability is computed from manual status + personal
 * schedule and never from this subscription.
 *
 * When the resolved provider is not Centrifugo (polling / disabled /
 * Supabase, which does not advertise presence), this hook is a no-op and the
 * server keeps using the `operator_presence_live` database fallback fed by
 * `useOperatorHeartbeat`.
 */
import { useEffect } from 'react';
import { resolveClientRealtimeProvider } from '@/realtime';
import type { RealtimeSubscription } from '@/realtime';

export function useOperatorPresenceChannel(workspaceId: string | undefined) {
  useEffect(() => {
    if (!workspaceId) return;
    let disposed = false;
    let sub: RealtimeSubscription | null = null;
    let joining = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const channel = `ws:${workspaceId}:operators`;

    const clearRetry = () => {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    };

    /**
     * Presence membership is the operator's ONLY realtime liveness signal, so
     * a silently failed subscribe used to pin an open panel to "offline" for
     * its whole session (a racing unsubscribe can tear down the shared socket
     * while this subscribe is in flight). Retry with backoff and re-join
     * whenever the transport reports it dropped.
     */
    const scheduleRetry = () => {
      if (disposed || retryTimer) return;
      const delay = Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void join();
      }, delay);
    };

    const join = async () => {
      if (disposed || sub || joining) return;
      joining = true;
      try {
        const provider = await resolveClientRealtimeProvider(workspaceId);
        if (provider.vendor !== 'centrifugo') return; // DB fallback handles it
        if (disposed) return;
        const s = await provider.subscribe(channel, {
          onStatus: (status: string) => {
            if (disposed) return;
            if (status === 'open') { attempt = 0; return; }
            if (status === 'error' || status === 'closed') {
              // Drop the handle so the next join() re-subscribes cleanly.
              try { sub?.unsubscribe(); } catch { /* ignore */ }
              sub = null;
              scheduleRetry();
            }
          },
        } as any);
        if (disposed) {
          s.unsubscribe();
          return;
        }
        sub = s;
      } catch {
        scheduleRetry();
      } finally {
        joining = false;
      }
    };

    const leave = () => {
      clearRetry();
      try {
        sub?.unsubscribe();
      } catch {
        /* ignore */
      }
      sub = null;
    };

    // Visibility is used ONLY to re-heal a dropped subscription when the
    // operator comes back — never to unsubscribe.
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sub) { attempt = 0; void join(); }
    };

    void join();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', leave);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [workspaceId]);
}

