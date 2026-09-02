/**
 * WORKSPACE INVITATIONS v5.1 — seat-entitlement bootstrap (blocker 4).
 *
 * PostgreSQL never reads an environment variable. On startup the server
 * validates its own configuration and persists the authoritative seat mode
 * into the protected singleton `public.workspace_seat_entitlement_mode`
 * through the service-role-only RPC `set_workspace_seat_entitlement_mode`.
 * The acceptance transaction then reads that row — a missing or unknown row
 * fails closed with ENTITLEMENT_UNAVAILABLE, never "unlimited".
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface SeatEntitlementSync {
  mode: 'plan_authoritative' | 'self_host_unlimited';
  seatLimit: number | null;
  configVersion: number | null;
  ok: boolean;
}

export async function syncSeatEntitlementMode(config: ServerConfig): Promise<SeatEntitlementSync> {
  const mode: SeatEntitlementSync['mode'] = config.selfHostBillingUnlimited
    ? 'self_host_unlimited'
    : 'plan_authoritative';

  let seatLimit: number | null = null;
  if (mode === 'plan_authoritative') {
    const raw = process.env.SELF_HOST_SEAT_LIMIT?.trim();
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    seatLimit = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  try {
    const { data, error } = await getServiceClient(config).rpc('set_workspace_seat_entitlement_mode', {
      _mode: mode,
      _source: mode === 'self_host_unlimited' ? 'SELF_HOST_BILLING_MODE=unlimited' : 'SELF_HOST_SEAT_LIMIT',
      _seat_limit: seatLimit,
      _updated_by: null,
    });

    if (error) {
      console.warn('[invitations] seat entitlement sync failed:', error.message);
      return { mode, seatLimit, configVersion: null, ok: false };
    }

    const row = (data || {}) as any;
    if (mode === 'plan_authoritative' && seatLimit === null) {
      console.warn(
        '[invitations] plan_authoritative mode without SELF_HOST_SEAT_LIMIT — invitation acceptance will fail closed with ENTITLEMENT_UNAVAILABLE until it is configured.',
      );
    }
    return { mode, seatLimit, configVersion: row.config_version ?? null, ok: true };
  } catch (err: any) {
    console.warn('[invitations] seat entitlement sync error:', err?.message || err);
    return { mode, seatLimit, configVersion: null, ok: false };
  }
}
