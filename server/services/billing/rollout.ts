// ============================================================
// BILLING ENGINE ROLLOUT — the per-workspace authority boundary.
//
// There is deliberately NO global "V2 is on" boolean. Each workspace carries a
// canonical, SERVER-AUTHORITATIVE state (`billing_v2_rollout.state`), so a
// mixed population — one workspace on V1, one shadowing, one fully on V2 — is
// the normal, tested operating mode. Nothing a client sends can change it.
//
//   legacy             V1 is the commercial authority. V2 creates no
//                      entitlement, no period, no allowance.
//   shadow             V1 is STILL the authority. V2 only computes and
//                      compares (eligibility, expected period/allowance,
//                      proration). Shadow has ZERO financial side effects.
//   v2_cutover_pending Activation is being prepared; still no V2 authority.
//   v2_active          The invoice is the ONLY commercial authority. Legacy
//                      payment → subscription and payment → AI credit paths
//                      are refused by the routes AND by the database.
//
// Transitions are MONOTONIC. Going back after `v2_active` could produce a
// double period or a double AI allowance, so it is not reachable from the
// admin API at all — only a deliberate, audited break-glass SQL call.
// ============================================================

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type RolloutState = 'legacy' | 'shadow' | 'v2_cutover_pending' | 'v2_active';

export interface CutoverBlocker {
  code: string;
  detail?: unknown;
  count?: number;
}

export interface CutoverReadiness {
  ready: boolean;
  blockers: CutoverBlocker[];
  classification: string;
  state: RolloutState;
  drainable_unbound_intents: number;
  wallet_account: boolean;
}

export interface ActivationResult {
  state: RolloutState;
  activated: boolean;
  replayed: boolean;
  from_state?: RolloutState;
  period_id?: string | null;
  period_created?: boolean;
  drained_unbound_intents?: number;
  classification?: string;
}

export class CutoverBlockedError extends Error {
  constructor(public readiness: CutoverReadiness) {
    super('billing_v2_cutover_blocked');
    this.name = 'CutoverBlockedError';
  }
}

/** Raised when a legacy financial path is attempted on a V2-owned workspace. */
export class LegacyPathRejectedError extends Error {
  constructor(
    public path: string,
    public nextAction: string,
  ) {
    super('BILLING_V2_REQUIRED');
    this.name = 'LegacyPathRejectedError';
  }
}

// ─── Metrics (no secrets, workspace-scoped counters only) ──────────────────
export const V2_METRICS = {
  billing_v2_shadow_period_mismatch: 0,
  billing_v2_shadow_plan_mismatch: 0,
  billing_v2_shadow_allowance_mismatch: 0,
  billing_v2_cutover_blocked: 0,
  billing_v2_legacy_intent_blocker: 0,
  billing_v2_legacy_path_rejected: 0,
  // Phase C — scheduler health counters.
  billing_v2_invoice_scheduler_failures: 0,
  billing_v2_wallet_autopay_failures: 0,
  billing_v2_period_activation_failures: 0,
};
export type V2MetricName = keyof typeof V2_METRICS;

export function bumpMetric(name: V2MetricName, by = 1): void {
  V2_METRICS[name] += by;
}

export function readMetrics(): Record<string, number> {
  return { ...V2_METRICS };
}

/** Appends a rollout audit row. Never throws into a financial path. */
export async function auditV2(
  config: ServerConfig,
  input: {
    workspaceId?: string | null;
    event: string;
    actorId?: string | null;
    reason?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await getServiceClient(config).from('billing_v2_audit').insert({
      workspace_id: input.workspaceId ?? null,
      event: input.event,
      actor_id: input.actorId ?? null,
      reason: input.reason ?? null,
      details: input.details ?? {},
    });
  } catch {
    /* auditing must never break a payment */
  }
}

export async function getRolloutState(
  config: ServerConfig,
  workspaceId: string,
): Promise<RolloutState> {
  const { data } = await getServiceClient(config)
    .from('billing_v2_rollout')
    .select('state')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  return ((data as { state?: string } | null)?.state as RolloutState) || 'legacy';
}

/** True only for `v2_active`. Shadow is NEVER an authority. */
export async function isV2Active(config: ServerConfig, workspaceId: string): Promise<boolean> {
  return (await getRolloutState(config, workspaceId)) === 'v2_active';
}

export async function evaluateCutover(
  config: ServerConfig,
  workspaceId: string,
): Promise<CutoverReadiness> {
  const { data, error } = await getServiceClient(config).rpc('billing_v2_evaluate_cutover', {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error(`billing_v2_readiness_failed:${error.message}`);
  const readiness = data as CutoverReadiness;
  if (!readiness.ready) {
    bumpMetric('billing_v2_cutover_blocked');
    if (readiness.blockers.some((b) => b.code.startsWith('legacy_intent'))) {
      bumpMetric('billing_v2_legacy_intent_blocker');
    }
  }
  return readiness;
}

/** Enables shadow computation. Explicitly NOT a financial change. */
export async function enableShadow(
  config: ServerConfig,
  input: { workspaceId: string; actorId?: string | null; reason?: string | null },
): Promise<{ state: RolloutState; changed: boolean }> {
  const { data, error } = await getServiceClient(config).rpc('billing_v2_set_state', {
    p_workspace_id: input.workspaceId,
    p_state: 'shadow',
    p_actor_id: input.actorId ?? null,
    p_reason: input.reason ?? null,
    p_break_glass: false,
  });
  if (error) throw new Error(`billing_v2_shadow_failed:${error.message}`);
  return data as { state: RolloutState; changed: boolean };
}

/**
 * Activates V2 for ONE workspace.
 *
 * The whole cutover (lock → readiness re-check → legacy intent drain → wallet →
 * first period → state transition → audit) happens inside the SQL function, in
 * a single transaction. A check here followed by an update in another request
 * would be exactly the race that lets a legacy checkout slip through.
 */
export async function activateV2(
  config: ServerConfig,
  input: { workspaceId: string; actorId?: string | null; reason?: string | null },
): Promise<ActivationResult> {
  const { data, error } = await getServiceClient(config).rpc('billing_v2_activate', {
    p_workspace_id: input.workspaceId,
    p_actor_id: input.actorId ?? null,
    p_reason: input.reason ?? null,
  });
  if (error) {
    const msg = String(error.message || '');
    const marker = 'billing_v2_cutover_blocked:';
    if (msg.includes(marker)) {
      bumpMetric('billing_v2_cutover_blocked');
      const json = msg.slice(msg.indexOf(marker) + marker.length).trim();
      let readiness: CutoverReadiness;
      try {
        readiness = JSON.parse(json) as CutoverReadiness;
      } catch {
        readiness = {
          ready: false,
          blockers: [{ code: 'unparsed_blockers', detail: json }],
          classification: 'unknown',
          state: 'legacy',
          drainable_unbound_intents: 0,
          wallet_account: false,
        };
      }
      throw new CutoverBlockedError(readiness);
    }
    throw new Error(`billing_v2_activation_failed:${msg}`);
  }
  return data as ActivationResult;
}

/**
 * Fail-closed boundary used by every legacy financial route.
 *
 * Throws `LegacyPathRejectedError` when the workspace is V2-owned, so an old
 * deployed frontend gets a structured `BILLING_V2_REQUIRED` response instead of
 * an unsafe fallback into V1.
 */
export async function assertLegacyPathAllowed(
  config: ServerConfig,
  input: { workspaceId: string; path: string; nextAction: string },
): Promise<void> {
  if (!(await isV2Active(config, input.workspaceId))) return;
  bumpMetric('billing_v2_legacy_path_rejected');
  await auditV2(config, {
    workspaceId: input.workspaceId,
    event: 'billing_v2_legacy_path_rejected',
    reason: input.path,
  });
  throw new LegacyPathRejectedError(input.path, input.nextAction);
}
