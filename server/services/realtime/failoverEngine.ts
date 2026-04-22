/**
 * Phase 6B — Realtime Failover Engine.
 *
 * Pure decision logic. Given:
 *   • the control-plane policy (priority order, lock, thresholds, cooldowns)
 *   • the latest per-provider health snapshot
 *   • the persisted failover state
 *   • the current wall-clock time
 *
 * …produces the next FailoverState (no side effects).
 *
 * Algorithm:
 *   1. If realtime_provider_lock is set → effective = lock, no automation.
 *   2. Else if !realtime_failover_enabled → effective = first provider in
 *      the configured order (i.e. the desired primary). No flapping.
 *   3. Else evaluate:
 *        - Walk the priority order. Pick the first provider whose health is
 *          NOT 'unhealthy'.
 *        - If all are unhealthy, force polling_builtin (last-resort).
 *        - Compare to the current persisted effective_provider:
 *            • Same → no transition. Update last_health + clear stale
 *              candidate fields if current provider is healthy again.
 *            • Different + lower-priority → FAILOVER. Apply only if cooldown
 *              has expired. Set cooldown_until = now + cooldown_seconds.
 *            • Different + higher-priority → FAILBACK candidate. Track since
 *              when the higher-priority provider has been healthy. Switch
 *              only after `realtime_failback_stable_window_seconds` AND
 *              `realtime_failback_enabled`.
 *
 * The engine never reads or writes — that's the ticker's job. It returns a
 * pure decision so it stays trivially testable.
 */

import type {
  RealtimeControlPlaneConfig,
  RealtimeProviderId,
} from './controlPlane.js';
import type {
  HealthSnapshot,
  ProviderHealthStatus,
  ProviderHealthSignal,
} from './failoverHealth.js';
import type { FailoverState } from './failoverState.js';

export type FailoverTransitionKind =
  | 'none'
  | 'failover'
  | 'failback'
  | 'last_resort'
  | 'lock_applied'
  | 'lock_cleared';

export interface FailoverDecision {
  next: FailoverState;
  transition: {
    kind: FailoverTransitionKind;
    from_provider: RealtimeProviderId | null;
    to_provider: RealtimeProviderId;
    reason: string;
    evidence: Record<string, unknown>;
  } | null;
}

const PROVIDERS_REQUIRING_PROBE: ReadonlySet<RealtimeProviderId> = new Set([
  'centrifugo',
]);

function isUsable(status: ProviderHealthStatus): boolean {
  // 'degraded' is still preferable to switching providers — keep serving on
  // the degraded primary until it goes 'unhealthy'.
  return status !== 'unhealthy';
}

function pickFirstUsable(
  order: RealtimeProviderId[],
  health: HealthSnapshot,
): { provider: RealtimeProviderId; lastResort: boolean } {
  for (const p of order) {
    const sig = health.providers[p];
    if (!sig) continue;
    // For providers that need a real probe (centrifugo), 'unknown' counts as
    // unhealthy because we couldn't confirm liveness. For the others
    // ('unknown' from missing samples) we treat it as healthy so we don't
    // failover on no signal.
    if (PROVIDERS_REQUIRING_PROBE.has(p) && sig.status === 'unknown') continue;
    if (isUsable(sig.status)) return { provider: p, lastResort: false };
  }
  return { provider: 'polling_builtin', lastResort: true };
}

function priorityIndex(order: RealtimeProviderId[], p: RealtimeProviderId): number {
  const i = order.indexOf(p);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

function summariseEvidence(sig: ProviderHealthSignal | undefined): Record<string, unknown> {
  if (!sig) return {};
  return {
    status: sig.status,
    error_rate: sig.error_rate,
    p95_latency_ms: sig.p95_latency_ms,
    sample_size: sig.sample_size,
    reason: sig.reason,
  };
}

export function decideFailover(
  policy: RealtimeControlPlaneConfig,
  health: HealthSnapshot,
  prev: FailoverState,
  nowMs: number = Date.now(),
): FailoverDecision {
  const nowIso = new Date(nowMs).toISOString();
  const baseNext: FailoverState = {
    ...prev,
    last_health: health.providers as unknown as Record<string, unknown>,
    last_evaluated_at: nowIso,
  };

  // 1. Manual lock — overrides automation entirely.
  if (policy.realtime_provider_lock) {
    const locked = policy.realtime_provider_lock;
    if (prev.effective_provider !== locked) {
      return {
        next: {
          ...baseNext,
          effective_provider: locked,
          last_failover_at: nowIso,
          last_failover_reason: `lock_applied:${locked}`,
          candidate_recovery_provider: null,
          candidate_recovery_since: null,
          failback_eligible_at: null,
          // Locks bypass cooldown — operator explicitly chose this.
          cooldown_until: null,
        },
        transition: {
          kind: 'lock_applied',
          from_provider: prev.effective_provider,
          to_provider: locked,
          reason: 'manual provider lock applied',
          evidence: { locked_provider: locked },
        },
      };
    }
    // Already on the locked provider — keep state stable, just clear
    // recovery tracking which is meaningless under a lock.
    return {
      next: {
        ...baseNext,
        candidate_recovery_provider: null,
        candidate_recovery_since: null,
        failback_eligible_at: null,
      },
      transition: null,
    };
  }

  // 2. Failover disabled — keep the desired primary (top of order).
  if (!policy.realtime_failover_enabled) {
    const desired = policy.realtime_provider_order[0] ?? 'centrifugo';
    if (prev.effective_provider !== desired) {
      // Only switch back to desired if it's at least 'usable' or if the
      // current pick is 'unhealthy' (e.g. last-resort polling sticking).
      const desiredSig = health.providers[desired];
      const okToSwitch = !desiredSig || isUsable(desiredSig.status);
      if (okToSwitch) {
        return {
          next: {
            ...baseNext,
            effective_provider: desired,
            last_failover_at: nowIso,
            last_failover_reason: 'failover_disabled_realigned',
            candidate_recovery_provider: null,
            candidate_recovery_since: null,
            failback_eligible_at: null,
            cooldown_until: null,
          },
          transition: {
            kind: 'lock_cleared',
            from_provider: prev.effective_provider,
            to_provider: desired,
            reason: 'failover_disabled — realigned to configured primary',
            evidence: summariseEvidence(desiredSig),
          },
        };
      }
    }
    return { next: baseNext, transition: null };
  }

  // 3. Automatic failover / failback path.
  const order = policy.realtime_provider_order;
  const pick = pickFirstUsable(order, health);
  const currentIdx = priorityIndex(order, prev.effective_provider);
  const pickIdx = priorityIndex(order, pick.provider);

  // Same provider — clear stale candidate tracking when we're back on the
  // top-priority option, otherwise leave state alone.
  if (pick.provider === prev.effective_provider) {
    return {
      next: {
        ...baseNext,
        candidate_recovery_provider: null,
        candidate_recovery_since: null,
        failback_eligible_at: null,
      },
      transition: null,
    };
  }

  // Different provider chosen.
  // 3a. Lower-priority pick → FAILOVER (requires cooldown).
  if (pickIdx > currentIdx) {
    const cooldownUntilMs = prev.cooldown_until
      ? new Date(prev.cooldown_until).getTime()
      : 0;
    if (cooldownUntilMs > nowMs) {
      // Cooldown active — refuse to flap.
      return {
        next: {
          ...baseNext,
          // Track the pending change so UI can display it; do not switch.
          candidate_recovery_provider: null,
          candidate_recovery_since: null,
        },
        transition: null,
      };
    }
    const newCooldownUntil = new Date(
      nowMs + policy.realtime_failover_cooldown_seconds * 1000,
    ).toISOString();
    return {
      next: {
        ...baseNext,
        effective_provider: pick.provider,
        last_failover_at: nowIso,
        last_failover_reason: pick.lastResort
          ? 'all_providers_unhealthy_last_resort'
          : `primary_unhealthy:${prev.effective_provider}`,
        cooldown_until: newCooldownUntil,
        candidate_recovery_provider: null,
        candidate_recovery_since: null,
        failback_eligible_at: null,
      },
      transition: {
        kind: pick.lastResort ? 'last_resort' : 'failover',
        from_provider: prev.effective_provider,
        to_provider: pick.provider,
        reason: pick.lastResort
          ? 'all configured providers unhealthy — falling back to polling'
          : `primary ${prev.effective_provider} unhealthy`,
        evidence: {
          chosen: summariseEvidence(health.providers[pick.provider]),
          previous: summariseEvidence(health.providers[prev.effective_provider]),
        },
      },
    };
  }

  // 3b. Higher-priority pick → FAILBACK (requires stable window + enabled).
  // pickIdx < currentIdx
  if (!policy.realtime_failback_enabled) {
    return { next: baseNext, transition: null };
  }
  const candidate = pick.provider;
  const stableNeededS = policy.realtime_failback_stable_window_seconds;

  if (
    prev.candidate_recovery_provider === candidate &&
    prev.candidate_recovery_since
  ) {
    const sinceMs = new Date(prev.candidate_recovery_since).getTime();
    const eligibleAtMs = sinceMs + stableNeededS * 1000;
    if (nowMs >= eligibleAtMs) {
      // Stable window cleared — failback now.
      const newCooldownUntil = new Date(
        nowMs + policy.realtime_failover_cooldown_seconds * 1000,
      ).toISOString();
      return {
        next: {
          ...baseNext,
          effective_provider: candidate,
          last_failover_at: nowIso,
          last_failover_reason: `failback_to:${candidate}`,
          cooldown_until: newCooldownUntil,
          candidate_recovery_provider: null,
          candidate_recovery_since: null,
          failback_eligible_at: null,
        },
        transition: {
          kind: 'failback',
          from_provider: prev.effective_provider,
          to_provider: candidate,
          reason: `${candidate} stable for ≥${stableNeededS}s — failback`,
          evidence: {
            stable_since: prev.candidate_recovery_since,
            chosen: summariseEvidence(health.providers[candidate]),
          },
        },
      };
    }
    // Still warming up — keep the timer.
    return {
      next: {
        ...baseNext,
        failback_eligible_at: new Date(eligibleAtMs).toISOString(),
      },
      transition: null,
    };
  }

  // First evaluation that sees a healthy higher-priority provider — start
  // the stable window timer.
  const eligibleAtMs = nowMs + stableNeededS * 1000;
  return {
    next: {
      ...baseNext,
      candidate_recovery_provider: candidate,
      candidate_recovery_since: nowIso,
      failback_eligible_at: new Date(eligibleAtMs).toISOString(),
    },
    transition: null,
  };
}