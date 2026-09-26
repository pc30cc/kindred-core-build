/**
 * Visitor limit enforcement helper.
 *
 * Locked semantics: distinct `visitor_id` per workspace per UTC
 * calendar month. The single canonical writer of
 * `workspace_usage_counters.visitors_count` is the DB trigger
 * `trg_visitor_sessions_count_visitor`. This helper does NOT write
 * that counter and never invokes any custom counting math; it only
 * decides whether the current request is the **first**
 * `visitor_sessions` row for `(workspace_id, visitor_id)` this UTC
 * month and, when it is, defers to the shared
 * `requireLimit('max_visitors', usageFnForLimit('max_visitors'))`
 * middleware to gate the request.
 *
 * Branch contract:
 *
 *   - True new-this-month visitor → invoke `requireLimit` inline.
 *     If the cap is reached, `requireLimit` writes its standard 403
 *     and the helper returns `false` so the caller aborts.
 *   - In-month revisit / 30-min reconnect / update / page view →
 *     skip the gate entirely. The helper returns `true` and the
 *     caller proceeds unchanged.
 *
 * The membership pre-check intentionally mirrors the predicate used
 * by `tg_visitor_sessions_count_visitor()` so gate decisions and
 * counter increments cannot disagree. It is a read of
 * `visitor_sessions`; it never increments any counter and never
 * writes a `visitor_sessions` row.
 *
 * Callers MUST have already verified `workspaceId` (widget token /
 * origin / workspace membership) before calling this helper. The cap is
 * evaluated on that argument only (pinned via setTrustedGateWorkspaceId);
 * request-supplied `workspaceId`/`workspace_id` fields are ignored.
 *
 * Returns `true` when the caller may proceed, `false` when the
 * middleware has already written its 403 response. Callers must
 * `return` immediately on `false`.
 */

import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireLimit } from '../../middleware/featureGating.js';
import { setTrustedGateWorkspaceId } from '../../middleware/gateWorkspace.js';
import { usageFnForLimit } from './usageResolvers.js';

const visitorLimitMiddleware = requireLimit(
  'max_visitors',
  usageFnForLimit('max_visitors'),
);

/**
 * Start of the current UTC calendar month, ISO 8601. Matches the
 * `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')` period key used by
 * the trigger and by `currentMonthPeriod()` in `usageResolvers.ts`.
 */
function startOfCurrentUtcMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Returns true when at least one `visitor_sessions` row already
 * exists for `(workspaceId, visitorId)` in the current UTC month.
 * On read errors we fail OPEN (treat as in-month) to avoid blocking
 * legitimate revisits — the trigger remains the source of truth and
 * any drift will self-correct on the next true-new visitor.
 */
async function hasInMonthVisitorSession(
  supabase: SupabaseClient,
  workspaceId: string,
  visitorId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('visitor_sessions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('visitor_id', visitorId)
      .gte('created_at', startOfCurrentUtcMonthIso())
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn('[visitorLimit] in-month membership read failed:', error.message);
      return true;
    }
    return !!data;
  } catch (e: unknown) {
    console.warn('[visitorLimit] in-month membership read threw:', e instanceof Error ? e.message : e);
    return true;
  }
}

export async function enforceMaxVisitorsLimitIfNewThisMonth(
  req: Request,
  res: Response,
  supabase: SupabaseClient,
  workspaceId: string,
  visitorId: string,
): Promise<boolean> {
  // In-month revisit / reconnect / update → never consume the cap.
  if (await hasInMonthVisitorSession(supabase, workspaceId, visitorId)) {
    return true;
  }
  // True new-this-month visitor → defer to the shared limit middleware,
  // evaluated on the authorized workspace passed in, not on req.body.
  if (!workspaceId) {
    res.status(400).json({ error: 'Missing workspaceId for limit check' });
    return false;
  }
  setTrustedGateWorkspaceId(req, workspaceId);
  let proceeded = false;
  await visitorLimitMiddleware(req, res, () => {
    proceeded = true;
  });
  return proceeded;
}
