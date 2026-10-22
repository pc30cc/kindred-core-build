/**
 * The chat widget template catalog in the database (migration 275):
 * widget_edition_settings.chat_templates (one row per edition, the Super
 * Admin's catalog: shared/chatTemplateCatalog.ts) and the workspaces' choices
 * (widget_settings.widget_template_id / widget_template_options).
 *
 * Every read here tolerates a database from before 275 (RESPOK's backend may
 * start before its migrator runs; WebYar's database is migrated by hand): a
 * missing table or column reads as "no catalog", which is the widget exactly
 * as it was. The visitor path reads the catalog only through the platform
 * snapshot (configSnapshot.ts, 30 s, cleared by the `platform` scope).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient, type ServiceClient } from '../../supabase.js';
import type { Edition } from '../../../shared/edition.js';
import {
  canonicalChatTemplateId,
  enabledChatTemplateIds,
  type ChatTemplateCatalog,
  type StoredChatTemplates,
} from '../../../shared/chatTemplateCatalog.js';
import { isRelationMissing } from '../billing/entitlementParse.js';

type DbError = { code?: string; message?: string; details?: string } | null | undefined;

function isColumnMissing(error: DbError, column: RegExp): boolean {
  const code = String(error?.code || '');
  return (code === '42703' || code === 'PGRST204') && column.test(`${error?.message || ''} ${error?.details || ''}`);
}

/** widget_edition_settings (or its chat_templates column) does not exist yet: 275 is not applied. */
export function isCatalogTableMissing(error: DbError): boolean {
  return isRelationMissing(error, 'widget_edition_settings') || isColumnMissing(error, /chat_templates/);
}

/** widget_settings has no widget_template_id / widget_template_options column yet (before 275). */
export function isTemplateColumnMissing(error: DbError): boolean {
  return isColumnMissing(error, /widget_template_(id|options)/);
}

/** The answer a write gives while 275 is not applied. */
export const TEMPLATE_CATALOG_MIGRATION_REQUIRED = {
  error: 'Widget templates need database migration 275 (widget_edition_settings, widget_settings.widget_template_id).',
  code: 'migration_required',
} as const;

export interface ChatTemplateRows {
  /** The stored catalog per edition (raw jsonb; resolveChatTemplateCatalog reads it). */
  byEdition: Partial<Record<Edition, unknown>>;
  /** False while widget_edition_settings does not exist (before 275). */
  ready: boolean;
  /** The read failed for another reason: the snapshot is degraded (and keeps its previous catalog). */
  error: boolean;
}

/** Every edition's stored catalog (at most two rows), for the platform snapshot. Never throws. */
export async function readChatTemplateRows(sb: ServiceClient): Promise<ChatTemplateRows> {
  try {
    const { data, error } = await sb.from('widget_edition_settings').select('edition, chat_templates');
    if (error) {
      if (isCatalogTableMissing(error)) return { byEdition: {}, ready: false, error: false };
      console.warn('[widget] template catalog read failed:', error.message);
      return { byEdition: {}, ready: true, error: true };
    }
    const byEdition: Partial<Record<Edition, unknown>> = {};
    for (const row of (data || []) as Array<{ edition?: string | null; chat_templates?: unknown }>) {
      if (row.edition === 'iran' || row.edition === 'international') byEdition[row.edition] = row.chat_templates ?? null;
    }
    return { byEdition, ready: true, error: false };
  } catch (err) {
    console.warn('[widget] template catalog read failed:', err instanceof Error ? err.message : String(err));
    return { byEdition: {}, ready: true, error: true };
  }
}

export interface EditionChatTemplatesRow {
  /** False while widget_edition_settings does not exist (before 275). */
  ready: boolean;
  /** The stored catalog, or null when the edition has no row yet. */
  stored: StoredChatTemplates | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The edition's row, read fresh (Super Admin). A failed read other than "before 275" throws. */
export async function readEditionChatTemplates(config: ServerConfig, edition: Edition): Promise<EditionChatTemplatesRow> {
  const { data, error } = await getServiceClient(config)
    .from('widget_edition_settings')
    .select('chat_templates, updated_at, updated_by')
    .eq('edition', edition)
    .maybeSingle();
  if (error) {
    if (isCatalogTableMissing(error)) return { ready: false, stored: null, updatedAt: null, updatedBy: null };
    throw new Error(error.message);
  }
  const row = data as { chat_templates?: unknown; updated_at?: string | null; updated_by?: string | null } | null;
  return {
    ready: true,
    stored: (row?.chat_templates as StoredChatTemplates | undefined) ?? null,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/** Writes the edition's catalog (creates its row on the first save). Resolves to `{ data, error }`. */
export function saveEditionChatTemplates(
  config: ServerConfig,
  edition: Edition,
  value: StoredChatTemplates,
  actorId: string,
) {
  return getServiceClient(config)
    .from('widget_edition_settings')
    .upsert(
      { edition, chat_templates: value, updated_at: new Date().toISOString(), updated_by: actorId },
      { onConflict: 'edition' },
    )
    .select('chat_templates, updated_at, updated_by')
    .single();
}

export interface TemplateUsage {
  /** Workspaces that chose each template (whether or not it is enabled now). */
  chosenBy: Record<string, number>;
  /** Workspaces that never chose (they wear the catalog's default). */
  followingDefault: number;
}

/**
 * How many workspaces chose each template, and how many follow the default:
 * one count each (head requests, no rows read). Null when the column does not
 * exist yet (before 275) or a count fails: the page then shows no numbers.
 */
export async function countTemplateUsage(config: ServerConfig, ids: readonly string[]): Promise<TemplateUsage | null> {
  const sb = getServiceClient(config);
  const counts = await Promise.all([
    sb.from('widget_settings').select('workspace_id', { count: 'exact', head: true }).is('widget_template_id', null),
    ...ids.map((id) => sb.from('widget_settings').select('workspace_id', { count: 'exact', head: true }).eq('widget_template_id', id)),
  ]);
  if (counts.some((c) => c.error || typeof c.count !== 'number')) return null;
  const chosenBy: Record<string, number> = {};
  ids.forEach((id, i) => { chosenBy[id] = counts[i + 1].count as number; });
  return { chosenBy, followingDefault: counts[0].count as number };
}

/**
 * Whether a workspace's stored choice (widget_settings.widget_template_id) is
 * a template the edition's catalog does not offer enabled now, so its
 * visitors wear the default: the Widget page's warning and the owner's alert
 * (routes/workspaceAlerts.ts). No choice is never unavailable.
 */
export function isChosenTemplateUnavailable(catalog: ChatTemplateCatalog, selectedId: string | null | undefined): boolean {
  if (typeof selectedId !== 'string' || !selectedId) return false;
  const id = canonicalChatTemplateId(catalog.edition, selectedId);
  return !(id && enabledChatTemplateIds(catalog).includes(id));
}
