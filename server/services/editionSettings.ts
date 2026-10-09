/**
 * THE NATIVE APPS' SETTINGS, ONE ROW PER EDITION (migration 257).
 *
 * Super Admin → Windows app, macOS app, Mobile app and Notifications each keep
 * one row per edition (shared/edition.ts): the Iranian edition's (WebYar) and
 * the International edition's (RESPOK). The platform can switch edition
 * (platform_settings.region_mode), and after a switch Super Admin and the
 * apps see that edition's own row, never the other's. An edition with no row
 * yet is served its own brand's defaults, and the first save of its page
 * creates its row.
 *
 * Readers that must never fail (the apps' public config, push dispatch) take
 * the edition from getPlatformEditionOrNull and serve the defaults without a
 * read while it is unknown. Super Admin's reads and writes take it from
 * getPlatformEdition, which refuses (EditionUnavailableError, HTTP 503)
 * rather than show or write a guessed edition's row.
 */
import type { Response } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import type { Edition } from '../../shared/edition.js';
import { EditionUnavailableError } from './platformRegion.js';

/** The per-edition settings tables: one row per edition (unique index on `edition`). */
export const EDITION_SETTINGS_TABLES = [
  'desktop_app_settings',
  'macos_app_settings',
  'mobile_app_settings',
  'push_platform_settings',
] as const;
export type EditionSettingsTable = (typeof EDITION_SETTINGS_TABLES)[number];

/**
 * The edition's row: `{ data, error }`, `data` null while the edition has
 * none. Oldest first, as the singleton was read, should two ever exist.
 */
export function editionSettingsRow(config: ServerConfig, table: EditionSettingsTable, edition: Edition) {
  return getServiceClient(config)
    .from(table)
    .select('*')
    .eq('edition', edition)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
}

/** The edition's row for Super Admin; a failed read throws. */
export async function readEditionSettingsRow(
  config: ServerConfig,
  table: EditionSettingsTable,
  edition: Edition,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await editionSettingsRow(config, table, edition);
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * Saves a patch into the edition's row: updates `existing` (that edition's
 * row, never another's), or creates the edition's row from `insertDefaults`
 * (where its brand's defaults differ from the columns' own) under the patch.
 * Resolves to `{ data, error }` with the saved row.
 */
export function saveEditionSettingsRow(
  config: ServerConfig,
  table: EditionSettingsTable,
  edition: Edition,
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown>,
  insertDefaults: Record<string, unknown> = {},
) {
  const sb = getServiceClient(config);
  return existing
    ? sb.from(table).update(patch).eq('id', existing.id as string).eq('edition', edition).select('*').single()
    : sb.from(table).insert({ ...insertDefaults, ...patch, edition }).select('*').single();
}

/** Answers 503 `EDITION_UNAVAILABLE` for an unknown edition; false for any other error. */
export function respondEditionUnavailable(res: Response, err: unknown): boolean {
  if (!(err instanceof EditionUnavailableError)) return false;
  res.status(err.status).json({ error: err.code });
  return true;
}
