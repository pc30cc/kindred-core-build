// ============================================================================
// SIMPLE BILLING phase 4 — what the plan stops, beyond the computed row locks
// (docs/billing/SIMPLE_BILLING.md "Over the limit after a downgrade"; design
// §6): a channel the plan no longer has is stopped with its settings kept,
// and storage over the limit blocks new uploads only.
//
//   - Kill switch (S1): nothing here stops anything while the edition's
//     billing_settings.locks_enabled is off. Production keeps today's
//     behaviour until the Super Admin turns locks on after the preview.
//   - Channels fail open: a plan answer that cannot be read stops nothing
//     (the message is received). Only a definite "not in the plan" stops.
//   - Storage keeps the quota's own rule once the switch is on: requireLimit
//     ('storage_gb'), 403 at the limit, 503 when unreadable — the same gate
//     the chat, widget and generic uploads already pass.
//   - A self-host install with unlimited billing never stops anything.
// ============================================================================

import type { Request, Response } from 'express';
import type { ServerConfig } from '../../config.js';
import { checkChannelAccess, checkModuleAccess, requireLimit } from '../../middleware/featureGating.js';
import { setTrustedGateWorkspaceId } from '../../middleware/gateWorkspace.js';
import { getPluginDefinition } from '../../plugins/registry.js';
import { isUnreadableEntitlementReason } from './entitlementParse.js';
import { usageFnForLimit } from './usageResolvers.js';
import { locksEnabled } from './locks/state.js';
import { lockedErrorBody } from './locks/predicates.js';

/** The plan key a channel or plugin is sold under. */
export interface PlanStopTarget {
  kind: 'channel' | 'module';
  key: string;
}

/**
 * The plan key of a provider or plugin id: Telegram, Bale, WhatsApp,
 * Instagram, X, Gmail and Yahoo Mail are plan channels, the commerce
 * plugins the `commerce` module. The channel job provider `yahoo` is the
 * plugin `yahoomail`. Null when nothing in the plan gates it.
 */
export function planTargetOf(providerOrPluginId: string | null | undefined): PlanStopTarget | null {
  if (!providerOrPluginId) return null;
  const id = providerOrPluginId === 'yahoo' ? 'yahoomail' : providerOrPluginId;
  const def = getPluginDefinition(id);
  if (def?.planChannelKey) return { kind: 'channel', key: def.planChannelKey };
  if (def?.planModuleKey) return { kind: 'module', key: def.planModuleKey };
  return null;
}

/**
 * Whether the plan stops apply at all: the edition's switch is on and
 * billing is not unlimited. Never throws (unreadable = off, fail open).
 */
export async function planStopsActive(config: ServerConfig): Promise<boolean> {
  if (config.selfHostBillingUnlimited === true) return false;
  try {
    return await locksEnabled(config);
  } catch (e) {
    console.warn('[billing-locks] kill switch unreadable, nothing stopped:', e instanceof Error ? e.message : e);
    return false;
  }
}

const STOP_TTL_MS = 30_000;
const MAX_STOP_ENTRIES = 4000;
const stopCache = new Map<string, { stopped: boolean; expiresAt: number }>();

/** Forget the cached channel answers (of one workspace, or all). */
export function clearPlanStopCache(workspaceId?: string): void {
  if (!workspaceId) {
    stopCache.clear();
    return;
  }
  for (const key of stopCache.keys()) if (key.startsWith(`${workspaceId}:`)) stopCache.delete(key);
}

/**
 * Whether the plan in force stops `target` for the workspace: the switch is
 * on and the channel (module) check definitely says no — the override first,
 * then the plan, then the registry default, exactly as the route gates
 * decide. Cached 30 s per workspace and key (ingest runs per webhook).
 * Never throws: anything unreadable stops nothing.
 */
export async function isPlanStopped(
  config: ServerConfig,
  workspaceId: string,
  target: PlanStopTarget | null,
): Promise<boolean> {
  if (!target || !workspaceId) return false;
  if (!(await planStopsActive(config))) return false;
  const cacheKey = `${workspaceId}:${target.kind}:${target.key}`;
  const hit = stopCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.stopped;
  try {
    const check = target.kind === 'channel' ? checkChannelAccess : checkModuleAccess;
    const result = await check(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, target.key);
    if (result.allowed !== true && isUnreadableEntitlementReason(result.reason)) return false;
    const stopped = result.allowed !== true;
    stopCache.set(cacheKey, { stopped, expiresAt: Date.now() + STOP_TTL_MS });
    if (stopCache.size > MAX_STOP_ENTRIES) {
      const oldest = stopCache.keys().next().value;
      if (oldest !== undefined) stopCache.delete(oldest);
    }
    return stopped;
  } catch (e) {
    console.warn('[billing-locks] channel plan check failed, not stopped:', e instanceof Error ? e.message : e);
    return false;
  }
}

/** isPlanStopped for a channel provider or plugin id. */
export function isProviderStopped(config: ServerConfig, workspaceId: string, providerOrPluginId: string | null | undefined): Promise<boolean> {
  return isPlanStopped(config, workspaceId, planTargetOf(providerOrPluginId));
}

/** 403 body of a stopped channel: settings are kept, the plan has to come back. */
export function planLockedBody(): { error: 'plan_locked'; upgrade_required: true } {
  return lockedErrorBody('plan_locked') as { error: 'plan_locked'; upgrade_required: true };
}

/** `status` and `body` are the quota's own 403/503 answer when not allowed. */
export interface StorageGateResult {
  allowed: boolean;
  status: number;
  body: Record<string, unknown>;
}

const STORAGE_ALLOWED: StorageGateResult = Object.freeze({ allowed: true, status: 200, body: {} }) as StorageGateResult;

/**
 * The storage_gb gate for an upload path that has none of its own (design
 * §6: AI files, branding, avatars, inbound email attachments), while the
 * switch is on. Drives the shared requireLimit middleware in-process, as
 * mediaIngest.ts does, so the rule and the 403/503 bodies stay the quota's.
 */
export async function checkStorageUpload(config: ServerConfig, workspaceId: string): Promise<StorageGateResult> {
  if (!(await planStopsActive(config))) return STORAGE_ALLOWED;
  const gate = requireLimit('storage_gb', usageFnForLimit('storage_gb'));
  const req = { body: {}, query: {}, params: {}, serverConfig: config } as unknown as Request;
  setTrustedGateWorkspaceId(req, workspaceId);
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    status(code: number) { status = code; return res; },
    json(value: unknown) { body = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>; return res; },
  };
  let allowed = false;
  await gate(req, res as unknown as Response, () => { allowed = true; });
  return allowed ? STORAGE_ALLOWED : { allowed: false, status: status || 503, body };
}

/**
 * checkStorageUpload for a route: writes the 403/503 itself and returns
 * false when the upload must not go on.
 */
export async function storageUploadAllowed(
  config: ServerConfig,
  workspaceId: string,
  res: { status(code: number): { json(body: unknown): unknown } },
): Promise<boolean> {
  const gate = await checkStorageUpload(config, workspaceId);
  if (gate.allowed) return true;
  res.status(gate.status).json(gate.body);
  return false;
}
