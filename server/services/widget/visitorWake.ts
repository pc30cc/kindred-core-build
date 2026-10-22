/**
 * Wakes the visitor's widget when an operator writes to them.
 *
 * The widget's runtime (the realtime subscription, the unread badge, the
 * toast beside the launcher) loads only when the visitor opens the panel, or
 * when the loader preloads it silently (a conversation is active on this
 * browser: the `gs_active` hint; a Smart Engagement rule). A visitor who
 * never opened the widget on this page, or whom an operator writes to first
 * (Visitors → Start chat), has nothing listening for the reply. What every
 * visitor page does hold open is the loader's presence socket, a
 * subscription to `vp:v2:<workspace>:<session>` (server-minted tokens, one
 * channel per session, no other visitor can read it). A publication there is
 * the loader's cue to preload the runtime silently, which then reads the
 * visitor's threads and their unread counts (badge, title, preview) and
 * subscribes to the conversation.
 *
 * The envelope carries nothing: `{ type: 'event', payload: { kind: 'wake' } }`,
 * no conversation id, no text, no operator. Centrifugo only (the presence
 * socket exists only there); with another realtime vendor, or none, the
 * visitor sees the reply when the runtime next loads. Best-effort and never
 * throws: the message row is the truth.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolvePublisher } from '../realtime/resolvePublisher.js';
import { buildVisitorPresenceChannelName } from '../realtime/types.js';

/** Sessions of the visitor woken at most (the conversation's own and the latest few: a session lives 30 min idle). */
export const WAKE_SESSIONS_MAX = 3;

export async function wakeVisitorWidget(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const { data: conv } = await sb
      .from('conversations')
      .select('visitor_session_id')
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const linked = (conv?.visitor_session_id as string | null | undefined) || null;
    if (!linked) return;

    const sessionIds = new Set<string>([linked]);
    const { data: session } = await sb
      .from('visitor_sessions')
      .select('visitor_id')
      .eq('id', linked)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const visitorId = (session?.visitor_id as string | null | undefined) || null;
    if (visitorId) {
      // The page the visitor is on now may be a newer session of the same
      // browser (a session ends after 30 minutes idle).
      const { data: recent } = await sb
        .from('visitor_sessions')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('visitor_id', visitorId)
        .order('last_seen_at', { ascending: false, nullsFirst: false })
        .limit(WAKE_SESSIONS_MAX);
      for (const r of (recent || []) as Array<{ id?: string | null }>) {
        if (r.id && sessionIds.size < WAKE_SESSIONS_MAX + 1) sessionIds.add(r.id);
      }
    }

    const publisher = await resolvePublisher(config, workspaceId);
    if (publisher.vendor !== 'centrifugo') return;
    await Promise.all(Array.from(sessionIds).map((sid) =>
      publisher.publish(buildVisitorPresenceChannelName(workspaceId, sid), { type: 'event', payload: { kind: 'wake' } })
        .catch(() => null)));
  } catch {
    // Waking is a convenience: the reply is stored and shows on the next load.
  }
}
