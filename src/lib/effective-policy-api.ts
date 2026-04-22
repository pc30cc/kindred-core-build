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
  // Phase 7.5 — enforcement throttling flags
  throttle_new_conversations?: boolean;
  slow_mode_messages?: boolean;
  operator_load_shedding?: boolean;
  priority_only_mode?: boolean;
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
  throttle_new_conversations: false,
  slow_mode_messages: false,
  operator_load_shedding: false,
  priority_only_mode: false,
  failover_epoch: 'safe-default',
  policy_version: 'safe-default',
  expires_at: 0,
};