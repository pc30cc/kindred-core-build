/**
 * Phase 8D — Callback request service.
 * Workspace-scoped. Used as a fallback path when a live call is impossible.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolvePublisher } from '../realtime/resolvePublisher.js';

export type CallbackChannel = 'audio' | 'video';
export type CallbackStatus =
  | 'requested'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface CallbackRequestRow {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  visitor_session_id: string | null;
  channel: CallbackChannel;
  status: CallbackStatus;
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  requested_at: string;
  scheduled_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  handled_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCallbackInput {
  workspaceId: string;
  channel: CallbackChannel;
  conversationId?: string | null;
  contactId?: string | null;
  visitorSessionId?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
}

function channelName(workspaceId: string): string {
  return `ws:${workspaceId}:queue`;
}

async function publishCallbackEvent(
  config: ServerConfig,
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const publisher = await resolvePublisher(config, workspaceId);
    await publisher.publish(channelName(workspaceId), {
      type: 'event',
      payload: { kind: 'call_callback', ...payload },
    } as any);
  } catch {/* best-effort */}
}

export async function createCallbackRequest(
  config: ServerConfig,
  input: CreateCallbackInput,
): Promise<CallbackRequestRow> {
  const sb = getServiceClient(config);
  // Phase 8D+ — Idempotency guard. Avoid creating duplicate callbacks for the
  // same visitor/contact within a 10-minute window if one is still open.
  const sinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const dedupeKey =
    input.visitorSessionId || input.contactId || input.conversationId || null;
  if (dedupeKey) {
    let dq = sb
      .from('callback_requests')
      .select('*')
      .eq('workspace_id', input.workspaceId)
      .in('status', ['requested', 'scheduled', 'in_progress'])
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1);
    if (input.visitorSessionId) dq = dq.eq('visitor_session_id', input.visitorSessionId);
    else if (input.contactId) dq = dq.eq('contact_id', input.contactId);
    else if (input.conversationId) dq = dq.eq('conversation_id', input.conversationId);
    const { data: existing } = await dq.maybeSingle();
    if (existing) return existing as CallbackRequestRow;
  }
  const { data, error } = await sb
    .from('callback_requests')
    .insert({
      workspace_id: input.workspaceId,
      channel: input.channel,
      conversation_id: input.conversationId ?? null,
      contact_id: input.contactId ?? null,
      visitor_session_id: input.visitorSessionId ?? null,
      contact_phone: input.contactPhone ?? null,
      contact_email: input.contactEmail ?? null,
      notes: input.notes ?? null,
      metadata: input.metadata ?? {},
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message || 'callback_create_failed');
  await publishCallbackEvent(config, input.workspaceId, {
    type: 'requested',
    callback_id: data.id,
    channel: input.channel,
  });
  return data as CallbackRequestRow;
}

export async function listCallbacks(
  config: ServerConfig,
  workspaceId: string,
  status?: CallbackStatus | 'open',
): Promise<CallbackRequestRow[]> {
  const sb = getServiceClient(config);
  let q = sb
    .from('callback_requests')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('requested_at', { ascending: false })
    .limit(200);
  if (status === 'open') q = q.in('status', ['requested', 'scheduled', 'in_progress']);
  else if (status) q = q.eq('status', status);
  const { data } = await q;
  return (data ?? []) as CallbackRequestRow[];
}

export async function updateCallbackStatus(
  config: ServerConfig,
  workspaceId: string,
  callbackId: string,
  next: CallbackStatus,
  handledBy?: string | null,
): Promise<CallbackRequestRow | null> {
  const sb = getServiceClient(config);
  const patch: Record<string, unknown> = {
    status: next,
    updated_at: new Date().toISOString(),
  };
  if (handledBy) patch.handled_by = handledBy;
  if (next === 'completed') patch.completed_at = new Date().toISOString();
  if (next === 'cancelled') patch.cancelled_at = new Date().toISOString();
  if (next === 'scheduled') patch.scheduled_at = new Date().toISOString();
  const { data, error } = await sb
    .from('callback_requests')
    .update(patch)
    .eq('workspace_id', workspaceId)
    .eq('id', callbackId)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  await publishCallbackEvent(config, workspaceId, {
    type: 'status_changed',
    callback_id: callbackId,
    status: next,
  });
  return data as CallbackRequestRow;
}

export async function getCallbackCounts(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ requested: number; scheduled: number; in_progress: number; completed: number; cancelled: number }> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('callback_requests')
    .select('status')
    .eq('workspace_id', workspaceId)
    .gte('requested_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
  const out = { requested: 0, scheduled: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const r of data ?? []) {
    const s = (r as any).status as CallbackStatus;
    if (s in out) (out as any)[s]++;
  }
  return out;
}

/**
 * Phase 8D+ — Platform-wide counts across ALL workspaces (last 30 days).
 * Used by the admin Voice & Video Center analytics cards.
 */
export async function getPlatformCallbackCounts(
  config: ServerConfig,
): Promise<{ requested: number; scheduled: number; in_progress: number; completed: number; cancelled: number }> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('callback_requests')
    .select('status')
    .gte('requested_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
  const out = { requested: 0, scheduled: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const r of data ?? []) {
    const s = (r as any).status as CallbackStatus;
    if (s in out) (out as any)[s]++;
  }
  return out;
}
