/**
 * Phase 3/4/5 — Conversation events recorder.
 *
 * Centralized helper to write a normalized timeline row into
 * public.conversation_events. The Inbox UI reads from this table directly;
 * audit_logs is written separately and remains the compliance source of truth.
 *
 * Phase 5 addition: after a successful insert, this helper also publishes a
 * lightweight `timeline_event` envelope on the per-conversation realtime
 * channel so the Inbox activity timeline updates without polling. Callers
 * that emit their own richer operator event (e.g. notes) can pass
 * `skipRealtimeEcho: true` to avoid double-invalidation on the client.
 *
 * Design rules:
 *  • Service-role only insert (RLS enforces this — never call from client).
 *  • Fail-safe: never throws. Timeline + realtime are best-effort; the
 *    underlying state change is still authoritative.
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
import { insertAuditLogRows } from './auditLog.js';
import { getServiceClient } from '../supabase.js';
import { publishOperatorEvent } from './realtime/publish.js';

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
  /**
   * Phase 5 — when true, do NOT publish a `timeline_event` realtime echo.
   * Use this for events whose caller publishes a richer operator event
   * (e.g. note_added) so the Inbox doesn't invalidate twice for one action.
   */
  skipRealtimeEcho?: boolean;
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
      .select('id, created_at')
      .single();
    if (error) {
      console.warn('[conversationEvents] insert failed:', error.message);
      return { ok: false, reason: error.message };
    }

    // Phase 5 — realtime echo. Operator-only `event` envelope. Best-effort.
    // Skipped for events whose caller already publishes a richer envelope
    // (currently: note_added / note_deleted).
    if (!input.skipRealtimeEcho && data?.id) {
      void publishOperatorEvent(config, {
        kind: 'timeline_event',
        conversation_id: input.conversationId,
        workspace_id: input.workspaceId,
        actor_id: input.actorId ?? null,
        event_id: data.id,
        event_type: input.eventType,
        actor_type: input.actorType,
        created_at: data.created_at,
      }, { skipInboxChannel: true }); // timeline events only matter for the open conv
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
    void insertAuditLogRows(config, sb, {
      workspace_id: input.workspaceId,
      user_id: input.actorId,
      entity_type: input.auditEntityType ?? 'conversation',
      entity_id: input.conversationId,
      action: input.auditAction,
      old_value: input.oldValue ?? null,
      new_value: input.newValue ?? null,
      ip_address: input.ipAddress ?? null,
    }).then(({ error }) => {
      if (error) console.warn('[audit_logs] insert failed:', error.message);
    });
  }
  await recordConversationEvent(config, input);
}
