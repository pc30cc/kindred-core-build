/**
 * Colleague calls (team calls) — the web panel's client of /api/team-calls
 * (server/routes/teamCalls.ts; the contract is docs/operations/TEAM_CALLS.md).
 *
 * Session auth (the panel's cookie). Every answer carries one `TeamCall`,
 * seen from this member's side of it. An error answer is thrown as a
 * TeamCallApiError with the server's code and body, so the call UI can say
 * in words what happened (teamCallErrorKey) and, for a 409, read the call
 * as it now is.
 */
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
import type { CallTokenResponse } from '@/lib/calls-api';

const API_BASE = RESOLVED_API_BASE || '';

export type TeamCallChannel = 'audio' | 'video';
export type TeamCallState = 'ringing' | 'connecting' | 'active' | 'ended' | 'missed' | 'cancelled';
export type TeamCallOutcome = 'completed' | 'declined' | 'cancelled' | 'missed' | 'failed';

export interface TeamCallPeer {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
}

export interface TeamCall {
  id: string;
  workspace_id: string;
  channel: TeamCallChannel;
  state: TeamCallState;
  outcome: TeamCallOutcome | null;
  role: 'caller' | 'callee';
  peer: TeamCallPeer;
  answered_device_id: string | null;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  expires_at: string;
}

/** A state past which the call never rings or talks again. */
export function isTeamCallOver(state: TeamCallState): boolean {
  return state === 'ended' || state === 'missed' || state === 'cancelled';
}

/** An answer of the API that is not a 2xx. */
export class TeamCallApiError extends Error {
  readonly status: number;
  /** The server's `error` code (`callee_busy`, `limit_reached`, …), or `network`. */
  readonly code: string;
  readonly body: Record<string, unknown>;

  constructor(status: number, code: string, body: Record<string, unknown>) {
    super(code);
    this.name = 'TeamCallApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** The call as it is now, when the answer carries one (409 not_ringing / not_connected). */
  get call(): TeamCall | null {
    const call = this.body.call;
    return call && typeof call === 'object' ? (call as TeamCall) : null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/team-calls${path}`, {
      credentials: 'include',
      ...init,
      headers: { 'Content-Type': 'application/json', ...((init?.headers as Record<string, string>) || {}) },
    });
  } catch {
    throw new TeamCallApiError(0, 'network', {});
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.error === 'string' && body.error ? body.error : `http_${res.status}`;
    throw new TeamCallApiError(res.status, code, body);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const teamCallsApi = {
  /** Rings a colleague: 201 `{ call }`, or one of the errors TEAM_CALLS.md lists. */
  async place(input: { workspace_id: string; callee_id: string; channel: TeamCallChannel }): Promise<TeamCall> {
    return (await post<{ call: TeamCall }>('', input)).call;
  },
  async get(id: string): Promise<TeamCall> {
    return (await request<{ call: TeamCall }>(`/${encodeURIComponent(id)}`)).call;
  },
  /** First answer wins: a 409 `not_ringing` carries the call as it is. */
  async accept(id: string, deviceId: string): Promise<TeamCall> {
    return (await post<{ call: TeamCall }>(`/${encodeURIComponent(id)}/accept`, { device_id: deviceId })).call;
  },
  async decline(id: string): Promise<TeamCall> {
    return (await post<{ call: TeamCall }>(`/${encodeURIComponent(id)}/decline`)).call;
  },
  async cancel(id: string): Promise<TeamCall> {
    return (await post<{ call: TeamCall }>(`/${encodeURIComponent(id)}/cancel`)).call;
  },
  async hangup(id: string): Promise<TeamCall> {
    return (await post<{ call: TeamCall }>(`/${encodeURIComponent(id)}/hangup`)).call;
  },
  /** This member's LiveKit token, in POST /api/calls/:id/token's shape. */
  token(id: string): Promise<CallTokenResponse> {
    return post<CallTokenResponse>(`/${encodeURIComponent(id)}/token`);
  },
  /**
   * Ends the call while the tab goes away (pagehide): a keepalive request the
   * browser finishes after the page is gone. Best effort; the LiveKit webhook
   * ends a call whose member left the room anyway.
   */
  hangupOnExit(id: string): void {
    try {
      void fetch(`${API_BASE}/api/team-calls/${encodeURIComponent(id)}/hangup`, {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => { /* the page is gone */ });
    } catch { /* the page is gone */ }
  },
};
