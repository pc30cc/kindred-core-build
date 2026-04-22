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
import { loadEffectiveCallChannels } from './controlPlane.js';

export type QueueChannel = 'audio' | 'video';
export type QueueState =
  | 'queued'
  | 'offered'
  | 'accepted'
  | 'cancelled'
  | 'expired';

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
  return data as QueueEntry;
}

/** Mark an entry as offered to a specific operator. */
export async function offerEntry(
  config: ServerConfig,
  entryId: string,
  operatorUserId: string,
): Promise<QueueEntry> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('call_queue_entries')
    .update({
      state: 'offered',
      offered_to_user_id: operatorUserId,
      offered_at: new Date().toISOString(),
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
    .select('id, workspace_id');
  if (error || !data) return 0;
  for (const row of data) {
    await publishQueueEvent(config, row.workspace_id, {
      type: 'expired',
      entry_id: row.id,
    });
  }
  return data.length;
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