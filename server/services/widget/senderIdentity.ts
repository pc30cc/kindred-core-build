/**
 * THE ONE PLACE A VISITOR-FACING MESSAGE GETS ITS SENDER IDENTITY.
 *
 * A message row records WHO sent it (`sender_id`, `sender_type`) but not what
 * they look like: the operator's name lives on their profile and their avatar
 * is derived from a storage key, and the AI agent's name and logo live on the
 * workspace's agent settings. The widget cannot do those lookups — it has no
 * credentials and no tenancy — so every route that hands messages to a
 * visitor must resolve them server-side and put `sender_name` /
 * `sender_avatar` on each row.
 *
 * This used to live inside routes/widget.ts, private to `/poll` and
 * `/history`. `GET /identity/history` — the endpoint the widget calls when it
 * opens and replays an existing thread — served the same messages WITHOUT it,
 * so a restored conversation drew no operator avatar at all, and no AI logo
 * once the row-level URL snapshot was removed. Extracting it here makes the
 * omission impossible to repeat by accident: there is one helper, and every
 * visitor-facing message route calls it.
 *
 * It also applies the visitor-visibility filter, so an internal staffing
 * notice can never leave through a route that forgot to filter.
 */

import type { ServerConfig } from '../../config.js';
import { hydrateUserAvatars } from '../storage/urlResolver.js';
import { resolveAgentLogoUrl } from '../ai-agent/settings.js';
import { filterVisitorVisibleMessages } from '../../routes/widgetAttachments.js';
import { getWorkspaceWidgetSnapshot } from './configSnapshot.js';
import { listCustomerAvailableOperators } from './customerAvailability.js';

export interface OperatorIdentity {
  name: string | null;
  avatar: string | null;
}

/**
 * Name and avatar of each operator id, in ONE profile read for the whole
 * list (a thread, or the visitor's list of conversations). Ids without a
 * profile are absent from the map; a failed read is an empty map (the
 * widget then shows the workspace instead of a person).
 */
export async function resolveOperatorIdentities(
  config: ServerConfig,
  supabase,
  ids: Array<string | null | undefined>,
): Promise<Map<string, OperatorIdentity>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => !!id)));
  const out = new Map<string, OperatorIdentity>();
  if (!unique.length) return out;
  try {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, avatar_storage_key')
      .in('id', unique);
    // Derived from the stored key for the provider that is primary now —
    // one resolution for the whole list.
    await hydrateUserAvatars(config, (profiles || []));
    (profiles || []).forEach((p) => {
      out.set(p.id, { name: p.full_name || null, avatar: p.avatar_url || null });
    });
  } catch (e) {
    console.warn('[widget-sender-enrich] profile lookup failed:', e?.message || e);
  }
  return out;
}

/**
 * The operators a visitor may consider reachable right now (the same
 * customer availability the widget's team dots follow), from the cached
 * workspace snapshot: no query on a cache hit. Cosmetic, so any failure is
 * "nobody shown online".
 */
export async function availableOperatorIds(
  config: ServerConfig,
  workspaceId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  try {
    const snap = await getWorkspaceWidgetSnapshot(config, workspaceId);
    const { available } = await listCustomerAvailableOperators(config, workspaceId, now, snap.availabilityPrefs);
    return new Set(available.map((a) => a.user_id));
  } catch {
    return new Set();
  }
}

/**
 * Resolve operator profile (full_name + avatar_url) for any agent/ai message.
 * Single batched lookup keeps /poll and /history fast even on long threads.
 * Visitor + system messages are passed through unchanged.
 */
export async function enrichMessagesWithSender(
  config: ServerConfig,
  supabase,
  messages,
  workspaceId?: string | null,
): Promise<unknown[]> {
  if (!messages || !messages.length) return messages || [];
  // Internal staffing notices (assignment transfers) never reach the visitor.
  // Canonical helper — see widgetAttachments.ts's filterVisitorVisibleMessages
  // doc comment for why this must be the ONE place this rule lives. Callers
  // may also apply it directly; it is idempotent.
  messages = filterVisitorVisibleMessages(messages);
  if (!messages.length) return messages;

  const ids = Array.from(new Set<string>(
    messages
      .filter((m) => m._sender_id && (m.role === 'agent' || m.sender_type === 'agent' || m.sender_type === 'ai'))
      .map((m) => m._sender_id as string)
  ));
  const profileMap = await resolveOperatorIdentities(config, supabase, ids);
  // AI messages have no operator profile — their identity comes from the
  // agent settings (name + logo). Older rows may predate the metadata
  // snapshot, so fall back to the workspace's current agent settings.
  let aiDisplay: { name: string | null; avatar: string | null } | null = null;
  const hasAi = messages.some((m) => m.sender_type === 'ai');
  if (hasAi && workspaceId) {
    try {
      const { data: s } = await supabase
        .from('ai_agent_settings')
        .select('agent_name, agent_logo_url, metadata')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (s) aiDisplay = { name: s.agent_name || null, avatar: await resolveAgentLogoUrl(config, workspaceId, s) };
    } catch (e) {
      console.warn('[widget-sender-enrich] ai settings lookup failed:', e?.message || e);
    }
  }
  return messages.map((m) => {
    if (m.sender_type === 'ai') {
      const { _sender_id: _ignored, ...rest } = m;
      const meta = (m.metadata && typeof m.metadata === 'object') ? m.metadata : {};
      return {
        ...rest,
        sender_name: meta.agent_name || aiDisplay?.name || null,
        // No `meta.agent_logo_url` fallback: a provider URL is no longer
        // snapshotted into a message row (see ai-agent/responder.ts).
        sender_avatar: aiDisplay?.avatar || null,
      };
    }
    const { _sender_id, ...rest } = m;
    if (m.role === 'agent' || m.sender_type === 'agent' || m.sender_type === 'ai') {
      const profile = _sender_id ? profileMap.get(_sender_id) : null;
      return {
        ...rest,
        sender_name: profile?.name || null,
        sender_avatar: profile?.avatar || null,
      };
    }
    return rest;
  });
}
