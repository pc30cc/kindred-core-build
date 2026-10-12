/**
 * billing_v2_archive in Super Admin → Database's exports.
 *
 * Migration 268 moved billing v2's records (invoices, payments, wallets,
 * periods, coupons…) out of `public` into the schema billing_v2_archive. The
 * JSON backup, the SQL dump and the one-click migration read `public` through
 * admin_list_export_tables, so without this they would leave those records
 * out without a word. admin_export_archive_tables (268) lists the archive's
 * tables with their columns, and admin_export_table reads one as
 * 'billing_v2_archive.<table>'.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const ARCHIVE_SCHEMA = 'billing_v2_archive';

export interface ArchiveColumn {
  name: string;
  type: string;
  generated: boolean;
}

/** 'billing_v2_archive.<table>': the name admin_export_table takes, and the backup's key. */
export function archiveKey(table: string): string {
  return `${ARCHIVE_SCHEMA}.${table}`;
}

/**
 * The archive's tables and their columns, by table name. Empty while 268 is
 * not applied (the function does not exist yet, and billing v2's tables are
 * still in public, where the exports already read them). Any other failure
 * throws: an export must never quietly lack the archive.
 */
export async function fetchArchiveTables(
  sb: SupabaseClient,
  actorId: string,
): Promise<Record<string, ArchiveColumn[]>> {
  const { data, error } = await sb.rpc('admin_export_archive_tables', { _actor_user_id: actorId });
  if (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code === 'PGRST202' || code === '42883') return {};
    throw new Error(`billing_v2_archive table list failed: ${error.message}`);
  }
  const tables = (data as Record<string, ArchiveColumn[]> | null) ?? {};
  return Object.fromEntries(Object.keys(tables).sort().map((t) => [t, tables[t]]));
}

/**
 * Every table the JSON backup carries: public's (by name, as before) and then
 * the archive's (as 'billing_v2_archive.<table>'). A restore of such a backup
 * reloads public only; the archive's rows are there to be read or put back by
 * a person.
 */
export async function listBackupTables(sb: SupabaseClient, actorId: string): Promise<string[]> {
  const { data, error } = await sb.rpc('admin_list_export_tables', {
    _actor_user_id: actorId,
    _scope: 'all',
  });
  if (error) throw new Error(error.message);
  const publicTables = ((data as unknown as (string | { admin_list_export_tables: string })[]) ?? []).map((t) =>
    typeof t === 'string' ? t : t.admin_list_export_tables,
  );
  const archive = Object.keys(await fetchArchiveTables(sb, actorId)).map(archiveKey);
  return [...publicTables, ...archive];
}
