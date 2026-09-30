/**
 * Platform support — the singleton switch Super Admin sets.
 *
 * `platform_support_settings` (migration 242): whether operators may reach
 * the platform's team at all, which workspace answers them, whether a ticket
 * may be filed while nobody there is available, and who else is mailed when
 * one is. Read on every support request, so kept for a short while in memory
 * and dropped the moment Super Admin saves.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface PlatformSupportSettings {
  enabled: boolean;
  /** The workspace whose inbox receives support; null until one is chosen. */
  workspaceId: string | null;
  ticketsEnabled: boolean;
  /** Mailed about every new ticket, besides the workspace's owners and admins. */
  notifyEmails: string[];
  updatedAt: string | null;
}

export const PLATFORM_SUPPORT_DEFAULTS: PlatformSupportSettings = {
  enabled: false,
  workspaceId: null,
  ticketsEnabled: true,
  notifyEmails: [],
  updatedAt: null,
};

const CACHE_MS = 30_000;
let cache: { at: number; value: PlatformSupportSettings } | null = null;

interface SettingsRow {
  enabled: boolean | null;
  workspace_id: string | null;
  tickets_enabled: boolean | null;
  notify_emails: string[] | null;
  updated_at: string | null;
}

export function normalizeSettings(row: Partial<SettingsRow> | null | undefined): PlatformSupportSettings {
  if (!row) return { ...PLATFORM_SUPPORT_DEFAULTS };
  return {
    enabled: row.enabled === true,
    workspaceId: typeof row.workspace_id === 'string' && row.workspace_id ? row.workspace_id : null,
    ticketsEnabled: row.tickets_enabled !== false,
    notifyEmails: normalizeEmails(row.notify_emails ?? []),
    updatedAt: row.updated_at ?? null,
  };
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Lower-cased, trimmed, valid and unique; at most 20. */
export function normalizeEmails(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !EMAIL.test(email) || out.includes(email)) continue;
    out.push(email);
    if (out.length === 20) break;
  }
  return out;
}

export function invalidatePlatformSupportSettings(): void {
  cache = null;
}

export async function loadPlatformSupportSettings(config: ServerConfig): Promise<PlatformSupportSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const { data, error } = await getServiceClient(config)
    .from('platform_support_settings')
    .select('enabled, workspace_id, tickets_enabled, notify_emails, updated_at')
    .eq('id', true)
    .maybeSingle();
  // A failed read is "off", never a cached "off": the next request asks again.
  if (error) {
    console.warn('[platform-support] settings read failed:', error.message);
    return { ...PLATFORM_SUPPORT_DEFAULTS };
  }
  const value = normalizeSettings(data as SettingsRow | null);
  cache = { at: Date.now(), value };
  return value;
}

export interface PlatformSupportSettingsPatch {
  enabled?: boolean;
  workspaceId?: string | null;
  ticketsEnabled?: boolean;
  notifyEmails?: string[];
}

export async function savePlatformSupportSettings(
  config: ServerConfig,
  patch: PlatformSupportSettingsPatch,
  actorId: string,
): Promise<PlatformSupportSettings> {
  const row: Record<string, unknown> = { id: true, updated_at: new Date().toISOString(), updated_by: actorId };
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.workspaceId !== undefined) row.workspace_id = patch.workspaceId;
  if (patch.ticketsEnabled !== undefined) row.tickets_enabled = patch.ticketsEnabled;
  if (patch.notifyEmails !== undefined) row.notify_emails = normalizeEmails(patch.notifyEmails);
  const { data, error } = await getServiceClient(config)
    .from('platform_support_settings')
    .upsert(row, { onConflict: 'id' })
    .select('enabled, workspace_id, tickets_enabled, notify_emails, updated_at')
    .single();
  invalidatePlatformSupportSettings();
  if (error) throw new Error(`platform support settings save failed: ${error.message}`);
  return normalizeSettings(data as SettingsRow);
}
