/**
 * ============================================================
 * CALL RECORDING RETENTION — Effective-days resolver + stamper
 * ------------------------------------------------------------
 * Single source of truth for how many days a freshly-recorded
 * call recording should live. Used in two places, and only two:
 *
 *   1. `stampRetention()` — called at recording insert
 *      (`livekitWebhook.ts:egress_started`) to compute
 *      `retention_expires_at = created_at + effective_days`.
 *      `-1` (unlimited) → leaves `retention_expires_at` NULL,
 *      which the partial index + janitor query both treat as
 *      "never expires".
 *
 *   2. The retention janitor reads the column. It does NOT
 *      re-resolve per-row at sweep time — retention is locked
 *      at creation. This is intentional and documented in
 *      docs/CALL_RECORDING_RETENTION.md.
 *
 * Precedence (matches every other workspace numeric limit):
 *   workspace_limit_overrides.recording_retention_days
 *     → billing_plans.limits.recording_retention_days
 *       → CallControlPlane.retention_default_days (global default, 30)
 *
 * The first two are read through the existing canonical RPC
 * `check_workspace_entitlement`, so plan / override semantics
 * (including the "key not in plan" fall-through) match the rest
 * of the system. A negative value at any layer means unlimited.
 * ============================================================
 */

import type { ServerConfig } from '../../config.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { loadCallControlPlane } from '../calls/controlPlane.js';

export interface EffectiveRecordingRetention {
  /** Days. `-1` means unlimited (no expiry stamped, never deleted). */
  days: number;
  source: 'workspace_or_plan' | 'control_plane_default' | 'fallback';
}

export async function resolveEffectiveRecordingRetentionDays(
  config: ServerConfig,
  workspaceId: string,
): Promise<EffectiveRecordingRetention> {
  // 1) Plan + workspace override layer (canonical RPC).
  try {
    const ent = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      'recording_retention_days',
    );
    if (ent.allowed && typeof ent.limit === 'number') {
      return { days: ent.limit, source: 'workspace_or_plan' };
    }
  } catch {
    // Fall through to control plane.
  }

  // 2) Global control plane default (currently `retention_default_days`).
  try {
    const plane = await loadCallControlPlane(config);
    if (typeof plane.retention_default_days === 'number') {
      return { days: plane.retention_default_days, source: 'control_plane_default' };
    }
  } catch {
    /* fall through */
  }

  // 3) Conservative fallback. Matches the control-plane default constant.
  return { days: 30, source: 'fallback' };
}

/**
 * Pure helper. Given `created_at` and a resolved retention, return
 * the value to write into `call_recordings.retention_expires_at`.
 * `-1` (and any negative) → NULL ("never expires").
 */
export function computeRetentionExpiresAt(
  createdAtIso: string,
  retentionDays: number,
): string | null {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) return null;
  const created = new Date(createdAtIso).getTime();
  if (!Number.isFinite(created)) return null;
  return new Date(created + retentionDays * 24 * 60 * 60 * 1000).toISOString();
}