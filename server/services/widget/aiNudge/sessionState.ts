/**
 * AI Proactive Nudge — durable, atomic per-session evaluation identity.
 *
 * Backed by a small Postgres aggregate table (ONE row per workspace +
 * trusted session, not a raw event stream) and a single atomic RPC
 * (ai_nudge_acquire_evaluation), so both the per-session evaluation
 * ceiling AND the evaluation's identity:
 *  - survive a single process restart (durable, not in-memory);
 *  - are shared across every Core replica (one row in the shared DB, not a
 *    per-process counter or cache);
 *  - cannot be exceeded, double-counted, or split-brained by concurrent
 *    requests (Postgres row-locks the session's single row for the RPC's
 *    duration).
 *
 * The returned evaluation_id is the durable identity a replayed request
 * (same fingerprint, still inside the dedup window) reuses, and a
 * genuinely new evaluation (new fingerprint, or the same fingerprint after
 * the window lapses) never reuses. AI billing operation keys and the AI
 * Runtime's own request-idempotency are built from this id — see
 * evaluate.ts. The in-process dedup cache (dedup.ts) is NOT the
 * correctness boundary for any of this; it remains only as a
 * fast-rejection performance optimization ahead of this durable RPC.
 *
 * Fails CLOSED: any lookup error is treated as "ceiling reached" (denied),
 * never as "unlimited" — the caller must suppress rather than risk an
 * unbounded number of billable AI evaluations.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';

const SESSION_STATE_TTL_SECONDS = 24 * 3600;
const DEFAULT_DEDUP_WINDOW_SECONDS = 60;

export interface AiNudgeEvaluationAcquisition {
  evaluationId: string;
  evaluationCount: number;
  isNew: boolean;
}

/**
 * Atomically resolves this evaluation attempt's durable identity for a
 * workspace+trusted-session. Returns null when the ceiling has already
 * been reached (or the RPC itself failed) — the caller MUST treat null
 * exactly like "suppress, zero provider calls, zero AI charge".
 */
export async function acquireAiNudgeEvaluation(
  config: ServerConfig,
  workspaceId: string,
  trustedSessionKey: string,
  fingerprint: string,
  maxEvaluationsPerSession: number,
  dedupWindowSeconds: number = DEFAULT_DEDUP_WINDOW_SECONDS,
): Promise<AiNudgeEvaluationAcquisition | null> {
  if (!Number.isFinite(maxEvaluationsPerSession) || maxEvaluationsPerSession <= 0) return null;
  if (!fingerprint) return null;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.rpc('ai_nudge_acquire_evaluation' as any, {
      _workspace_id: workspaceId,
      _session_key: trustedSessionKey,
      _fingerprint: fingerprint,
      _max_evaluations: maxEvaluationsPerSession,
      _dedup_window_seconds: Number.isFinite(dedupWindowSeconds) && dedupWindowSeconds > 0 ? dedupWindowSeconds : DEFAULT_DEDUP_WINDOW_SECONDS,
      _ttl_seconds: SESSION_STATE_TTL_SECONDS,
    });
    if (error || !data) return null;
    const result = data as { ok?: boolean; evaluation_id?: string; evaluation_count?: number; is_new?: boolean };
    if (!result.ok || !result.evaluation_id || typeof result.evaluation_count !== 'number') return null;
    return {
      evaluationId: result.evaluation_id,
      evaluationCount: result.evaluation_count,
      isNew: Boolean(result.is_new),
    };
  } catch {
    return null;
  }
}
