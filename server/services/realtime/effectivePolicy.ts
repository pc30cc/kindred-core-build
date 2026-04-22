/**
 * Phase 6C — Effective Realtime Policy snapshot.
 *
 * Single derivation point shared by the three handshake endpoints:
 *   - /api/realtime/operator-connect
 *   - /api/widget/bootstrap
 *   - /api/widget/session/refresh
 *
 * Inputs (read-only):
 *   • Realtime control-plane settings (Phase 6A)        — degradation policy
 *   • Failover engine state           (Phase 6B)        — effective_provider
 *   • Active auto-actions cache       (Phase 5C/5C.1)   — runtime overrides
 *
 * Output: a small, public-safe payload that:
 *   1. Tells clients which transport to use (`effective_provider`).
 *   2. Tells clients to suppress typing / force polling / back off harder.
 *   3. Carries an `failover_epoch` and `policy_version` so clients can
 *      detect transitions across handshakes and reset transport cleanly.
 *
 * No secrets. Never throws — falls back to a safe permissive snapshot
 * (vendor=centrifugo, no overrides) if any underlying read fails.
 */

import crypto from 'crypto';
import type { ServerConfig } from '../../config.js';
import { loadControlPlane, type RealtimeProviderId } from './controlPlane.js';
import { loadFailoverState } from './failoverState.js';
import { isActionActive } from '../observability/autoActionsCache.js';
import { loadCallControlPlane } from '../calls/controlPlane.js';

export type EffectiveProviderWire =
  | 'centrifugo'
  | 'supabase'
  | 'polling_builtin'
  | 'disabled';

/**
 * Snapshot returned to clients on every handshake.
 * The payload is intentionally tiny — clients only need enough to decide
 * "do I need to reset transport?" and "how should I throttle?".
 */
export interface EffectivePolicySnapshot {
  /** Transport vendor the client should bind to. */
  effective_provider: EffectiveProviderWire;
  /** True iff a manual provider lock is active (admin override). */
  provider_locked: boolean;
  /** True iff the platform is in degraded mode (information only). */
  degraded_mode: boolean;
  /** True iff clients should disconnect WS and use polling. */
  force_polling: boolean;
  /** True iff clients should stop emitting typing events. */
  typing_suppressed: boolean;
  /** Multiplier to apply to client reconnect backoff (≥1). */
  reconnect_backoff_multiplier: number;
  /** Phase 7.5 — widget should slow new conversation creation. */
  throttle_new_conversations: boolean;
  /** Phase 7.5 — widget should add a small delay between messages. */
  slow_mode_messages: boolean;
  /** Phase 7.5 — operator UI reduces non-critical polling/subscriptions. */
  operator_load_shedding: boolean;
  /** Phase 7.5 — only high-priority conversations use realtime, others poll. */
  priority_only_mode: boolean;
  /** Phase 8A — Voice/Video call policy (read-only for clients). */
  effective_call_provider: 'livekit' | 'jitsi' | 'janus' | 'agora_cloud' | 'disabled';
  call_degraded_mode: boolean;
  audio_only_mode: boolean;
  video_disabled: boolean;
  recording_forced: boolean;
  call_failover_epoch: string;
  /**
   * Bumped whenever the *transport target* changes (vendor switch,
   * lock change, or force_polling toggle). Clients MUST reset transport
   * when this changes.
   */
  failover_epoch: string;
  /**
   * Bumped on any policy change including non-transport ones (typing
   * suppression toggling, backoff multiplier change). Clients reapply
   * non-transport policy when this changes.
   */
  policy_version: string;
  /** When this snapshot expires (informational; clients re-read on next handshake). */
  expires_at: number;
}

/** TTL the client may treat the snapshot as fresh for. */
const POLICY_SNAPSHOT_TTL_MS = 60_000;

const SAFE_DEFAULT: EffectivePolicySnapshot = {
  effective_provider: 'centrifugo',
  provider_locked: false,
  degraded_mode: false,
  force_polling: false,
  typing_suppressed: false,
  reconnect_backoff_multiplier: 1,
  throttle_new_conversations: false,
  slow_mode_messages: false,
  operator_load_shedding: false,
  priority_only_mode: false,
  effective_call_provider: 'disabled',
  call_degraded_mode: false,
  audio_only_mode: false,
  video_disabled: false,
  recording_forced: false,
  call_failover_epoch: 'safe-default',
  failover_epoch: 'safe-default',
  policy_version: 'safe-default',
  expires_at: Date.now() + POLICY_SNAPSHOT_TTL_MS,
};

/**
 * Map the engine's provider id onto the wire vendor name clients
 * understand. Keep stable — the widget runtime / operator client both
 * compare this string for transport reset decisions.
 */
function toWireVendor(p: RealtimeProviderId): EffectiveProviderWire {
  if (p === 'centrifugo') return 'centrifugo';
  if (p === 'supabase_realtime') return 'supabase';
  return 'polling_builtin';
}

/**
 * Compute a short, stable digest of the inputs that determine TRANSPORT.
 * Anything in this hash forces the client to tear down the socket on
 * change. Keep the surface tight — adding fields here makes clients
 * reconnect more often.
 */
function computeFailoverEpoch(input: {
  effective_provider: EffectiveProviderWire;
  provider_locked: boolean;
  force_polling: boolean;
  last_failover_at: string | null;
}): string {
  const h = crypto.createHash('sha1');
  h.update(input.effective_provider);
  h.update('|');
  h.update(input.provider_locked ? '1' : '0');
  h.update('|');
  h.update(input.force_polling ? '1' : '0');
  h.update('|');
  h.update(input.last_failover_at || '');
  return h.digest('hex').slice(0, 12);
}

/**
 * Compute a digest covering ALL policy bits (transport + non-transport).
 * Bumping this without bumping `failover_epoch` means clients should
 * reapply non-transport behavior (typing, backoff) without tearing down.
 */
function computePolicyVersion(snap: Omit<EffectivePolicySnapshot, 'policy_version' | 'expires_at'>): string {
  const h = crypto.createHash('sha1');
  h.update(snap.effective_provider);
  h.update('|');
  h.update(snap.provider_locked ? '1' : '0');
  h.update('|');
  h.update(snap.degraded_mode ? '1' : '0');
  h.update('|');
  h.update(snap.force_polling ? '1' : '0');
  h.update('|');
  h.update(snap.typing_suppressed ? '1' : '0');
  h.update('|');
  h.update(String(snap.reconnect_backoff_multiplier));
  h.update('|');
  h.update(snap.throttle_new_conversations ? '1' : '0');
  h.update('|');
  h.update(snap.slow_mode_messages ? '1' : '0');
  h.update('|');
  h.update(snap.operator_load_shedding ? '1' : '0');
  h.update('|');
  h.update(snap.priority_only_mode ? '1' : '0');
  h.update('|');
  h.update(snap.effective_call_provider);
  h.update('|');
  h.update(snap.call_degraded_mode ? '1' : '0');
  h.update('|');
  h.update(snap.audio_only_mode ? '1' : '0');
  h.update('|');
  h.update(snap.video_disabled ? '1' : '0');
  h.update('|');
  h.update(snap.recording_forced ? '1' : '0');
  h.update('|');
  h.update(snap.call_failover_epoch);
  h.update('|');
  h.update(snap.failover_epoch);
  return h.digest('hex').slice(0, 12);
}

/**
 * Resolve the public effective policy snapshot to embed in handshakes.
 * Never throws; returns the safe default on any failure.
 */
export async function resolveEffectivePolicy(
  config: ServerConfig,
): Promise<EffectivePolicySnapshot> {
  try {
    const [policy, state, callCp] = await Promise.all([
      loadControlPlane(config, false),
      loadFailoverState(config, false),
      loadCallControlPlane(config, false).catch(() => null),
    ]);

    // 1. Effective provider — manual lock overrides engine state.
    const targetId: RealtimeProviderId =
      policy.realtime_provider_lock ?? state.effective_provider;
    let effective: EffectiveProviderWire = toWireVendor(targetId);

    // 2. Auto-actions overlay. Hot-path safe — no DB call.
    const forcePollingAction = isActionActive('force_polling_mode');
    const typingSuppressed = isActionActive('disable_typing_temporarily');
    const degradedMode = isActionActive('mark_system_degraded');
    const backoffActionActive = isActionActive('increase_reconnect_backoff');
    // Phase 7.5 — enforcement actions overlay.
    const throttle_new_conversations = isActionActive('throttle_new_conversations');
    const slow_mode_messages = isActionActive('slow_mode_messages');
    const operator_load_shedding = isActionActive('operator_load_shedding');
    const priority_only_mode = isActionActive('priority_only_mode');

    // Combine with control-plane degradation toggles. The control-plane
    // booleans are intent flags — they only take effect when the platform
    // is currently degraded. We treat the `mark_system_degraded` auto-action
    // as the single source of truth for "degraded right now".
    const policyDegraded = degradedMode && policy.realtime_degraded_mode_enabled;

    const force_polling =
      forcePollingAction ||
      (policyDegraded && policy.realtime_force_polling_on_critical_degradation);

    if (force_polling && effective !== 'polling_builtin') {
      effective = 'polling_builtin';
    }

    const typing_suppressed =
      typingSuppressed ||
      (policyDegraded && policy.realtime_disable_typing_on_overload);

    const reconnect_backoff_multiplier =
      backoffActionActive || policyDegraded
        ? Math.max(1, policy.realtime_reconnect_backoff_multiplier_on_overload)
        : 1;

    const provider_locked = !!policy.realtime_provider_lock;

    const failover_epoch = computeFailoverEpoch({
      effective_provider: effective,
      provider_locked,
      force_polling,
      last_failover_at: state.last_failover_at,
    });

    // Phase 8A — call policy overlay. We only surface intent flags here;
    // actual call routing is done in /api/calls via the call provider
    // resolver. Clients use these to decide whether to render call UI.
    const callDegraded = isActionActive('mark_system_degraded') && (callCp?.enabled ?? false);
    const audio_only_mode = isActionActive('audio_only_mode');
    const video_disabled = isActionActive('video_disabled') || audio_only_mode;
    const recording_forced = isActionActive('recording_forced');
    const effective_call_provider = (callCp?.enabled ? callCp.primary_provider : 'disabled');
    const call_failover_epoch = crypto
      .createHash('sha1')
      .update(`${effective_call_provider}|${callDegraded ? 1 : 0}|${audio_only_mode ? 1 : 0}|${video_disabled ? 1 : 0}|${recording_forced ? 1 : 0}`)
      .digest('hex')
      .slice(0, 12);

    const baseSnap: Omit<EffectivePolicySnapshot, 'policy_version' | 'expires_at'> = {
      effective_provider: effective,
      provider_locked,
      degraded_mode: policyDegraded,
      force_polling,
      typing_suppressed,
      reconnect_backoff_multiplier,
      throttle_new_conversations,
      slow_mode_messages,
      operator_load_shedding,
      priority_only_mode,
      effective_call_provider,
      call_degraded_mode: callDegraded,
      audio_only_mode,
      video_disabled,
      recording_forced,
      call_failover_epoch,
      failover_epoch,
    };

    const policy_version = computePolicyVersion(baseSnap);

    return {
      ...baseSnap,
      policy_version,
      expires_at: Date.now() + POLICY_SNAPSHOT_TTL_MS,
    };
  } catch (err: any) {
    // Fail-open: never block a handshake on policy resolution.
    return { ...SAFE_DEFAULT, expires_at: Date.now() + POLICY_SNAPSHOT_TTL_MS };
  }
}

/** Public alias for clients/UIs that want the raw default. */
export function getSafeDefaultPolicy(): EffectivePolicySnapshot {
  return { ...SAFE_DEFAULT, expires_at: Date.now() + POLICY_SNAPSHOT_TTL_MS };
}