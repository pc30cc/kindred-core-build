/**
 * AI Proactive Nudge — durable, atomic per-session evaluation ceiling.
 *
 * Backed by a small Postgres aggregate table (ONE row per workspace +
 * trusted session, not a raw event stream) and a single atomic
 * INSERT ... ON CONFLICT DO UPDATE ... WHERE RPC, so the ceiling:
 *  - survives a single process restart (durable, not in-memory);
 *  - is shared across every Core replica (one row in the shared DB, not a
 *    per-process counter);
 *  - cannot be exceeded by concurrent requests (Postgres row-locks the
 *    conflicting row for the statement's duration).
 *
 * Fails CLOSED: any lookup error is treated as "ceiling reached" (denied),
 * never as "unlimited" — the caller must suppress rather than risk an
 * unbounded number of billable AI evaluations.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';

const SESSION_STATE_TTL_SECONDS = 24 * 3600;

/**
 * Atomically increments the evaluation counter for this workspace+session.
 * Returns the new count when allowed, or null when the ceiling has already
 * been reached (or the lookup itself failed) — the caller MUST treat null
 * exactly like "suppress, zero provider calls, zero AI charge".
 */
export async function tryIncrementAiNudgeEvaluationCounter(
  config: ServerConfig,
  workspaceId: string,
  trustedSessionKey: string,
  maxEvaluationsPerSession: number,
): Promise<number | null> {
  if (!Number.isFinite(maxEvaluationsPerSession) || maxEvaluationsPerSession <= 0) return null;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.rpc('ai_nudge_try_increment_session_counter' as any, {
      _workspace_id: workspaceId,
      _session_key: trustedSessionKey,
      _max_evaluations: maxEvaluationsPerSession,
      _ttl_seconds: SESSION_STATE_TTL_SECONDS,
    });
    if (error) return null;
    return typeof data === 'number' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort observability counter — never gates anything. Takes a raw
 * Supabase client (rather than ServerConfig) so it can be called from
 * smartEngagement.ts's recordSmartEvent(), which already receives one.
 */
export async function recordAiNudgeShownForSession(
  supabase: any,
  workspaceId: string,
  trustedSessionKey: string,
): Promise<void> {
  try {
    await supabase.rpc('ai_nudge_record_shown', {
      _workspace_id: workspaceId,
      _session_key: trustedSessionKey,
    });
  } catch { /* best-effort only */ }
}
