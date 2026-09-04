/**
 * LIVE PRESENCE (primary path) — subscribes the operator panel to the
 * operator-only presence channel `ws:{workspaceId}:operators` while the tab
 * is VISIBLE, and unsubscribes as soon as it is hidden or unmounted.
 *
 * Channel membership IS the presence signal: the backend reads it through
 * the Centrifugo presence API, so no periodic PostgreSQL write is needed to
 * keep an operator "online". Hiding the tab drops membership within seconds
 * — much faster and truer than the old 5-minute database lease timeout —
 * while the inbox realtime connection itself stays up.
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

    const channel = `ws:${workspaceId}:operators`;

    const join = async () => {
      if (disposed || sub || joining) return;
      joining = true;
      try {
        const provider = await resolveClientRealtimeProvider(workspaceId);
        if (provider.vendor !== 'centrifugo') return; // DB fallback handles it
        if (disposed || document.visibilityState !== 'visible') return;
        const s = await provider.subscribe(channel, {});
        if (disposed || document.visibilityState !== 'visible') {
          s.unsubscribe();
          return;
        }
        sub = s;
      } catch {
        /* presence is best-effort; the DB fallback covers failures */
      } finally {
        joining = false;
      }
    };

    const leave = () => {
      try {
        sub?.unsubscribe();
      } catch {
        /* ignore */
      }
      sub = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void join();
      else leave();
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
