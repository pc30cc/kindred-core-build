import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Phase 9 — Operator-side Call Invitations client.
 *
 * Thin typed wrapper around /api/call-invitations. Mirrors the auth/fetch
 * conventions used by calls-api.ts. Token + workspace membership checks
 * happen server-side; this module only forwards the operator's session.
 */
const API_BASE = RESOLVED_API_BASE || '';

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const err: Error & { code?: string; status?: number } = new Error(
      body?.error || body?.message || ('API ' + res.status),
    );
    err.code = body?.error;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export type InvitationChannel = 'audio' | 'video';
export type InvitationStatus =
  | 'pending'
  | 'joined'
  | 'expired'
  | 'cancelled'
  | 'declined';

export interface CallInvitation {
  id: string;
  workspace_id: string;
  conversation_id: string;
  channel: InvitationChannel;
  status: InvitationStatus;
  expires_at: string;
  joined_at: string | null;
  ended_at: string | null;
  cancel_reason: string | null;
  call_session_id: string | null;
  system_message_id: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface CreateInvitationInput {
  workspace_id: string;
  conversation_id: string;
  channel: InvitationChannel;
  /**
   * Operator-chosen wait window in seconds. Clamped server-side to
   * [60, 600]. Optional — when omitted the server falls back to
   * CALL_INVITATION_TTL_SECONDS (default 300).
   */
  ttl_seconds?: number;
}

export const callInvitationsApi = {
  create(input: CreateInvitationInput) {
    return jsonFetch<{ invitation: CallInvitation; ttl_seconds: number }>(
      '/api/call-invitations',
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  cancel(invitationId: string) {
    return jsonFetch<{ invitation: CallInvitation }>(
      '/api/call-invitations/' + invitationId + '/cancel',
      { method: 'POST' },
    );
  },
  listForConversation(conversationId: string) {
    return jsonFetch<{ invitations: CallInvitation[] }>(
      '/api/call-invitations?conversation_id=' + encodeURIComponent(conversationId),
    );
  },
  get(invitationId: string) {
    return jsonFetch<{ invitation: CallInvitation }>(
      '/api/call-invitations/' + invitationId,
    );
  },
};