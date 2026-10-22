/**
 * Routing waits for the pre-chat form (DECISIONS §4: "keep the pre-chat
 * deferral, but route anyway after a grace period").
 *
 * When the workspace's pre-chat asks for details the visitor has not given
 * yet, neither an AI handoff (ai-agent/handoffState.ts) nor a visitor's
 * first message with no AI answering (chatRouting.ts
 * routeHumanBoundConversation) connects them to an operator at once: the
 * inline pre-chat card shouldn't be racing an "operator joined" notice. The
 * form's submission routes it (routes/widgetIdentity.ts); a form never sent
 * stops holding it PRECHAT_ROUTING_GRACE_MS later (the routing ticker,
 * chat_routing_state.prechat_deadline, migration 278).
 *
 * Its own module so the AI handoff and the routing engine share it without
 * importing each other.
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { patchConversationMetadata } from './conversationMetadata.js';

/** How long routing waits for the visitor's pre-chat form before routing anyway. */
export const PRECHAT_ROUTING_GRACE_MS = 2 * 60_000;

/**
 * True when the visitor is still looking at (or about to see) the pre-chat
 * form: a widget conversation (a channel never shows one), not deferred
 * before (a conversation gets its grace once: after it, the visitor's
 * messages route it at once), the form the workspace's visitors are actually
 * asked (shared/prechatPolicy.ts effectivePrechat: the Super Admin's policy,
 * the plan and the workspace's own row) has a timing other than "never" and
 * asks at least one field, and the contact has neither answered it (sent it,
 * even empty: `metadata.prechat_submitted_at`) nor given a real name, email or
 * phone some other way. Fails open (false = route now) on any lookup error so
 * a DB hiccup can never strand a conversation unrouted.
 */
export async function shouldDeferRoutingForPrechat(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const sb = getServiceClient(config);
    const { data: conv } = await sb
      .from('conversations')
      .select('contact_id, metadata')
      .eq('id', conversationId)
      .maybeSingle();
    const row = conv as { contact_id?: string | null; metadata?: Record<string, unknown> | null } | null;
    if (!row) return false;
    const meta = row.metadata || {};
    const channel = typeof meta.channel === 'string' ? meta.channel : '';
    if (channel && channel !== 'widget') return false;
    if (typeof meta.routing_pending_at === 'string') return false;

    // Loaded here: the effective form reads the widget's cached snapshots.
    const { loadEffectivePrechat } = await import('./widget/prechatEffective.js');
    const prechat = await loadEffectivePrechat(config, sb, workspaceId);
    if (prechat.timing === 'never') return false;
    if (!(prechat.ask_name || prechat.ask_email || prechat.ask_phone)) return false;

    if (!row.contact_id) return true;
    const { data: contact } = await sb
      .from('contacts')
      .select('name, email, phone, metadata')
      .eq('id', row.contact_id)
      .maybeSingle();
    if (!contact) return true;
    const who = contact as { name?: string | null; email?: string | null; phone?: string | null; metadata?: Record<string, unknown> | null };
    if (typeof who.metadata?.prechat_submitted_at === 'string') return false;
    // mergeVisitorIdentity() seeds an unidentified contact's name with the
    // literal placeholder 'Visitor' — a real pre-chat submission always
    // writes an actual field, so "still just the placeholder, no email/
    // phone either" means pre-chat genuinely hasn't happened yet.
    const hasReal = (who.name && who.name !== 'Visitor') || who.email || who.phone;
    return !hasReal;
  } catch {
    return false;
  }
}

/**
 * Routing waits for the pre-chat form: `metadata.routing_pending` (the
 * form's submission routes it) and a deadline PRECHAT_ROUTING_GRACE_MS on
 * (chat_routing_state), after which the ticker routes it anyway. The
 * deadline is best-effort: without it the form still routes it.
 */
export async function deferRoutingForPrechat(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  now: number = Date.now(),
): Promise<void> {
  await patchConversationMetadata(config, conversationId, {
    routing_pending: true,
    routing_pending_at: new Date(now).toISOString(),
  }, workspaceId);
  try {
    const { error } = await getServiceClient(config).rpc('chat_routing_defer_prechat', {
      p_workspace_id: workspaceId,
      p_conversation_id: conversationId,
      p_deadline: new Date(now + PRECHAT_ROUTING_GRACE_MS).toISOString(),
    });
    if (error) console.warn('[chat-routing] chat_routing_defer_prechat failed:', error.message);
  } catch { /* the form's submission still routes it */ }
}
