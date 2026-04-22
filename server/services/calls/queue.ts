/**
 * Phase 8C — Call queue service.
 *
 * State machine:
 *   queued → offered → accepted     (operator picked up)
 *   queued → cancelled              (visitor or admin cancelled)
 *   queued → expired                (passed expires_at without offer)
 *   offered → accepted | cancelled | expired
 *
 * Realtime fan-out: every transition publishes through the existing
 * conversation event bus on a channel named `ws:{workspace}:queue`.
 * The widget runtime + operator inbox both already speak this transport
 * (centrifugo/supabase/polling) — no new socket needed.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolvePublisher } from '../realtime/resolvePublisher.js';
import { loadEffectiveCallChannels, loadCallControlPlane } from './controlPlane.js';
import { recordConversationEvent } from '../conversationEvents.js';

export type QueueChannel = 'audio' | 'video';
export type QueueState =
  | 'queued'
  | 'offered'
  | 'accepted'
  | 'cancelled'
  | 'expired'
  | 'missed'
  | 'callback_requested';

export interface QueueEntry {
  id: string;
  workspace_id: string;
  channel: QueueChannel;
  state: QueueState;
  visitor_session_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  call_session_id: string | null;
  requested_by: string;
  priority: number;
  position_hint: number | null;
  offered_to_user_id: string | null;
  offered_at: string | null;
  accepted_at: string | null;
  ended_at: string | null;
  ended_reason: string | null;
  expires_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Phase 8D additions
  missed_offer_count: number;
  last_offer_expires_at: string | null;
  offer_timeout_seconds: number;
  sla_breached: boolean;
  callback_request_id: string | null;
}

export interface EnqueueInput {
  workspaceId: string;
  channel: QueueChannel;
  visitorSessionId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  requestedBy?: 'visitor' | 'operator';
  priority?: number;
  metadata?: Record<string, unknown>;
}

function queueChannel(workspaceId: string): string {
  return `ws:${workspaceId}:queue`;
}

async function publishQueueEvent(
  config: ServerConfig,
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const publisher = await resolvePublisher(config, workspaceId);
    await publisher.publish(queueChannel(workspaceId), {
      type: 'event',
      payload: { kind: 'call_queue', ...payload },
    } as any);
  } catch {
    // Realtime is best-effort; clients also re-poll the queue endpoint.
  }
}

/** Best-effort timeline write so call lifecycle shows up in conversation history. */
async function writeTimelineEvent(
  config: ServerConfig,
  entry: Pick<QueueEntry, 'workspace_id' | 'conversation_id' | 'channel'>,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  if (!entry.conversation_id) return;
  try {
    await recordConversationEvent(config, {
      workspaceId: entry.workspace_id,
      conversationId: entry.conversation_id,
      eventType,
      actorType: 'system',
      payload: { channel: entry.channel, ...payload },
    });
  } catch {/* never throw from queue path */}
}

/** Enqueue a visitor call request. Honors the channel gate. */
export async function enqueueCall(
  config: ServerConfig,
  input: EnqueueInput,
): Promise<QueueEntry> {
  const channels = await loadEffectiveCallChannels(config, input.workspaceId);
  if (!channels.queue_enabled) {
    throw new Error('queue_disabled');
  }
  if (input.channel === 'audio' && !channels.visitor_initiated_audio) {
    throw new Error('voice_disabled');
  }
  if (input.channel === 'video' && !channels.visitor_initiated_video) {
    throw new Error('video_disabled');
  }

  const sb = getServiceClient(config);
  // Reuse an active entry for the same visitor+channel if present.
  if (input.visitorSessionId) {
    const { data: existing } = await sb
      .from('call_queue_entries')
      .select('*')
      .eq('workspace_id', input.workspaceId)
      .eq('visitor_session_id', input.visitorSessionId)
      .eq('channel', input.channel)
      .in('state', ['queued', 'offered'])
      .maybeSingle();
    if (existing) return existing as QueueEntry;
  }

  const { data, error } = await sb
    .from('call_queue_entries')
    .insert({
      workspace_id: input.workspaceId,
      channel: input.channel,
      state: 'queued',
      visitor_session_id: input.visitorSessionId ?? null,
      contact_id: input.contactId ?? null,
      conversation_id: input.conversationId ?? null,
      requested_by: input.requestedBy ?? 'visitor',
      priority: input.priority ?? 0,
      metadata: input.metadata ?? {},
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message || 'enqueue_failed');

  await publishQueueEvent(config, input.workspaceId, {
    type: 'queued',
    entry_id: data.id,
    channel: input.channel,
  });
  await writeTimelineEvent(config, data as QueueEntry, 'call_queued', { entry_id: data.id });
  return data as QueueEntry;
}

/** Mark an entry as offered to a specific operator. */
export async function offerEntry(
  config: ServerConfig,
  entryId: string,
  operatorUserId: string,
): Promise<QueueEntry> {
  const sb = getServiceClient(config);
  const cp = await loadCallControlPlane(config);
  const timeoutSec = Math.max(5, cp.queue_offer_timeout_seconds || 25);
  const expiresIso = new Date(Date.now() + timeoutSec * 1000).toISOString();
  const { data, error } = await sb
    .from('call_queue_entries')
    .update({
      state: 'offered',
      offered_to_user_id: operatorUserId,
      offered_at: new Date().toISOString(),
      last_offer_expires_at: expiresIso,
      offer_timeout_seconds: timeoutSec,
    })
    .eq('id', entryId)
    .eq('state', 'queued')
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message || 'offer_failed');
  await publishQueueEvent(config, data.workspace_id, {
    type: 'offered',
    entry_id: entryId,
    operator_id: operatorUserId,
    expires_at: expiresIso,
  });
  await writeTimelineEvent(config, data as QueueEntry, 'call_offered', {
    entry_id: entryId,
    operator_id: operatorUserId,
  });
  return data as QueueEntry;
}

/** Mark accepted (operator picked up). Optionally link the call session. */
export async function acceptEntry(
  config: ServerConfig,
  entryId: string,
  callSessionId: string | null,
): Promise<QueueEntry> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('call_queue_entries')
    .update({
      state: 'accepted',
      accepted_at: new Date().toISOString(),
      call_session_id: callSessionId,
    })
    .eq('id', entryId)
    .in('state', ['queued', 'offered'])
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message || 'accept_failed');
  await publishQueueEvent(config, data.workspace_id, {
    type: 'accepted',
    entry_id: entryId,
    call_session_id: callSessionId,
  });
  await writeTimelineEvent(config, data as QueueEntry, 'call_accepted', {
    entry_id: entryId,
    call_session_id: callSessionId,
  });
  return data as QueueEntry;
}

/** Cancel an entry (visitor hangup or admin/operator dismissal). */
export async function cancelEntry(
  config: ServerConfig,
  entryId: string,
  reason: string,
): Promise<QueueEntry | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('call_queue_entries')
    .update({
      state: 'cancelled',
      ended_at: new Date().toISOString(),
      ended_reason: reason,
    })
    .eq('id', entryId)
    .in('state', ['queued', 'offered'])
    .select('*')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  await publishQueueEvent(config, data.workspace_id, {
    type: 'cancelled',
    entry_id: entryId,
    reason,
  });
  await writeTimelineEvent(config, data as QueueEntry, 'call_cancelled', {
    entry_id: entryId,
    reason,
  });
  return data as QueueEntry;
}

/** Expire any entries past their deadline (called from a ticker). */
export async function expireStaleEntries(
  config: ServerConfig,
): Promise<number> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('call_queue_entries')
    .update({
      state: 'expired',
      ended_at: new Date().toISOString(),
      ended_reason: 'timeout',
    })
    .lt('expires_at', new Date().toISOString())
    .in('state', ['queued', 'offered'])
    .select('id, workspace_id, conversation_id, channel');
  if (error || !data) return 0;
  for (const row of data) {
    await publishQueueEvent(config, row.workspace_id, {
      type: 'expired',
      entry_id: row.id,
    });
    await writeTimelineEvent(
      config,
      row as any,
      'call_expired',
      { entry_id: row.id },
    );
  }
  return data.length;
}

/**
 * Phase 8D — return an offered entry to queue if its offer timeout passed.
 * Bumps `missed_offer_count`. If the count reaches the SLA ceiling we mark
 * the whole entry as `missed` so it stops cycling.
 */
export async function reapStaleOffers(config: ServerConfig): Promise<{ requeued: number; missed: number }> {
  const sb = getServiceClient(config);
  const cp = await loadCallControlPlane(config);
  const maxMisses = 3; // small, predictable; not user-facing yet.
  const { data: stale } = await sb
    .from('call_queue_entries')
    .select('*')
    .eq('state', 'offered')
    .lt('last_offer_expires_at', new Date().toISOString())
    .limit(100);
  let requeued = 0;
  let missed = 0;
  for (const e of (stale ?? []) as QueueEntry[]) {
    const nextMisses = (e.missed_offer_count || 0) + 1;
    const ageSec = (Date.now() - new Date(e.created_at).getTime()) / 1000;
    const slaBreach = ageSec >= cp.queue_max_wait_seconds;
    if (nextMisses >= maxMisses || slaBreach) {
      // Fully missed — out of the active queue.
      const { data: u } = await sb
        .from('call_queue_entries')
        .update({
          state: 'missed',
          ended_at: new Date().toISOString(),
          ended_reason: slaBreach ? 'sla_breach' : 'no_answer',
          missed_offer_count: nextMisses,
          sla_breached: slaBreach,
        })
        .eq('id', e.id)
        .select('*')
        .maybeSingle();
      if (u) {
        missed++;
        await publishQueueEvent(config, e.workspace_id, { type: 'missed', entry_id: e.id });
        await writeTimelineEvent(config, u as QueueEntry, 'call_missed', { entry_id: e.id, reason: (u as any).ended_reason });
      }
    } else {
      const { data: u } = await sb
        .from('call_queue_entries')
        .update({
          state: 'queued',
          offered_to_user_id: null,
          offered_at: null,
          last_offer_expires_at: null,
          missed_offer_count: nextMisses,
        })
        .eq('id', e.id)
        .select('*')
        .maybeSingle();
      if (u) {
        requeued++;
        await publishQueueEvent(config, e.workspace_id, { type: 'requeued', entry_id: e.id });
      }
    }
  }
  return { requeued, missed };
}

/** Convenience for routing after a callback was created. */
export async function markEntryAsCallback(
  config: ServerConfig,
  entryId: string,
  callbackRequestId: string,
): Promise<void> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_queue_entries')
    .update({
      state: 'callback_requested',
      ended_at: new Date().toISOString(),
      ended_reason: 'callback_requested',
      callback_request_id: callbackRequestId,
    })
    .eq('id', entryId)
    .in('state', ['queued', 'offered'])
    .select('*')
    .maybeSingle();
  if (data) {
    await publishQueueEvent(config, (data as any).workspace_id, {
      type: 'callback_requested',
      entry_id: entryId,
      callback_request_id: callbackRequestId,
    });
    await writeTimelineEvent(config, data as QueueEntry, 'callback_requested', {
      entry_id: entryId,
      callback_request_id: callbackRequestId,
    });
  }
}

/** Read snapshot of active entries for a workspace, FIFO by created_at. */
export async function listActive(
  config: ServerConfig,
  workspaceId: string,
  channel?: QueueChannel,
): Promise<QueueEntry[]> {
  const sb = getServiceClient(config);
  let q = sb
    .from('call_queue_entries')
    .select('*')
    .eq('workspace_id', workspaceId)
    .in('state', ['queued', 'offered'])
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(200);
  if (channel) q = q.eq('channel', channel);
  const { data, error } = await q;
  if (error || !data) return [];
  return data as QueueEntry[];
}

/** Lookup a single entry by id (workspace-scoped for safety). */
export async function getEntry(
  config: ServerConfig,
  workspaceId: string,
  entryId: string,
): Promise<QueueEntry | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_queue_entries')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', entryId)
    .maybeSingle();
  return (data as QueueEntry | null) ?? null;
}