// ============================================================================
// SIMPLE BILLING phase 4 — the downgrade report (design §9): before a
// downgrade is confirmed, exactly what the target plan would lock.
//
// The SQL (billing_lock_report, migration 264) counts the locked rows as if
// the kill switch were on, so the report is also a preview while it is off
// (`locks_enabled` says which). This module adds what SQL cannot know: the
// modules and channels the target plan stops (registry-aware, the workspace's
// overrides kept), whether each is in use, and the monthly AI credit change.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getWorkspacePlanInfoDetailed } from '../../../middleware/featureGating.js';
import { resolveEffectiveEntitlements, type FlagOverrideRow } from '../effectiveEntitlements.js';
import { getCapability } from '../capabilityRegistry.js';
import { isRelationMissing } from '../entitlementParse.js';
import { PLUGIN_REGISTRY } from '../../../plugins/registry.js';
import { getPlatformEditionOrNull } from '../../platformRegion.js';
import { isChannelAllowedInEdition } from '../../../../shared/edition.js';
import { readEffectivePlanId } from './state.js';

export interface LockReportCount {
  limit: number | null;
  total: number;
  locked: number;
}

export interface LockReport {
  /** The kill switch; while off the counts are a preview and nothing locks. */
  locks_enabled: boolean;
  plan_id: string;
  kb_article: LockReportCount & { items: Array<{ id: string; title: string | null }> };
  contact: LockReportCount;
  /** limit: max_agents (the owner's seat included); total: the seats held now. */
  member: { limit: number | null; total: number; locked: number; items: Array<{ user_id: string; name: string | null; email: string | null }> };
  /** cutoff: chats whose last activity is before it are locked. */
  conversation: { retention_days: number | null; total: number; locked: number; cutoff: string | null; oldest_kept: string | null };
  conversation_quota: { limit: number | null; used_this_month: number; full: boolean };
  storage: { limit_gb: number | null; used_gb: number; uploads_blocked: boolean };
  /** Days locked data is kept before deletion (null = never deleted). */
  locked_data_retention_days: number | null;
  first_deletion_not_before: string | null;
  /** Modules on now that the target plan stops (their data and settings are kept). */
  modules_lost: Array<{ key: string; in_use: boolean }>;
  /** Channels likewise; messages to a stopped channel are not received meanwhile. */
  channels_lost: Array<{ key: string; in_use: boolean }>;
  channels_stop_messages: boolean;
  /** The plan's monthly AI credit, now and on the target plan (purchased credit is kept). */
  ai_credits: { current: number | null; target: number | null };
  /** Anything listed above is locked, stopped or blocked. */
  has_locks: boolean;
}

// ─── The SQL part ─────────────────────────────────────────────────────────

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

const ITEMS_CAP = 50;

/** billing_lock_report's jsonb, read leniently: a missing part counts as nothing locked. */
export function parseSqlLockReport(raw: unknown, planId: string): Omit<LockReport, 'modules_lost' | 'channels_lost' | 'channels_stop_messages' | 'ai_credits' | 'has_locks'> {
  const r = rec(raw);
  const kb = rec(r.kb_article);
  const contact = rec(r.contact);
  const member = rec(r.member);
  const conversation = rec(r.conversation);
  const quota = rec(r.conversation_quota);
  const storage = rec(r.storage);
  const list = (value: unknown) => (Array.isArray(value) ? value.slice(0, ITEMS_CAP).map(rec) : []);
  return {
    locks_enabled: r.locks_enabled === true,
    plan_id: planId,
    kb_article: {
      limit: numOrNull(kb.limit),
      total: num(kb.total),
      locked: num(kb.locked),
      items: list(kb.items).map((i) => ({ id: String(i.id ?? ''), title: strOrNull(i.title) })).filter((i) => i.id),
    },
    contact: { limit: numOrNull(contact.limit), total: num(contact.total), locked: num(contact.locked) },
    member: {
      limit: numOrNull(member.limit),
      total: num(member.total),
      locked: num(member.locked),
      items: list(member.items)
        .map((i) => ({ user_id: String(i.user_id ?? ''), name: strOrNull(i.name), email: strOrNull(i.email) }))
        .filter((i) => i.user_id),
    },
    conversation: {
      retention_days: numOrNull(conversation.retention_days),
      total: num(conversation.total),
      locked: num(conversation.locked),
      cutoff: strOrNull(conversation.cutoff),
      oldest_kept: strOrNull(conversation.oldest_kept),
    },
    conversation_quota: {
      limit: numOrNull(quota.limit),
      used_this_month: num(quota.used_this_month),
      full: quota.full === true,
    },
    storage: {
      limit_gb: numOrNull(storage.limit_gb),
      used_gb: num(storage.used_gb),
      uploads_blocked: storage.uploads_blocked === true,
    },
    locked_data_retention_days: numOrNull(r.locked_data_retention_days),
    first_deletion_not_before: strOrNull(r.first_deletion_not_before),
  };
}

// ─── Modules, channels, AI credit ─────────────────────────────────────────

interface TargetPlanRow {
  id: string;
  entitlements: Record<string, unknown> | null;
  limits: Record<string, unknown> | null;
}

/** Module and channel keys a plugin installation stands for (registry.ts planModuleKey / planChannelKey). */
function pluginKeys(pluginId: string): { module: string | null; channel: string | null } {
  const def = PLUGIN_REGISTRY.find((p) => p.id === pluginId);
  return { module: def?.planModuleKey ?? null, channel: def?.planChannelKey ?? null };
}

type Extras = Pick<LockReport, 'modules_lost' | 'channels_lost' | 'channels_stop_messages' | 'ai_credits'>;

const NO_EXTRAS: Extras = { modules_lost: [], channels_lost: [], channels_stop_messages: false, ai_credits: { current: null, target: null } };

async function capabilityChanges(config: ServerConfig, workspaceId: string, target: TargetPlanRow): Promise<Extras> {
  if (config.selfHostBillingUnlimited === true) return NO_EXTRAS;
  const resolved = await getWorkspacePlanInfoDetailed(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  if (!resolved.ok) return NO_EXTRAS;
  const info = resolved.value;
  const sb = getServiceClient(config);
  const [modulesRead, channelsRead, installsRead, edition] = await Promise.all([
    sb.from('workspace_module_overrides').select('module_key, enabled, admin_notes').eq('workspace_id', workspaceId),
    sb.from('workspace_channel_overrides').select('channel_key, enabled, admin_notes').eq('workspace_id', workspaceId),
    sb.from('workspace_plugin_installations').select('plugin_id, status').eq('workspace_id', workspaceId).neq('status', 'uninstalled'),
    getPlatformEditionOrNull(config),
  ]);
  const overrides = (read: { data: unknown; error: { message?: string } | null }, table: string): FlagOverrideRow[] => {
    if (read.error && !isRelationMissing(read.error, table)) throw new Error(read.error.message || `${table} read failed`);
    return read.error ? [] : ((read.data ?? []) as FlagOverrideRow[]);
  };
  const moduleOverrides = overrides(modulesRead, 'workspace_module_overrides');
  const channelOverrides = overrides(channelsRead, 'workspace_channel_overrides');
  const current = resolveEffectiveEntitlements(info, moduleOverrides, channelOverrides);
  const next = resolveEffectiveEntitlements(
    {
      entitlements: (target.entitlements ?? {}) as Record<string, boolean>,
      planLimits: (target.limits ?? {}) as Record<string, number>,
      limitOverrides: info.limitOverrides,
    },
    moduleOverrides,
    channelOverrides,
  );
  const inUse = { module: new Set<string>(), channel: new Set<string>() };
  for (const row of (installsRead.error ? [] : installsRead.data ?? []) as Array<{ plugin_id: string }>) {
    const keys = pluginKeys(String(row.plugin_id));
    if (keys.module) inUse.module.add(keys.module);
    if (keys.channel) inUse.channel.add(keys.channel);
  }
  const lost = (now: Record<string, { value: boolean }>, after: Record<string, { value: boolean }>, used: Set<string>) =>
    Object.keys(now)
      .filter((key) => now[key]?.value === true && after[key]?.value !== true && getCapability(key)?.deprecated !== true)
      .map((key) => ({ key, in_use: used.has(key) }));
  const channels_lost = lost(current.channels, next.channels, inUse.channel)
    .filter((c) => isChannelAllowedInEdition(c.key, edition ?? 'iran'));
  return {
    modules_lost: lost(current.modules, next.modules, inUse.module),
    channels_lost,
    channels_stop_messages: channels_lost.length > 0,
    ai_credits: {
      current: current.limits.ai_credits_per_month?.value ?? null,
      target: next.limits.ai_credits_per_month?.value ?? null,
    },
  };
}

/** True when the report lists anything that would be locked, stopped or blocked. */
export function reportHasLocks(report: Omit<LockReport, 'has_locks'>): boolean {
  return report.kb_article.locked > 0
    || report.contact.locked > 0
    || report.member.locked > 0
    || report.conversation.locked > 0
    || report.conversation_quota.full
    || report.storage.uploads_blocked
    || report.modules_lost.length > 0
    || report.channels_lost.length > 0;
}

/**
 * A downgrade must be acknowledged when its report lists anything — but only
 * while the kill switch is on: with locks off nothing more is locked than
 * today, and the change goes through exactly as before.
 */
export function reportNeedsAcknowledgement(report: LockReport | null | undefined): boolean {
  return Boolean(report && report.locks_enabled && report.has_locks);
}

/**
 * The report for moving `workspaceId` to `planId` (the plan in force when
 * null: what is locked now). Throws when the SQL part cannot be read; the
 * modules and channels part degrades to "nothing" (S4).
 */
export async function buildLockReport(config: ServerConfig, workspaceId: string, planId: string | null = null): Promise<LockReport> {
  const target = planId ?? (await readEffectivePlanId(config, workspaceId));
  if (!target) throw new Error('billing_lock_report: no plan');
  const sb = getServiceClient(config);
  const [{ data, error }, planRead] = await Promise.all([
    sb.rpc('billing_lock_report', { p_workspace_id: workspaceId, p_plan_id: target }),
    sb.from('billing_plans').select('id, entitlements, limits').eq('id', target).maybeSingle(),
  ]);
  if (error) throw new Error(`billing_lock_report: ${error.message || 'failed'}`);
  const base = parseSqlLockReport(data, target);
  let extras = NO_EXTRAS;
  try {
    if (planRead.error) throw new Error(planRead.error.message || 'plan read failed');
    if (planRead.data) extras = await capabilityChanges(config, workspaceId, planRead.data as TargetPlanRow);
  } catch (e) {
    console.warn('[billing-locks] report: modules and channels unreadable:', e instanceof Error ? e.message : e);
  }
  const report = { ...base, ...extras };
  return { ...report, has_locks: reportHasLocks(report) };
}

/** The report as a workspace member who may not manage it sees it: no names or e-mails of other members. */
export function reportForViewer(report: LockReport, canManage: boolean): LockReport {
  if (canManage) return report;
  return { ...report, member: { ...report.member, items: [] } };
}
