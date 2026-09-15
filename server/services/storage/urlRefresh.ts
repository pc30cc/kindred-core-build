/**
 * REBUILDING STORED PUBLIC URLs FROM THEIR STORAGE KEYS
 *
 * A storage key (`workspace/<id>/attachments/2026/a.jpg`) is the same on
 * every provider — it is what the platform writes, everywhere. A public URL
 * is not: it names one provider's hostname. So any row that keeps only a URL
 * is pinned to whichever provider was primary when it was written, and a
 * promotion leaves it pointing at the old one forever.
 *
 * Most of the platform already avoids that by storing the key and resolving
 * the URL when it reads (conversation and email attachments, recordings,
 * privacy exports). A handful of columns additionally cache the URL because
 * many read paths render them directly — profiles, contacts, branding, the
 * call-center avatar, the AI agent logo.
 *
 * This module treats that cache as exactly that: derived data with a
 * rebuild. The key column is the source of truth; every URL here can be
 * recomputed for the CURRENT provider. It runs in bounded batches so a table
 * with a lot of rows never ties up one request, and it never invents a key —
 * a row with no key is left exactly as it is, because an external avatar
 * that never lived in our storage must not be rewritten to point at it.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  getFileUrlWithConfig, resolveStorageConfig, resolveGlobalStorageConfig,
  type StorageConfig,
} from './index.js';

/** One cached-URL column and the key it is derived from. */
interface UrlCacheSource {
  /** Stable name in the report. */
  name: string;
  table: string;
  /** Primary key column, used for the update. */
  idColumn: string;
  urlColumn: string;
  /** Column holding the canonical key, or null when it lives inside `metadata`. */
  keyColumn: string | null;
  /** Key path inside the row's `metadata` jsonb, for sources that keep it there. */
  metadataKey?: string;
  /**
   * Which provider resolves this row: a workspace's own attachment provider,
   * or the platform-wide one for user-owned objects.
   */
  owner: 'workspace' | 'global';
  /** Workspace column, for workspace-owned sources. */
  workspaceColumn?: string;
}

const SOURCES: UrlCacheSource[] = [
  {
    name: 'contact_avatar', table: 'contacts', idColumn: 'id',
    urlColumn: 'avatar_url', keyColumn: 'avatar_storage_key',
    owner: 'workspace', workspaceColumn: 'workspace_id',
  },
  {
    name: 'workspace_branding', table: 'workspace_branding', idColumn: 'workspace_id',
    urlColumn: 'logo_url', keyColumn: 'logo_storage_key',
    owner: 'workspace', workspaceColumn: 'workspace_id',
  },
  {
    name: 'call_center_avatar', table: 'call_center_settings', idColumn: 'workspace_id',
    urlColumn: 'avatar_url', keyColumn: 'avatar_storage_path',
    owner: 'workspace', workspaceColumn: 'workspace_id',
  },
  {
    name: 'ai_agent_logo', table: 'ai_agent_settings', idColumn: 'workspace_id',
    urlColumn: 'agent_logo_url', keyColumn: null, metadataKey: 'ai_avatar_storage_key',
    owner: 'workspace', workspaceColumn: 'workspace_id',
  },
  {
    // User-owned: resolved through the platform-wide provider, the same one
    // uploadForOwner uses for a `user` owner.
    name: 'account_avatar', table: 'profiles', idColumn: 'id',
    urlColumn: 'avatar_url', keyColumn: 'avatar_storage_key',
    owner: 'global',
  },
];

export interface UrlRefreshSourceReport {
  name: string;
  /** Rows inspected in this run. */
  scanned: number;
  /** Rows whose cached URL was stale and has been rewritten. */
  updated: number;
  /** Rows already correct for the current provider. */
  unchanged: number;
  /** Rows with no key — nothing to derive from, deliberately untouched. */
  skippedNoKey: number;
  failed: number;
  errors: string[];
  /** True when this run reached the end of the table. */
  complete: boolean;
}

export interface UrlRefreshReport {
  sources: UrlRefreshSourceReport[];
  totalUpdated: number;
  /** False when at least one source still has rows to walk — run it again. */
  complete: boolean;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

type Row = Record<string, unknown>;

function keyOf(source: UrlCacheSource, row: Row): string | null {
  if (source.keyColumn) {
    const value = row[source.keyColumn];
    return typeof value === 'string' && value ? value : null;
  }
  const meta = row.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const value = (meta as Row)[source.metadataKey ?? ''];
  return typeof value === 'string' && value ? value : null;
}

/**
 * Rebuild the cached public URLs from their keys, for the provider that is
 * live right now.
 *
 * `limit` bounds the rows read PER SOURCE, so one call is predictable
 * regardless of how many sources there are. Re-running is safe and cheap:
 * a row already holding the right URL is counted and left alone.
 */
export async function refreshStoredFileUrls(
  serverConfig: ServerConfig,
  opts: { limit?: number } = {},
): Promise<UrlRefreshReport> {
  const sb = getServiceClient(serverConfig);
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // One provider resolution per workspace, not per row.
  const workspaceConfigs = new Map<string, StorageConfig | null>();
  let globalConfig: StorageConfig | null | undefined;

  const sources: UrlRefreshSourceReport[] = [];

  for (const source of SOURCES) {
    const report: UrlRefreshSourceReport = {
      name: source.name, scanned: 0, updated: 0, unchanged: 0,
      skippedNoKey: 0, failed: 0, errors: [], complete: true,
    };

    const columns = [
      source.idColumn,
      source.urlColumn,
      source.keyColumn ?? 'metadata',
      ...(source.workspaceColumn && source.workspaceColumn !== source.idColumn ? [source.workspaceColumn] : []),
    ];

    const { data, error } = await sb
      .from(source.table)
      .select([...new Set(columns)].join(', '))
      .order(source.idColumn, { ascending: true })
      .limit(limit);

    if (error) {
      report.failed++;
      report.errors.push(`listing ${source.table}: ${error.message}`);
      report.complete = false;
      sources.push(report);
      continue;
    }

    const rows = (data ?? []) as unknown as Row[];
    report.scanned = rows.length;
    // A full page may mean there is more; the caller runs it again.
    report.complete = rows.length < limit;

    for (const row of rows) {
      const key = keyOf(source, row);
      if (!key) {
        report.skippedNoKey++;
        continue;
      }

      let config: StorageConfig | null = null;
      if (source.owner === 'workspace') {
        const workspaceId = String(row[source.workspaceColumn ?? 'workspace_id'] ?? '');
        if (!workspaceId) {
          report.skippedNoKey++;
          continue;
        }
        if (!workspaceConfigs.has(workspaceId)) {
          workspaceConfigs.set(workspaceId, await resolveStorageConfig(serverConfig, workspaceId).catch(() => null));
        }
        config = workspaceConfigs.get(workspaceId) ?? null;
      } else {
        if (globalConfig === undefined) {
          globalConfig = await resolveGlobalStorageConfig(serverConfig).catch(() => null);
        }
        config = globalConfig;
      }

      if (!config) {
        report.failed++;
        if (report.errors.length < 10) report.errors.push(`${source.table}: no storage provider resolved`);
        continue;
      }

      const fresh = getFileUrlWithConfig(config, key);
      if (!fresh) {
        report.failed++;
        if (report.errors.length < 10) report.errors.push(`${source.table}: could not build a URL for ${key}`);
        continue;
      }
      if (fresh === row[source.urlColumn]) {
        report.unchanged++;
        continue;
      }

      const { error: updateError } = await sb
        .from(source.table)
        .update({ [source.urlColumn]: fresh })
        .eq(source.idColumn, row[source.idColumn]);

      if (updateError) {
        report.failed++;
        if (report.errors.length < 10) report.errors.push(`${source.table}: ${updateError.message}`);
      } else {
        report.updated++;
      }
    }

    sources.push(report);
  }

  return {
    sources,
    totalUpdated: sources.reduce((n, s) => n + s.updated, 0),
    complete: sources.every((s) => s.complete),
  };
}

/** Exposed for tests and for the admin screen's explanatory copy. */
export function storedUrlSourceNames(): string[] {
  return SOURCES.map((s) => s.name);
}
