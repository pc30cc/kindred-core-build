/**
 * One-click migration of the whole public schema + data to a self-hosted
 * Supabase / PostgreSQL target.
 *
 * Express-only (no edge functions). The source side reuses the SECURITY
 * DEFINER helpers already used by the admin backup path
 * (admin_export_schema_ddl / admin_list_export_tables / admin_export_table);
 * the target side is a plain `pg` connection driven by the platform admin.
 */
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

export const PAGE_SIZE = 500;
const INSERT_BATCH = 200;

// Supabase-managed roles do not exist on a bare PostgreSQL cluster; the dumped
// GRANT/POLICY statements reference them, so create them first (idempotent).
const ROLE_BOOTSTRAP = `
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END
$bootstrap$;`;

export function isLikelyPostgresUrl(value: string): boolean {
  return /^postgres(ql)?:\/\/[^\s]+$/i.test(value.trim());
}

/**
 * Turns a raw driver/network failure into a stable code the dashboard can
 * translate, plus the original text for the log. Without this the operator
 * just sees things like "getaddrinfo ENOTFOUND" or "timeout expired", which
 * read as a generic "not found" and hide the real cause (most often: the
 * hostname is behind an HTTP proxy/CDN, so port 5432 never answers).
 */
export function describeTargetError(err: unknown): { code: string; detail: string } {
  const e = err as { code?: string; message?: string };
  const detail = e?.message ?? String(err);
  const pgCode = e?.code ?? '';
  if (pgCode === 'ENOTFOUND' || pgCode === 'EAI_AGAIN') return { code: 'target_host_not_found', detail };
  if (pgCode === 'ECONNREFUSED') return { code: 'target_connection_refused', detail };
  if (pgCode === 'ETIMEDOUT' || /timeout expired|timed? ?out/i.test(detail)) {
    return { code: 'target_unreachable', detail };
  }
  if (pgCode === '28P01' || pgCode === '28000') return { code: 'target_auth_failed', detail };
  if (pgCode === '3D000') return { code: 'target_database_missing', detail };
  if (/self[- ]signed|certificate|SSL|TLS/i.test(detail)) return { code: 'target_tls_error', detail };
  return { code: 'target_connect_failed', detail };
}

export async function connectTarget(connectionString: string): Promise<Client> {
  const trimmed = connectionString.trim();
  const disableSsl = /sslmode=disable/i.test(trimmed);
  const client = new Client({
    connectionString: trimmed,
    // Self-hosted instances usually terminate TLS with a self-signed cert.
    ssl: disableSsl ? undefined : { rejectUnauthorized: false },
    statement_timeout: 300_000,
    connectionTimeoutMillis: 15_000,
  });
  try {
    await client.connect();
  } catch (err) {
    const { code } = describeTargetError(err);
    // Only a TLS negotiation problem is worth a second, plaintext attempt —
    // retrying an unreachable host just doubles the wait before the error.
    if (disableSsl || code !== 'target_tls_error') throw err;
    const plain = new Client({
      connectionString: trimmed,
      statement_timeout: 300_000,
      connectionTimeoutMillis: 15_000,
    });
    await plain.connect();
    return plain;
  }
  return client;
}

export async function inspectTarget(connectionString: string) {
  const client = await connectTarget(connectionString);
  try {
    const version = await client.query<{ version: string }>('select version()');
    const tables = await client.query<{ count: string }>(
      `select count(*)::text as count from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    const db = await client.query<{ db: string; usr: string }>(
      'select current_database() as db, current_user as usr',
    );
    return {
      version: version.rows[0]?.version ?? '',
      tableCount: Number(tables.rows[0]?.count ?? 0),
      database: db.rows[0]?.db ?? '',
      user: db.rows[0]?.usr ?? '',
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

type Emit = (event: Record<string, unknown>) => void;

export interface MigrationOptions {
  connectionString: string;
  includeSchema: boolean;
  truncateTarget: boolean;
}

/**
 * Only columns that can actually be written. Generated (STORED) columns and
 * `GENERATED ALWAYS AS IDENTITY` columns reject an explicit value, and because
 * the whole multi-row INSERT is one statement a single such column silently
 * zeroed out entire tables (conversations, workspace_domains, ...).
 */
async function targetColumnTypes(client: Client, table: string) {
  const { rows } = await client.query<{
    column_name: string;
    data_type: string;
    is_generated: string;
    identity_generation: string | null;
  }>(
    `select column_name, data_type, is_generated, identity_generation
       from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.is_generated === 'ALWAYS') continue;
    if (r.identity_generation === 'ALWAYS') continue;
    map.set(r.column_name, r.data_type);
  }
  return map;
}

function encodeValue(value: unknown, dataType: string | undefined): unknown {
  if (value === null || value === undefined) return null;
  const isJson = dataType === 'json' || dataType === 'jsonb';
  if (isJson) return JSON.stringify(value);
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

const SCHEMA_PAGE = 1000;

/**
 * PostgREST caps a response at `db-max-rows` (1000 by default), so a single
 * rpc() call silently returns only the FIRST 1000 DDL statements — which cut
 * the export off before the trigger / RLS / policy / grant sections at the end
 * of admin_export_schema_ddl. Page explicitly until a short page arrives.
 */
async function fetchSchemaStatements(sb: SupabaseClient, actorId: string, emit: Emit): Promise<string[]> {
  const all: string[] = [];
  for (let offset = 0; ; offset += SCHEMA_PAGE) {
    const { data, error } = await sb
      .rpc('admin_export_schema_ddl', { _actor_user_id: actorId })
      .range(offset, offset + SCHEMA_PAGE - 1);
    if (error) throw new Error(`schema export failed: ${error.message}`);
    const page = ((data as unknown as (string | { admin_export_schema_ddl: string })[]) ?? []).map((s) =>
      typeof s === 'string' ? s : s.admin_export_schema_ddl,
    );
    all.push(...page);
    emit({ type: 'schemaFetch', statements: all.length });
    if (page.length < SCHEMA_PAGE) break;
    if (offset > 100_000) break;
  }
  return all;
}

export async function runSelfhostMigration(
  sb: SupabaseClient,
  actorId: string,
  options: MigrationOptions,
  emit: Emit,
): Promise<void> {
  const target = await connectTarget(options.connectionString);
  try {
    emit({ type: 'stage', stage: 'connected' });

    await target.query(ROLE_BOOTSTRAP).catch((e) => emit({ type: 'warn', message: `roles: ${e.message}` }));

    if (options.includeSchema) {
      emit({ type: 'stage', stage: 'schema' });
      const statements = await fetchSchemaStatements(sb, actorId, emit);
      // Dependency order can never be perfect (functions calling views, views
      // calling functions, FKs across tables). Replay whatever failed until a
      // pass stops making progress, then report the statements still failing.
      let applied = 0;
      let pending = statements;
      const errors = new Map<string, string>();

      for (let pass = 1; pass <= 4 && pending.length > 0; pass += 1) {
        const stillFailing: string[] = [];
        let done = 0;
        for (const stmt of pending) {
          try {
            await target.query(stmt);
            applied += 1;
            errors.delete(stmt);
          } catch (e) {
            stillFailing.push(stmt);
            errors.set(stmt, (e as Error).message);
          }
          done += 1;
          if (done % 100 === 0) {
            emit({ type: 'schemaProgress', applied, failed: stillFailing.length, total: statements.length, pass });
          }
        }
        if (stillFailing.length === pending.length) {
          pending = stillFailing;
          break;
        }
        pending = stillFailing;
      }

      let reported = 0;
      for (const stmt of pending) {
        if (reported >= 25) break;
        reported += 1;
        emit({
          type: 'warn',
          message: `schema: ${errors.get(stmt) ?? 'failed'} — ${stmt.slice(0, 160).replace(/\s+/g, ' ')}`,
        });
      }
      emit({ type: 'schemaDone', applied, failed: pending.length, total: statements.length });
    }

    const { data: tableData, error: listError } = await sb.rpc('admin_list_export_tables', {
      _actor_user_id: actorId,
      _scope: 'all',
    });
    if (listError) throw new Error(`table list failed: ${listError.message}`);
    const tables = ((tableData as unknown as (string | { admin_list_export_tables: string })[]) ?? []).map((t) =>
      typeof t === 'string' ? t : t.admin_list_export_tables,
    );
    emit({ type: 'tables', total: tables.length });

    // Skip FK ordering / trigger side effects while loading rows.
    let replicaMode = true;
    await target.query("set session_replication_role = 'replica'").catch(() => {
      replicaMode = false;
      emit({ type: 'warn', message: 'session_replication_role unavailable — relying on ON CONFLICT ordering' });
    });

    let index = 0;
    let totalRows = 0;
    for (const table of tables) {
      index += 1;
      emit({ type: 'table', table, index, total: tables.length });

      const exists = await target.query(
        `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and c.relname = $1`,
        [table],
      );
      if (exists.rowCount === 0) {
        emit({ type: 'tableDone', table, rows: 0, skipped: 'missing_on_target' });
        continue;
      }

      if (options.truncateTarget) {
        await target
          .query(`truncate table public."${table.replace(/"/g, '""')}" cascade`)
          .catch((e) => emit({ type: 'warn', message: `truncate ${table}: ${e.message}` }));
      }

      const types = await targetColumnTypes(target, table);
      let rowsCopied = 0;

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
          const columns = Object.keys(batch[0]).filter((c) => types.has(c));
          if (columns.length === 0) break;
          const params: unknown[] = [];
          const tuples = batch.map((row) => {
            const placeholders = columns.map((col) => {
              params.push(encodeValue(row[col], types.get(col)));
              return `$${params.length}`;
            });
            return `(${placeholders.join(',')})`;
          });
          const colList = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(',');
          const sql = `insert into public."${table.replace(/"/g, '""')}" (${colList}) values ${tuples.join(',')} on conflict do nothing`;
          try {
            await target.query(sql, params);
            rowsCopied += batch.length;
          } catch (e) {
            emit({ type: 'warn', message: `${table}: ${(e as Error).message}` });
          }
        }

        if (page.length < PAGE_SIZE) break;
      }

      totalRows += rowsCopied;
      emit({ type: 'tableDone', table, rows: rowsCopied });
    }

    if (replicaMode) {
      await target.query("set session_replication_role = 'origin'").catch(() => undefined);
    }

    // Re-align identity/serial sequences with the copied data.
    emit({ type: 'stage', stage: 'sequences' });
    await target
      .query(`
        DO $seq$
        DECLARE r record;
        BEGIN
          FOR r IN
            SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS seq,
                   pg_get_serial_sequence(quote_ident(tn.nspname) || '.' || quote_ident(t.relname), a.attname) AS owned,
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
        $seq$;`)
      .catch((e) => emit({ type: 'warn', message: `sequences: ${e.message}` }));

    emit({ type: 'done', tables: tables.length, rows: totalRows });
  } finally {
    await target.end().catch(() => undefined);
  }
}
