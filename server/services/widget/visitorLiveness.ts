/**
 * Visitor liveness — write coalescing.
 *
 * The widget heartbeat fires every VISITOR_HEARTBEAT_MS on every open tab.
 * Historically each tick cost three statements (SELECT current_page +
 * UPDATE visitor_sessions + UPDATE visitor_presence), which made
 * visitor_sessions / visitor_presence the highest-write tables in the
 * database while carrying no new business fact — only recency.
 *
 * Liveness is now refreshed through a single atomic RPC that writes ONLY
 * when either:
 *   - the visitor navigated (current_page changed), or
 *   - the row has aged past VISITOR_LIVENESS_REFRESH_MS.
 *
 * Business/session state (contact linkage, geo, referrer, device,
 * page-view history) is deliberately NOT touched here — those keep their
 * own write paths.
 *
 * Read-side thresholds are derived from the refresh interval so a coalesced
 * write can never produce a false "offline".
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Widget heartbeat cadence (must match public/widget/loader.js). */
export const VISITOR_HEARTBEAT_MS = 60_000;

/** Minimum age before a pure-liveness refresh is persisted. */
export const VISITOR_LIVENESS_REFRESH_MS = 120_000;

/** Below this age a visitor is unambiguously live. */
export const VISITOR_LIVENESS_ONLINE_MS =
  VISITOR_LIVENESS_REFRESH_MS + 2 * VISITOR_HEARTBEAT_MS; // 240s

/** Beyond this age the visitor is considered gone (no active close signal exists). */
export const VISITOR_LIVENESS_OFFLINE_MS = 8 * 60_000;

export interface TouchLivenessResult {
  /** The session row exists and belongs to this workspace/visitor. */
  matched: boolean;
  /** The visitor navigated to a different URL since the last write. */
  pageChanged: boolean;
  /** A DB write actually happened (false = coalesced away). */
  wrote: boolean;
}

/**
 * Refresh visitor liveness, coalescing redundant heartbeat writes.
 *
 * Falls back to the legacy explicit UPDATE pair when the RPC is missing
 * (self-hosted deployments that have not applied the migration yet), so a
 * stale database degrades in write volume rather than in correctness.
 */
export async function touchVisitorLiveness(
  supabase: SupabaseClient<any>,
  params: {
    workspaceId: string;
    sessionId: string;
    visitorId?: string | null;
    currentPage?: string | null;
    minIntervalMs?: number;
  },
): Promise<TouchLivenessResult> {
  const { workspaceId, sessionId } = params;
  const visitorId = params.visitorId || null;
  const currentPage = params.currentPage || null;
  const minIntervalMs = params.minIntervalMs ?? VISITOR_LIVENESS_REFRESH_MS;

  const { data, error } = await supabase.rpc('visitor_touch_liveness', {
    p_workspace_id: workspaceId,
    p_session_id: sessionId,
    p_visitor_id: visitorId,
    p_current_page: currentPage,
    p_min_interval_ms: minIntervalMs,
  });

  if (!error) {
    const row = Array.isArray(data) ? data[0] : data;
    return {
      matched: !!row?.matched,
      pageChanged: !!row?.page_changed,
      wrote: !!row?.wrote,
    };
  }

  // Only a genuinely missing RPC (old self-hosted database) may degrade to the
  // legacy write pair. Permission errors, SQL/runtime failures, timeouts and
  // bad input must surface — silently falling back would hide a real bug while
  // multiplying the write volume we just removed.
  if (!isMissingRpcError(error)) throw error;

  return touchVisitorLivenessFallback(supabase, {
    workspaceId,
    sessionId,
    visitorId,
    currentPage,
  });
}

/**
 * True only for "function does not exist" / PostgREST schema-cache misses for
 * THIS function. PostgREST reports an undefined routine as PGRST202 (schema
 * cache) and Postgres as SQLSTATE 42883.
 *
 * A bare HTTP 404 is deliberately NOT accepted: it can equally mean a wrong
 * base URL, a proxy error or a routing problem, and silently degrading to the
 * legacy write pair would hide a real outage while multiplying write volume.
 */
export function isMissingRpcError(error: any): boolean {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (code === '42883' || code === 'PGRST202') return true;
  const msg = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`.toLowerCase();
  if (/visitor_touch_liveness/.test(msg)) {
    return (
      /could not find the function/.test(msg) ||
      /does not exist/.test(msg) ||
      /schema cache/.test(msg)
    );
  }
  return false;
}



async function touchVisitorLivenessFallback(
  supabase: SupabaseClient<any>,
  params: {
    workspaceId: string;
    sessionId: string;
    visitorId: string | null;
    currentPage: string | null;
  },
): Promise<TouchLivenessResult> {
  const { workspaceId, sessionId, visitorId, currentPage } = params;
  const now = new Date().toISOString();

  const { data: prev } = await supabase
    .from('visitor_sessions')
    .select('current_page')
    .eq('id', sessionId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!prev) return { matched: false, pageChanged: false, wrote: false };

  const prevPage = (prev as any).current_page ?? null;
  const pageChanged = !!currentPage && currentPage !== prevPage;

  let q = supabase
    .from('visitor_sessions')
    .update({ last_seen_at: now, current_page: currentPage ?? prevPage })
    .eq('workspace_id', workspaceId)
    .eq('id', sessionId);
  if (visitorId) q = q.eq('visitor_id', visitorId);
  const { error } = await q;
  if (error) throw error;

  await supabase
    .from('visitor_presence')
    .update({ status: 'online', current_page: currentPage ?? prevPage, updated_at: now })
    .eq('workspace_id', workspaceId)
    .eq('visitor_session_id', sessionId);

  return { matched: true, pageChanged, wrote: true };
}
