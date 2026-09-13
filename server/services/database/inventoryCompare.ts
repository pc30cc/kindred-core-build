/**
 * Exact structural + row-count comparison between the source database and a
 * self-hosted PostgreSQL target.
 *
 * Both sides answer the SAME question with the SAME SQL: the source through
 * the SECURITY DEFINER RPC `admin_database_inventory` (whose body is this very
 * statement — keep the two in sync, see
 * database/migrations/166_admin_database_inventory.sql), the target through a
 * direct `pg` connection. The diff is then computed here, in one place.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { connectTarget } from './selfhostMigration.js';

export const INVENTORY_SQL = `
select jsonb_build_object(
  'tables', coalesce((
    select jsonb_object_agg(x.relname, jsonb_build_object('columns', x.cols, 'rows', x.nrows))
    from (
      select c.relname,
             (select coalesce(jsonb_object_agg(a.attname, format_type(a.atttypid, a.atttypmod)), '{}'::jsonb)
                from pg_attribute a
               where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as cols,
             coalesce(((xpath('/row/c/text()',
               query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1])::text::bigint, 0) as nrows
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
    ) x), '{}'::jsonb),
  'views', coalesce((select jsonb_agg(s.v order by s.v) from (
      select c.relname as v from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('v','m')) s), '[]'::jsonb),
  'functions', coalesce((select jsonb_agg(s.v order by s.v) from (
      select p.oid::regprocedure::text as v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public') s), '[]'::jsonb),
  'triggers', coalesce((select jsonb_agg(s.v order by s.v) from (
      select cl.relname || '.' || t.tgname as v
        from pg_trigger t join pg_class cl on cl.oid = t.tgrelid
        join pg_namespace n on n.oid = cl.relnamespace
       where n.nspname = 'public' and not t.tgisinternal) s), '[]'::jsonb),
  'policies', coalesce((select jsonb_agg(s.v order by s.v) from (
      select tablename || '.' || policyname as v from pg_policies where schemaname = 'public') s), '[]'::jsonb),
  'indexes', coalesce((select jsonb_agg(s.v order by s.v) from (
      select indexname as v from pg_indexes where schemaname = 'public') s), '[]'::jsonb),
  'sequences', coalesce((select jsonb_agg(s.v order by s.v) from (
      select c.relname as v from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'S') s), '[]'::jsonb),
  'enums', coalesce((select jsonb_object_agg(e.typname, e.labels) from (
      select tt.typname, jsonb_agg(en.enumlabel order by en.enumsortorder) as labels
        from pg_type tt join pg_namespace n on n.oid = tt.typnamespace
        join pg_enum en on en.enumtypid = tt.oid
       where n.nspname = 'public' group by tt.typname) e), '{}'::jsonb),
  'constraints', coalesce((select jsonb_agg(s.v order by s.v) from (
      select cl.relname || '.' || co.conname as v
        from pg_constraint co join pg_class cl on cl.oid = co.conrelid
        join pg_namespace n on n.oid = cl.relnamespace
       where n.nspname = 'public') s), '[]'::jsonb)
) as inventory`;

export interface Inventory {
  tables: Record<string, { columns: Record<string, string>; rows: number }>;
  views: string[];
  functions: string[];
  triggers: string[];
  policies: string[];
  indexes: string[];
  sequences: string[];
  enums: Record<string, string[]>;
  constraints: string[];
}

type ListKey = 'views' | 'functions' | 'triggers' | 'policies' | 'indexes' | 'sequences' | 'constraints';
const LIST_KEYS: ListKey[] = ['views', 'functions', 'triggers', 'policies', 'indexes', 'sequences', 'constraints'];

export interface ListDiff {
  key: ListKey | 'tables' | 'enums';
  source: number;
  target: number;
  missingOnTarget: string[];
  extraOnTarget: string[];
}

export interface TableDiff {
  table: string;
  sourceRows: number;
  targetRows: number;
  missingColumns: string[];
  extraColumns: string[];
  typeMismatches: { column: string; source: string; target: string }[];
}

export interface CompareResult {
  identical: boolean;
  sections: ListDiff[];
  tables: {
    missingOnTarget: string[];
    extraOnTarget: string[];
    mismatched: TableDiff[];
    sourceRows: number;
    targetRows: number;
  };
}

const CAP = 200;

function diffLists(key: ListDiff['key'], source: string[], target: string[]): ListDiff {
  const t = new Set(target);
  const s = new Set(source);
  return {
    key,
    source: source.length,
    target: target.length,
    missingOnTarget: source.filter((v) => !t.has(v)).slice(0, CAP),
    extraOnTarget: target.filter((v) => !s.has(v)).slice(0, CAP),
  };
}

export function compareInventories(source: Inventory, target: Inventory): CompareResult {
  const sections = LIST_KEYS.map((k) => diffLists(k, source[k] ?? [], target[k] ?? []));

  const srcEnum = Object.entries(source.enums ?? {}).map(([n, l]) => `${n}(${l.join('|')})`);
  const tgtEnum = Object.entries(target.enums ?? {}).map(([n, l]) => `${n}(${l.join('|')})`);
  sections.push(diffLists('enums', srcEnum, tgtEnum));

  const srcTables = Object.keys(source.tables ?? {});
  const tgtTables = Object.keys(target.tables ?? {});
  const tgtSet = new Set(tgtTables);
  const srcSet = new Set(srcTables);

  const mismatched: TableDiff[] = [];
  let sourceRows = 0;
  let targetRows = 0;

  for (const name of srcTables) {
    const s = source.tables[name];
    sourceRows += Number(s.rows ?? 0);
    const t = target.tables?.[name];
    if (!t) continue;
    targetRows += Number(t.rows ?? 0);

    const sCols = s.columns ?? {};
    const tCols = t.columns ?? {};
    const missingColumns = Object.keys(sCols).filter((c) => !(c in tCols));
    const extraColumns = Object.keys(tCols).filter((c) => !(c in sCols));
    const typeMismatches = Object.keys(sCols)
      .filter((c) => c in tCols && tCols[c] !== sCols[c])
      .map((c) => ({ column: c, source: sCols[c], target: tCols[c] }));

    if (
      missingColumns.length ||
      extraColumns.length ||
      typeMismatches.length ||
      Number(s.rows ?? 0) !== Number(t.rows ?? 0)
    ) {
      mismatched.push({
        table: name,
        sourceRows: Number(s.rows ?? 0),
        targetRows: Number(t.rows ?? 0),
        missingColumns,
        extraColumns,
        typeMismatches,
      });
    }
  }
  for (const name of tgtTables) {
    if (!srcSet.has(name)) targetRows += Number(target.tables[name]?.rows ?? 0);
  }

  const tables = {
    missingOnTarget: srcTables.filter((n) => !tgtSet.has(n)).slice(0, CAP),
    extraOnTarget: tgtTables.filter((n) => !srcSet.has(n)).slice(0, CAP),
    mismatched: mismatched.slice(0, CAP),
    sourceRows,
    targetRows,
  };

  const identical =
    sections.every((s) => s.missingOnTarget.length === 0 && s.extraOnTarget.length === 0) &&
    tables.missingOnTarget.length === 0 &&
    tables.extraOnTarget.length === 0 &&
    tables.mismatched.length === 0;

  return { identical, sections, tables };
}

export async function compareWithTarget(
  sb: SupabaseClient,
  actorId: string,
  connectionString: string,
): Promise<CompareResult & { sourceTables: number; targetTables: number }> {
  const { data, error } = await sb.rpc('admin_database_inventory', { _actor_user_id: actorId });
  if (error) throw new Error(`source_inventory_failed: ${error.message}`);
  const source = data as unknown as Inventory;

  const client = await connectTarget(connectionString);
  let target: Inventory;
  try {
    const res = await client.query<{ inventory: Inventory }>(INVENTORY_SQL);
    target = res.rows[0]?.inventory as Inventory;
  } finally {
    await client.end().catch(() => undefined);
  }

  const result = compareInventories(source, target);
  return {
    ...result,
    sourceTables: Object.keys(source.tables ?? {}).length,
    targetTables: Object.keys(target?.tables ?? {}).length,
  };
}
