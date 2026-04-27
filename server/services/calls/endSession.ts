/**
 * Pass A — Centralized "end call" lifecycle helper.
 *
 * Single idempotent path used by every endpoint that terminates a call:
 *   - POST /api/calls/:id/end             (operator)
 *   - POST /api/calls/:id/hangup          (legacy alias, kept for back-compat)
 *   - POST /api/widget/call-invitations/:id/end (visitor)
 *
 * Responsibilities:
 *   1. Compute final duration from connected_at → started_at → created_at
 *      (whichever is the earliest known "the call existed" anchor).
 *   2. Persist ended_at, ended_by, ended_by_user_id, end_reason,
 *      duration_seconds, state='ended' — only if the row hasn't already
 *      been ended (idempotent: re-runs return the existing summary).
 *   3. Best-effort close the provider room. Failures here NEVER throw.
 *   4. Best-effort emit a `call:ended` operator event on the per-conversation
 *      channel + workspace inbox channel. Failures NEVER throw.
 *   5. Release the operator's busy-lock (clearInCall) when applicable.
 *
 * The function never throws — every result is an `EndCallSummary` so the
 * route layer can return a stable response on the very first call AND on
 * any subsequent retry from the same client.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveCallProvider } from './providerResolver.js';
import {
  publishOperatorEvent,
  publishConversationEvent,
  buildMessageEnvelope,
} from '../realtime/publish.js';
import { recordConversationEvent } from '../conversationEvents.js';
import { clearInCall } from './availability.js';

export type EndCallReason =
  | 'operator_ended'
  | 'visitor_ended'
  | 'system_ended'
  | 'failed';

export type EndCallActor = 'operator' | 'visitor' | 'system';

export interface EndCallInput {
  callId: string;
  reason: EndCallReason;
  endedBy: EndCallActor;
  /** Operator user id when endedBy === 'operator', else null. */
  endedByUserId?: string | null;
}

export interface EndCallSummary {
  ok: true;
  call_session_id: string;
  conversation_id: string | null;
  workspace_id: string;
  state: 'ended';
  ended_at: string;
  ended_by: EndCallActor;
  end_reason: EndCallReason;
  duration_seconds: number;
  /** True when this invocation actually flipped state→ended. */
  was_active: boolean;
}

export interface EndCallNotFound {
  ok: false;
  reason: 'not_found';
}

export type EndCallResult = EndCallSummary | EndCallNotFound;

function pickAnchorMs(row: any): number {
  const candidates = [row?.connected_at, row?.started_at, row?.created_at];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const ms = new Date(c).getTime();
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  }
  return Date.now();
}

function computeDuration(row: any, endedAtMs: number): number {
  const anchor = pickAnchorMs(row);
  return Math.max(0, Math.round((endedAtMs - anchor) / 1000));
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

export async function endCallSession(
  config: ServerConfig,
  input: EndCallInput,
): Promise<EndCallResult> {
  const sb = getServiceClient(config);
  try {
    // eslint-disable-next-line no-console
    console.info('[call:end] request', {
      call_id: input.callId,
      ended_by: input.endedBy,
      reason: input.reason,
    });
  } catch { /* noop */ }

  const { data: row } = await sb
    .from('call_sessions')
    .select('*')
    .eq('id', input.callId)
    .maybeSingle();
  if (!row) return { ok: false, reason: 'not_found' };

  // Idempotent path — already ended.
  if (row.state === 'ended' && row.ended_at) {
    try {
      // eslint-disable-next-line no-console
      console.info('[call:end] idempotent already ended', {
        call_id: input.callId,
        ended_by: row.ended_by,
        end_reason: row.end_reason,
      });
    } catch { /* noop */ }
    return {
      ok: true,
      call_session_id: row.id,
      conversation_id: row.context_id ?? null,
      workspace_id: row.workspace_id,
      state: 'ended',
      ended_at: row.ended_at,
      ended_by: (row.ended_by as EndCallActor) || input.endedBy,
      end_reason: (row.end_reason as EndCallReason) || input.reason,
      duration_seconds:
        typeof row.duration_seconds === 'number'
          ? row.duration_seconds
          : computeDuration(row, new Date(row.ended_at).getTime()),
      was_active: false,
    };
  }

  const endedAtMs = Date.now();
  const endedAtIso = new Date(endedAtMs).toISOString();
  const duration = computeDuration(row, endedAtMs);

  // 1. Persist ended state. Use a guarded write so two parallel hangups
  //    don't both believe they were the "first" — the second one will
  //    update zero rows and we'll just re-read the canonical summary.
  const { data: updated } = await sb
    .from('call_sessions')
    .update({
      state: 'ended',
      ended_at: endedAtIso,
      duration_seconds: duration,
      ended_by: input.endedBy,
      ended_by_user_id: input.endedByUserId ?? null,
      end_reason: input.reason,
    })
    .eq('id', input.callId)
    .neq('state', 'ended')
    .select('*')
    .maybeSingle();

  // If a parallel write won, re-read.
  let finalRow = updated;
  if (!finalRow) {
    const { data: re } = await sb
      .from('call_sessions')
      .select('*')
      .eq('id', input.callId)
      .maybeSingle();
    finalRow = re;
  }
  if (!finalRow) return { ok: false, reason: 'not_found' };

  // 2. Best-effort close the provider room.
  if (finalRow.provider_room_id) {
    try {
      const provider = resolveCallProvider(finalRow.provider);
      await provider.closeRoom(config, finalRow.provider_room_id);
    } catch {
      /* idempotent — provider may already be torn down */
    }
  }

  // 3. Best-effort: write a call_events row.
  try {
    await sb.from('call_events').insert({
      call_session_id: finalRow.id,
      event_type: 'ended',
      actor_type: input.endedBy === 'operator' ? 'operator' : input.endedBy,
      actor_id: input.endedByUserId ?? null,
      payload: { reason: input.reason, duration_seconds: finalRow.duration_seconds },
    });
  } catch { /* never block */ }

  // 4. Release operator busy-lock.
  if (input.endedBy === 'operator' && input.endedByUserId) {
    void clearInCall(config, finalRow.workspace_id, input.endedByUserId)
      .catch(() => { /* never block */ });
  }

  // 4b. Pass A — Persist a `call_ended` system summary message into the
  //     conversation thread so BOTH operator chat and visitor chat history
  //     show "Call ended by … · Duration mm:ss". Idempotent at two levels:
  //       1. We only insert when `updated` is non-null (i.e. THIS request
  //          performed the state→ended flip — parallel callers see no row).
  //       2. A partial unique index on
  //          (conversation_id, metadata->>'call_session_id')
  //          where kind='call_ended' makes a second insert raise 23505,
  //          which we swallow.
  //     The actual user-visible text is rendered client-side from
  //     metadata so each side can localize it (en/tr/fa).
  if (updated && finalRow.context_id) {
    const fallbackBody =
      input.endedBy === 'operator'
        ? `Call ended by operator · ${formatDuration(finalRow.duration_seconds ?? duration)}`
        : input.endedBy === 'visitor'
          ? `Call ended by visitor · ${formatDuration(finalRow.duration_seconds ?? duration)}`
          : `Call ended · ${formatDuration(finalRow.duration_seconds ?? duration)}`;
    const msgMeta = {
      kind: 'call_ended' as const,
      call_session_id: finalRow.id,
      call_type: finalRow.call_type ?? null,
      ended_by: input.endedBy,
      end_reason: input.reason,
      duration_seconds: finalRow.duration_seconds ?? duration,
      ended_at: finalRow.ended_at,
    };
    try {
      const { data: msgRow, error: msgErr } = await sb
        .from('conversation_messages')
        .insert({
          conversation_id: finalRow.context_id,
          sender_type: 'system',
          sender_id: input.endedByUserId ?? null,
          body: fallbackBody,
          metadata: msgMeta,
        })
        .select('id, conversation_id, sender_type, body, created_at, metadata, seen_at')
        .single();
      if (msgErr) {
        // 23505 = unique_violation → another worker already wrote the
        // summary; that's the desired idempotent outcome.
        if ((msgErr as any).code !== '23505') {
          // eslint-disable-next-line no-console
          console.warn('[call:end] system message insert failed:', msgErr.message);
        }
      } else if (msgRow) {
        // Realtime push so the widget renders the summary without polling.
        void publishConversationEvent(
          config,
          finalRow.workspace_id,
          finalRow.context_id,
          buildMessageEnvelope({
            id: msgRow.id as string,
            conversation_id: msgRow.conversation_id as string,
            sender_type: 'system',
            body: msgRow.body as string,
            created_at: msgRow.created_at as string | null,
            metadata:
              ((msgRow.metadata as Record<string, unknown>) ??
                (msgMeta as unknown as Record<string, unknown>)),
            seen_at: (msgRow as any).seen_at ?? null,
          }),
        );
      }
    } catch (err: any) {
      if (err?.code !== '23505') {
        // eslint-disable-next-line no-console
        console.warn('[call:end] system message threw:', err?.message || err);
      }
    }

    // Operator-only timeline row. `recordConversationEvent` is fail-safe.
    void recordConversationEvent(config, {
      workspaceId: finalRow.workspace_id,
      conversationId: finalRow.context_id,
      eventType: 'call_ended',
      actorType:
        input.endedBy === 'operator'
          ? 'agent'
          : input.endedBy === 'visitor'
            ? 'visitor'
            : 'system',
      actorId: input.endedByUserId ?? null,
      payload: msgMeta,
    });
  }

  // 5. Realtime fan-out — operator inbox + per-conversation channel.
  if (finalRow.context_id) {
    try {
      // eslint-disable-next-line no-console
      console.info('[call:end] published call:ended', {
        inbox_channel: `ws:${finalRow.workspace_id}:inbox`,
        conv_channel: `ws:${finalRow.workspace_id}:conv:${finalRow.context_id}`,
        call_session_id: finalRow.id,
        ended_by: input.endedBy,
        duration_seconds: finalRow.duration_seconds ?? duration,
      });
    } catch { /* noop */ }
    void publishOperatorEvent(config, {
      kind: 'call:ended',
      conversation_id: finalRow.context_id,
      workspace_id: finalRow.workspace_id,
      actor_id: input.endedByUserId ?? null,
      call_session_id: finalRow.id,
      ended_by: input.endedBy,
      reason: input.reason,
      duration_seconds: finalRow.duration_seconds ?? duration,
      ended_at: finalRow.ended_at,
    } as any).catch(() => { /* publish never throws */ });
  }

  return {
    ok: true,
    call_session_id: finalRow.id,
    conversation_id: finalRow.context_id ?? null,
    workspace_id: finalRow.workspace_id,
    state: 'ended',
    ended_at: finalRow.ended_at,
    ended_by: (finalRow.ended_by as EndCallActor) || input.endedBy,
    end_reason: (finalRow.end_reason as EndCallReason) || input.reason,
    duration_seconds: finalRow.duration_seconds ?? duration,
    was_active: !!updated,
  };
}