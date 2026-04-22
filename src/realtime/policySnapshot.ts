/**
 * Phase 6C — process-wide singleton snapshot of the effective realtime
 * policy. Updated by the React-side `useEffectivePolicy` hook on every
 * handshake response. Read synchronously from low-level adapters
 * (e.g. the Centrifugo reconnect scheduler) that can't take a React
 * dependency.
 *
 * Safe defaults: multiplier=1, suppression off. Never throws.
 */
import {
  SAFE_DEFAULT_POLICY,
  type EffectivePolicySnapshot,
} from '@/lib/effective-policy-api';

let current: EffectivePolicySnapshot = { ...SAFE_DEFAULT_POLICY };

export function setEffectivePolicySnapshot(p: EffectivePolicySnapshot | null | undefined): void {
  if (!p) return;
  current = p;
}

export function getEffectivePolicySnapshot(): EffectivePolicySnapshot {
  return current;
}

/** Convenience getters for hot paths. Always finite, always safe. */
export function getReconnectBackoffMultiplier(): number {
  const m = Number(current.reconnect_backoff_multiplier);
  if (!Number.isFinite(m) || m < 1) return 1;
  if (m > 10) return 10; // hard ceiling — no runaway delays
  return m;
}

export function isTypingSuppressed(): boolean {
  return !!current.typing_suppressed;
}

export function isForcePolling(): boolean {
  return !!current.force_polling;
}

export function isDegraded(): boolean {
  return !!current.degraded_mode || !!current.force_polling;
}