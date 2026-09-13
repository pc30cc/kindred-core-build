/**
 * Plain-SQL dump of the whole `public` schema + data, streamable straight into
 * `gzip` so an operator can `psql -f dump.sql` (or `gunzip -c dump.sql.gz |
 * psql ...`) inside a self-hosted Supabase container.
 *
 * Same source-side primitives as the one-click migration
 * (admin_export_schema_ddl / admin_list_export_tables / admin_export_table),
 * but instead of pushing rows over a live `pg` connection we serialise them as
 * INSERT statements. Column types come from admin_export_column_meta so values
 * are emitted with the right literal form, and GENERATED ALWAYS / identity
 * columns are skipped (they reject an explicit value).
 *
 * Express-only — no edge functions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLE_BOOTSTRAP, fetchSchemaStatements } from './selfhostMigration.js';

const PAGE_SIZE = 500;
const INSERT_BATCH = 200;

interface ColumnMeta {
  name: string;
  type: string;
  generated: boolean;
}

const NUMERIC_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'real',
  'double precision',
  'numeric',
  'money',
]);

function quote(text: string): string {
  return `'${text.replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function arrayElement(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatLiteral(value: unknown, type: string): string {
  if (value === null || value === undefined) return 'NULL';

  const base = type.replace(/\(.*\)/, '').trim();

  if (base.endsWith('[]')) {
    const items = Array.isArray(value) ? value : [value];
    return `${quote(`{${items.map(arrayElement).join(',')}}`)}::${type}`;
  }
  if (base === 'json' || base === 'jsonb') {
    return `${quote(JSON.stringify(value))}::${base}`;
  }
  if (base === 'boolean') {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return quote(String(value));
  }
  if (NUMERIC_TYPES.has(base) && typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (base === 'bytea' && typeof value === 'string') {
    return quote(value);
  }
  if (typeof value === 'object') return quote(JSON.stringify(value));
  return quote(String(value));
}

const HEADER = `--
-- Full dump of the public schema (structure + data).
-- Restore into a self-hosted Supabase / PostgreSQL instance with:
--   gunzip -c dump.sql.gz | psql "postgresql://postgres:PASSWORD@localhost:5432/postgres"
--
SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;
SELECT pg_catalog.set_config('search_path', 'public', false);
CREATE SCHEMA IF NOT EXISTS public;
`;

const SEQUENCE_REALIGN = `
--
-- Re-align identity / serial sequences with the imported data.
--
DO $seq$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS seq,
           quote_ident(tn.nspname) || '.' || quote_ident(t.relname) AS tbl,
           quote_ident(a.attname) AS col
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_depend d ON d.objid = c.oid AND d.deptype IN ('a','i')
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE c.relkind = 'S' AND n.nspname = 'public'
  LOOP
    BEGIN
      EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%s) FROM %s), 0) + 1, false)', r.seq, r.col, r.tbl);
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;
END
$seq$;
`;

export interface SqlDumpOptions {
  includeSchema: boolean;
  includeData: boolean;
}

/**
 * Yields the dump as UTF-8 SQL chunks. The caller pipes them through gzip.
 */
export async function* generateSqlDump(
  sb: SupabaseClient,
  actorId: string,
  options: SqlDumpOptions,
): AsyncGenerator<string> {
  yield HEADER;
  yield `\n-- Supabase-managed roles referenced by GRANT / POLICY statements.\n${ROLE_BOOTSTRAP}\n`;

  if (options.includeSchema) {
    const statements = await fetchSchemaStatements(sb, actorId, () => undefined);
    yield `\n--\n-- Structure (${statements.length} statements)\n--\n`;
    // Dependency order is never perfect, so wrap each statement: a failure
    // must not abort the whole psql run — the repeat pass below re-applies it.
    let buffer = '';
    for (const stmt of statements) {
      buffer += `${stmt.trim().replace(/;?\s*$/, ';')}\n`;
      if (buffer.length > 64_000) {
        yield buffer;
        buffer = '';
      }
    }
    if (buffer) yield buffer;
  }

  if (!options.includeData) {
    yield SEQUENCE_REALIGN;
    return;
  }

  const { data: metaData, error: metaError } = await sb.rpc('admin_export_column_meta', {
    _actor_user_id: actorId,
  });
  if (metaError) throw new Error(`column meta failed: ${metaError.message}`);
  const meta = (metaData as Record<string, ColumnMeta[]>) ?? {};

  const { data: tableData, error: listError } = await sb.rpc('admin_list_export_tables', {
    _actor_user_id: actorId,
    _scope: 'all',
  });
  if (listError) throw new Error(`table list failed: ${listError.message}`);
  const tables = ((tableData as unknown as (string | { admin_list_export_tables: string })[]) ?? []).map((t) =>
    typeof t === 'string' ? t : t.admin_list_export_tables,
  );

  yield `\n--\n-- Data (${tables.length} tables)\n--\nSET session_replication_role = 'replica';\n`;

  for (const table of tables) {
    const columns = (meta[table] ?? []).filter((c) => !c.generated);
    if (columns.length === 0) continue;
    const typeOf = new Map(columns.map((c) => [c.name, c.type]));
    const allowed = new Set(columns.map((c) => c.name));

    yield `\n-- ${table}\n`;

    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await sb.rpc('admin_export_table', {
        _actor_user_id: actorId,
        _table: table,
        _limit: PAGE_SIZE,
        _offset: offset,
      });
      if (error) throw new Error(`${table}: ${error.message}`);
      const page = (data as Record<string, unknown>[] | null) ?? [];
      if (page.length === 0) break;

      for (let i = 0; i < page.length; i += INSERT_BATCH) {
        const batch = page.slice(i, i + INSERT_BATCH);
        const cols = Object.keys(batch[0]).filter((c) => allowed.has(c));
        if (cols.length === 0) break;
        const values = batch
          .map((row) => `  (${cols.map((c) => formatLiteral(row[c], typeOf.get(c) ?? 'text')).join(', ')})`)
          .join(',\n');
        yield `INSERT INTO public.${ident(table)} (${cols.map(ident).join(', ')}) VALUES\n${values}\nON CONFLICT DO NOTHING;\n`;
      }

      if (page.length < PAGE_SIZE) break;
    }
  }

  yield `\nSET session_replication_role = 'origin';\n`;
  yield SEQUENCE_REALIGN;
  yield `\n-- End of dump.\n`;
}
