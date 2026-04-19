/**
 * Phase 3/4 — Conversation events recorder.
 *
 * Centralized helper to write a normalized timeline row into
 * public.conversation_events. The Inbox UI reads from this table directly;
 * audit_logs is written separately and remains the compliance source of truth.
 *
 * Design rules:
 *  • Service-role only insert (RLS enforces this — never call from client).
 *  • Fail-safe: never throws. Timeline is best-effort; the underlying state
 *    change (status update, attachment, etc.) is still authoritative.
 *  • Event types are an open string union to keep extensibility cheap.
 *    Recognized values today:
 *      'created' | 'identified' | 'assigned' | 'unassigned'
 *      | 'status_changed' | 'priority_changed'
 *      | 'tag_added' | 'tag_removed'
 *      | 'ai_reply' | 'attachment_added'
 *      | 'resolved' | 'reopened'
 *      | 'note_added' | 'note_deleted'
 *  • actor_type taxonomy: 'agent' | 'visitor' | 'system' | 'ai'
 *
 * The widget MUST NOT read this table — operator-only by design.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

export type ConversationEventType =
  | 'created'
  | 'identified'
  | 'assigned'
  | 'unassigned'
  | 'status_changed'
  | 'priority_changed'
  | 'tag_added'
  | 'tag_removed'
  | 'ai_reply'
  | 'attachment_added'
  | 'resolved'
  | 'reopened'
  | 'note_added'
  | 'note_deleted';

export type ConversationActorType = 'agent' | 'visitor' | 'system' | 'ai';

export interface RecordEventInput {
  workspaceId: string;
  conversationId: string;
  eventType: ConversationEventType | string;
  actorType: ConversationActorType;
  actorId?: string | null;
  payload?: Record<string, unknown>;
}

export async function recordConversationEvent(
  config: ServerConfig,
  input: RecordEventInput,
): Promise<{ ok: boolean; id?: string; reason?: string }> {
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('conversation_events')
      .insert({
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        event_type: input.eventType,
        actor_type: input.actorType,
        actor_id: input.actorId ?? null,
        payload: input.payload ?? {},
      })
      .select('id')
      .single();
    if (error) {
      console.warn('[conversationEvents] insert failed:', error.message);
      return { ok: false, reason: error.message };
    }
    return { ok: true, id: data?.id };
  } catch (err: any) {
    console.warn('[conversationEvents] threw:', err?.message || err);
    return { ok: false, reason: err?.message || 'unknown_error' };
  }
}

/**
 * Convenience: also write the matching audit_logs row for compliance.
 * Compliance writes never depend on timeline writes succeeding and vice versa.
 */
export async function recordAuditAndEvent(
  config: ServerConfig,
  input: RecordEventInput & {
    auditEntityType?: string;
    auditAction: string;
    oldValue?: Record<string, unknown> | null;
    newValue?: Record<string, unknown> | null;
    ipAddress?: string | null;
  },
): Promise<void> {
  const sb = getServiceClient(config);
  // Audit log (compliance). Never blocks the event write.
  if (input.actorId) {
    sb.from('audit_logs')
      .insert({
        workspace_id: input.workspaceId,
        user_id: input.actorId,
        entity_type: input.auditEntityType ?? 'conversation',
        entity_id: input.conversationId,
        action: input.auditAction,
        old_value: input.oldValue ?? null,
        new_value: input.newValue ?? null,
        ip_address: input.ipAddress ?? null,
      })
      .then(({ error }) => {
        if (error) console.warn('[audit_logs] insert failed:', error.message);
      });
  }
  await recordConversationEvent(config, input);
}
