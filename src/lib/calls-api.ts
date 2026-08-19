/**
 * Phase 8B - Operator-side calls API client.
 *
 * Talks to the workspace-scoped /api/calls/* routes. Token endpoint
 * returns server-minted LiveKit JWT + dynamic TURN credentials. URLs
 * always come from the resolver - never hardcoded here.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

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

export type CallType = 'audio' | 'video' | 'screenshare' | 'meeting';
export type CallContextType = 'conversation' | 'internal' | 'verification';
export type CallState =
  | 'pending'
  | 'ringing'
  | 'connecting'
  | 'in_progress'
  | 'ended'
  | 'failed';

export interface CallSession {
  id: string;
  workspace_id: string;
  provider: string;
  call_type: CallType;
  context_type: CallContextType;
  context_id: string | null;
  state: CallState;
  provider_room_id: string | null;
  recording_enabled: boolean;
  recording_state: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
}

export interface CallTokenResponse {
  token: string;
  expires_at: number;
  provider: string;
  rtc_url: string | null;
  ws_url: string | null;
  turn: {
    urls: string[];
    username: string | null;
    credential: string | null;
  };
  ice_policy: 'all' | 'relay';
  network: {
    rtc_url: string | null;
    ws_url: string | null;
    region: string | null;
    provider: string | null;
  };
}

export interface CreateCallInput {
  workspace_id: string;
  call_type: CallType;
  context_type: CallContextType;
  context_id?: string | null;
  recording_enabled?: boolean;
}

export const callsApi = {
  create(input: CreateCallInput) {
    return jsonFetch<{ id: string; provider: string; provider_room_id: string; state: CallState }>(
      '/api/calls/create',
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  /**
   * Invite / ring a participant.
   *
   * Route-shape split: callers MUST pass `reason` explicitly. The known
   * operator UI add-participant flow is `'new'` and is plan-gated server
   * side. Recovery / re-ring / continuity callers pass `'reissue'` and
   * remain reachable even after a plan downgrade so in-flight sessions
   * are never stranded. When omitted, the server defaults to `'reissue'`
   * for legacy compatibility.
   */
  invite(
    callId: string,
    participant: {
      participant_type: 'visitor' | 'operator';
      participant_id?: string | null;
      reason?: 'new' | 'reissue';
    },
  ) {
    return jsonFetch<{ ok: true }>('/api/calls/' + callId + '/invite', {
      method: 'POST',
      body: JSON.stringify({ reason: 'new', ...participant }),
    });
  },
  hangup(callId: string) {
    return jsonFetch<{ ok: true }>('/api/calls/' + callId + '/hangup', { method: 'POST' });
  },
  /**
   * Pass A — Canonical end-call endpoint. Idempotent on the server side.
   * Returns the final ended summary (duration, ended_by, end_reason) so
   * the operator UI can render "Call ended · mm:ss" without polling.
   */
  end(
    callId: string,
    reason: 'operator_ended' | 'visitor_ended' | 'system_ended' | 'failed' = 'operator_ended',
  ) {
    return jsonFetch<{
      ok: true;
      call_session_id: string;
      conversation_id: string | null;
      workspace_id: string;
      state: 'ended';
      ended_at: string;
      ended_by: 'operator' | 'visitor' | 'system';
      end_reason: 'operator_ended' | 'visitor_ended' | 'system_ended' | 'failed';
      duration_seconds: number;
      was_active: boolean;
    }>('/api/calls/' + callId + '/end', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  accept(callId: string) {
    return jsonFetch<{ ok: true }>('/api/calls/' + callId + '/accept', { method: 'POST' });
  },
  reject(callId: string) {
    return jsonFetch<{ ok: true }>('/api/calls/' + callId + '/reject', { method: 'POST' });
  },
  token(callId: string, opts?: { display_name?: string; ttl_seconds?: number }) {
    return jsonFetch<CallTokenResponse>('/api/calls/' + callId + '/token', {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    });
  },
  state(callId: string) {
    return jsonFetch<{ session: CallSession; participants: any[]; provider_state: any }>(
      '/api/calls/' + callId + '/state',
    );
  },
  startRecording(callId: string) {
    return jsonFetch<{ recording_id: string; status: string }>(
      '/api/calls/' + callId + '/recording/start',
      { method: 'POST' },
    );
  },
  stopRecording(callId: string, recordingId: string) {
    return jsonFetch<{ recording_id: string; status: string }>(
      '/api/calls/' + callId + '/recording/stop',
      { method: 'POST', body: JSON.stringify({ recording_id: recordingId }) },
    );
  },
};