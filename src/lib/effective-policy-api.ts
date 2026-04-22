/**
 * Phase 6C — Public types for the effective realtime policy snapshot
 * embedded in handshake responses.
 */
export type EffectiveProviderWire =
  | 'centrifugo'
  | 'supabase'
  | 'polling_builtin'
  | 'disabled';

export interface EffectivePolicySnapshot {
  effective_provider: EffectiveProviderWire;
  provider_locked: boolean;
  degraded_mode: boolean;
  force_polling: boolean;
  typing_suppressed: boolean;
  reconnect_backoff_multiplier: number;
  failover_epoch: string;
  policy_version: string;
  expires_at: number;
}

export const SAFE_DEFAULT_POLICY: EffectivePolicySnapshot = {
  effective_provider: 'centrifugo',
  provider_locked: false,
  degraded_mode: false,
  force_polling: false,
  typing_suppressed: false,
  reconnect_backoff_multiplier: 1,
  failover_epoch: 'safe-default',
  policy_version: 'safe-default',
  expires_at: 0,
};