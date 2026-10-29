// ============================================
// EMAIL SEND QUOTAS: how often a mail anyone can trigger may go out
// ============================================
//
// Some mail is sent because somebody asked for it: a stranger typing an
// address into the reset form, a member pressing a test button, an owner
// inviting people, a visitor leaving a message. Each of those used to be
// limited only per IP and minute, if at all, so one person (or a botnet)
// could make the platform mail one address again and again, or many
// addresses once each, from our own domains and our own relay. The limits
// below are counted per account, member or workspace instead, the same for
// every email provider.
//
// A quota is a fixed window per (scope, key): it starts at the first use and
// lasts `windowSeconds`; within it the first `max` uses fit. The count lives
// in public.email_send_quota (migration 289d), taken in one statement, so
// every backend process shares it and a restart does not reset it. Without
// that table (the migration not applied yet) or when the database cannot be
// read, the same windows are counted in this process's memory: the limits
// still hold, only less exactly.

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface EmailQuota {
  /** What is counted ("auth_reset_cooldown", "offline_notice_day", …): 1 to 64 characters. */
  scope: string;
  /** Whose: an account, member or workspace id (1 to 200 characters), never anything typed. */
  key: string;
  windowSeconds: number;
  max: number;
}

export interface EmailQuotaVerdict {
  /** Take: this use fits the window. Peek: one more use would. */
  allowed: boolean;
  /** Uses counted in the current window (this one included, for a take). */
  used: number;
  windowStartedAt: Date;
  windowEndsAt: Date;
  /** Whole seconds until the window ends (at least 1). */
  retryAfterSeconds: number;
}

interface QuotaRow {
  allowed: unknown;
  used: unknown;
  started_at: unknown;
  ends_at: unknown;
}

function verdictOf(allowed: boolean, used: number, startedAt: Date, endsAt: Date): EmailQuotaVerdict {
  return {
    allowed,
    used,
    windowStartedAt: startedAt,
    windowEndsAt: endsAt,
    retryAfterSeconds: Math.max(1, Math.ceil((endsAt.getTime() - Date.now()) / 1000)),
  };
}

function rowOf(data: unknown): QuotaRow | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? (row as QuotaRow) : null;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// ─── The process's own count, when the database's cannot be used ─────────

const memory = new Map<string, { startedAt: number; endsAt: number; used: number }>();
let warnedMemory = false;

function memoryVerdict(quota: EmailQuota, take: boolean): EmailQuotaVerdict {
  const now = Date.now();
  const id = `${quota.scope}\u0000${quota.key}`;
  let entry = memory.get(id);
  if (!entry || entry.endsAt <= now) {
    if (!take) return verdictOf(quota.max > 0, 0, new Date(now), new Date(now + quota.windowSeconds * 1000));
    entry = { startedAt: now, endsAt: now + quota.windowSeconds * 1000, used: 0 };
    memory.set(id, entry);
    if (memory.size > 10_000) {
      for (const [k, v] of memory) if (v.endsAt <= now) memory.delete(k);
    }
  }
  if (!take) return verdictOf(entry.used < quota.max, entry.used, new Date(entry.startedAt), new Date(entry.endsAt));
  entry.used += 1;
  return verdictOf(entry.used <= quota.max, entry.used, new Date(entry.startedAt), new Date(entry.endsAt));
}

/** For the tests: forget the in-memory windows. */
export function __resetEmailQuotaMemoryForTests(): void {
  memory.clear();
  warnedMemory = false;
}

async function run(config: ServerConfig, quota: EmailQuota, take: boolean): Promise<EmailQuotaVerdict> {
  const windowSeconds = Math.max(1, Math.floor(quota.windowSeconds));
  const max = Math.max(0, Math.floor(quota.max));
  const normalized = { ...quota, scope: quota.scope.slice(0, 64), key: quota.key.slice(0, 200), windowSeconds, max };
  try {
    const { data, error } = await getServiceClient(config).rpc('email_send_quota_take', {
      p_scope: normalized.scope,
      p_key: normalized.key,
      p_window_seconds: windowSeconds,
      p_max: max,
      p_take: take,
    });
    const row = error ? null : rowOf(data);
    const startedAt = dateOf(row?.started_at);
    const endsAt = dateOf(row?.ends_at);
    if (row && typeof row.allowed === 'boolean' && startedAt && endsAt) {
      return verdictOf(row.allowed, Number(row.used) || 0, startedAt, endsAt);
    }
    if (!warnedMemory) {
      warnedMemory = true;
      console.warn('[email-quota] the shared counters cannot be used (migration 289d?); counting in memory:', error?.message ?? 'no answer');
    }
  } catch (err) {
    if (!warnedMemory) {
      warnedMemory = true;
      console.warn('[email-quota] the shared counters cannot be used; counting in memory:', err instanceof Error ? err.message : String(err));
    }
  }
  return memoryVerdict(normalized, take);
}

/** Counts one use and says whether it fits its window. Never throws. */
export function takeEmailQuota(config: ServerConfig, quota: EmailQuota): Promise<EmailQuotaVerdict> {
  return run(config, quota, true);
}

/** Says whether one more use would fit, counting nothing. Never throws. */
export function peekEmailQuota(config: ServerConfig, quota: EmailQuota): Promise<EmailQuotaVerdict> {
  return run(config, quota, false);
}
