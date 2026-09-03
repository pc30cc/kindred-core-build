/**
 * Minimal generic in-memory fake of the subset of the Supabase JS
 * query-builder surface the SEO feature actually uses (select/insert/
 * update/upsert with eq/neq/in/gte/gt/lt/lte/ilike/order/range/limit,
 * maybeSingle/single, bare-awaited "thenable" reads, and the one
 * `alias:fk_column(col)` embedded-resource join this codebase's read
 * queries use). Built for the SEO end-to-end smoke test so the REAL
 * siteResolver/limits/crawlService/queue/crawlSite/linkGraph/rules-engine
 * modules can run unmodified against a fake database instead of a live
 * Postgres instance.
 */
import { vi } from 'vitest';

export type FakeTables = Record<string, any[]>;

let idCounter = 0;
function randomId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

// Only join spec this codebase's read queries actually use.
const JOIN_TABLE_BY_FK: Record<string, string> = { source_page_id: 'seo_pages' };

// A trimmed mirror of each table's real column DEFAULTs (108_seo_audit_core.sql),
// applied on insert so app code that (correctly) relies on the DB default for a
// column it doesn't set explicitly behaves the same against this fake.
const TABLE_DEFAULTS: Record<string, Record<string, unknown>> = {
  background_jobs: {
    status: 'queued', priority: 100, attempts: 0, max_attempts: 2, progress: 0,
    progress_stage: null, cancel_requested: false, locked_by: null, locked_at: null,
    lock_expires_at: null, error_message: null, error_category: null, payload: {},
    created_by: null, started_at: null, finished_at: null,
  },
  seo_crawls: {
    status: 'queued', progress: 0, progress_stage: null, pages_discovered: 0, pages_crawled: 0,
    pages_failed: 0, pages_skipped: 0, score: null, score_version: null, score_breakdown: null,
    robots_summary: null, sitemap_summary: null, cancel_requested: false, error_message: null,
    error_category: null, created_by: null, started_at: null, finished_at: null,
    respect_robots: true, limits: {},
  },
  seo_pages: {
    final_url: null, discovered_via: 'link', depth: 0, http_status: null, content_type: null,
    response_time_ms: null, response_bytes: null, redirect_chain: [], title: null, title_length: null,
    meta_description: null, meta_description_length: null, canonical_url: null, canonical_status: null,
    meta_robots: null, is_indexable: true, is_nofollow: false, h1: null, h1_count: 0, h2_count: 0,
    lang: null, charset: null, word_count: 0, internal_links_count: 0, external_links_count: 0,
    incoming_internal_links_count: 0, images_count: 0, images_missing_alt_count: 0,
    has_open_graph: false, has_twitter_card: false, has_structured_data: false,
    structured_data_types: [], structured_data_errors: [], html_size_bytes: null, is_https: true,
    has_mixed_content: false, fetch_error: null, crawled_at: null,
  },
  seo_links: {
    target_normalized_url: null, target_page_id: null, is_external: false, anchor_text: null,
    rel: null, http_status: null, is_broken: false,
  },
  seo_issues: { status: 'new' },
  seo_sitemaps: { http_status: null, error_message: null, url_count: 0 },
};

/** Splits a PostgREST filter string on top-level commas (parens don't count). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseSimpleClause(token: string): { col: string; op: string; val: string } {
  const idx1 = token.indexOf('.');
  const col = token.slice(0, idx1);
  const rest = token.slice(idx1 + 1);
  const idx2 = rest.indexOf('.');
  const op = rest.slice(0, idx2);
  const val = rest.slice(idx2 + 1);
  return { col, op, val };
}

function matchClause(row: any, clause: { col: string; op: string; val: string }): boolean {
  const v = row[clause.col];
  switch (clause.op) {
    case 'eq': return String(v) === clause.val;
    case 'neq': return String(v) !== clause.val;
    case 'lt': return v != null && new Date(v).getTime() < new Date(clause.val).getTime();
    case 'lte': return v != null && new Date(v).getTime() <= new Date(clause.val).getTime();
    case 'gt': return v != null && new Date(v).getTime() > new Date(clause.val).getTime();
    case 'gte': return v != null && new Date(v).getTime() >= new Date(clause.val).getTime();
    case 'in': {
      const list = clause.val.replace(/^\(|\)$/g, '').split(',');
      return list.includes(String(v));
    }
    default: return false;
  }
}

/** Parses a PostgREST `.or("a.eq.b,and(c.in.(x,y),d.lt.<ts>)")` string into a predicate. */
function parseOrExpression(expr: string): (row: any) => boolean {
  const groups = splitTopLevel(expr).map((token) => {
    const trimmed = token.trim();
    if (trimmed.startsWith('and(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(4, -1);
      const clauses = splitTopLevel(inner).map(parseSimpleClause);
      return (row: any) => clauses.every((c) => matchClause(row, c));
    }
    const clause = parseSimpleClause(trimmed);
    return (row: any) => matchClause(row, clause);
  });
  return (row: any) => groups.some((g) => g(row));
}

function applyFilters(rows: any[], filters: Array<{ col: string; op: string; val: any }>): any[] {
  return rows.filter((r) =>
    filters.every((f) => {
      const v = r[f.col];
      switch (f.op) {
        case 'eq': return v === f.val;
        case 'neq': return v !== f.val;
        case 'in': return Array.isArray(f.val) && f.val.includes(v);
        case 'gte': return v >= f.val;
        case 'gt': return v > f.val;
        case 'lt': return v < f.val;
        case 'lte': return v <= f.val;
        case 'ilike': {
          const needle = String(f.val).replace(/%/g, '').toLowerCase();
          return typeof v === 'string' && v.toLowerCase().includes(needle);
        }
        default: return true;
      }
    }),
  );
}

function projectJoins(row: any, selectCols: string | undefined): any {
  if (!selectCols) return row;
  const out = { ...row };
  const joinRe = /(\w+):(\w+)\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = joinRe.exec(selectCols)) !== null) {
    const [, alias, fkCol] = m;
    const targetTable = JOIN_TABLE_BY_FK[fkCol];
    if (!targetTable) continue;
    out[alias] = null; // resolved lazily by makeFakeSupabase via closure below
    out.__joins = out.__joins || [];
    out.__joins.push({ alias, fkCol, targetTable });
  }
  return out;
}

export function makeFakeSupabase(tables: FakeTables) {
  function from(name: string) {
    if (!tables[name]) tables[name] = [];
    const filters: Array<{ col: string; op: string; val: any }> = [];
    let orderSpecs: Array<{ col: string; ascending: boolean }> = [];
    let rangeSpec: [number, number] | null = null;
    let limitSpec: number | null = null;
    let selectCols: string | undefined;
    let wantCount = false;
    let pendingOp: { type: 'insert' | 'update' | 'upsert' | 'delete'; payload?: any; onConflict?: string } | null = null;
    let orPredicate: ((row: any) => boolean) | null = null;

    function resolveJoins(row: any): any {
      if (!row.__joins) return row;
      const out = { ...row };
      for (const j of row.__joins) {
        const target = (tables[j.targetTable] || []).find((t) => t.id === row[j.fkCol]);
        out[j.alias] = target ? { url: target.url } : null;
      }
      delete out.__joins;
      return out;
    }

    async function execute(mode: 'maybeSingle' | 'single' | 'bare') {
      if (pendingOp) {
        if (pendingOp.type === 'insert') {
          const rows = Array.isArray(pendingOp.payload) ? pendingOp.payload : [pendingOp.payload];
          const now = new Date().toISOString();
          const defaults = TABLE_DEFAULTS[name] || {};
          const inserted = rows.map((r: any) => ({ id: randomId(), created_at: now, updated_at: now, ...defaults, ...r }));
          tables[name].push(...inserted);
          return finish(inserted, mode);
        }
        if (pendingOp.type === 'update') {
          const matched = applyFilters(tables[name], filters);
          matched.forEach((r) => Object.assign(r, pendingOp!.payload, { updated_at: new Date().toISOString() }));
          return finish(matched, mode);
        }
        if (pendingOp.type === 'upsert') {
          const rows = Array.isArray(pendingOp.payload) ? pendingOp.payload : [pendingOp.payload];
          const conflictCols = (pendingOp.onConflict || 'id').split(',');
          const defaults = TABLE_DEFAULTS[name] || {};
          const out: any[] = [];
          for (const r of rows) {
            const existing = tables[name].find((row) => conflictCols.every((c) => row[c] === r[c]));
            if (existing) {
              Object.assign(existing, r, { updated_at: new Date().toISOString() });
              out.push(existing);
            } else {
              const now = new Date().toISOString();
              const nr = { id: randomId(), created_at: now, updated_at: now, ...defaults, ...r };
              tables[name].push(nr);
              out.push(nr);
            }
          }
          return finish(out, mode);
        }
        if (pendingOp.type === 'delete') {
          const matched = applyFilters(tables[name], filters);
          tables[name] = tables[name].filter((r) => !matched.includes(r));
          return finish(matched, mode);
        }
      }

      let rows = applyFilters(tables[name], filters);
      if (orPredicate) rows = rows.filter(orPredicate);
      const total = rows.length;
      for (const spec of [...orderSpecs].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[spec.col];
          const bv = b[spec.col];
          if (av === bv) return 0;
          const cmp = av > bv ? 1 : -1;
          return spec.ascending ? cmp : -cmp;
        });
      }
      if (rangeSpec) rows = rows.slice(rangeSpec[0], rangeSpec[1] + 1);
      else if (limitSpec !== null) rows = rows.slice(0, limitSpec);
      rows = rows.map((r) => resolveJoins(projectJoins(r, selectCols)));
      return finish(rows, mode, total);
    }

    function finish(rows: any[], mode: 'maybeSingle' | 'single' | 'bare', total?: number) {
      const count = wantCount ? (total ?? rows.length) : undefined;
      if (mode === 'single' || mode === 'maybeSingle') {
        if (rows.length === 0) return { data: null, error: mode === 'single' ? { message: 'no rows' } : null, count };
        return { data: rows[0], error: null, count };
      }
      return { data: rows, error: null, count };
    }

    const builder: any = {
      select(cols: string, opts?: { count?: string; head?: boolean }) {
        selectCols = cols;
        if (opts?.count) wantCount = true;
        return builder;
      },
      eq(c: string, v: any) { filters.push({ col: c, op: 'eq', val: v }); return builder; },
      neq(c: string, v: any) { filters.push({ col: c, op: 'neq', val: v }); return builder; },
      in(c: string, v: any[]) { filters.push({ col: c, op: 'in', val: v }); return builder; },
      gte(c: string, v: any) { filters.push({ col: c, op: 'gte', val: v }); return builder; },
      gt(c: string, v: any) { filters.push({ col: c, op: 'gt', val: v }); return builder; },
      lt(c: string, v: any) { filters.push({ col: c, op: 'lt', val: v }); return builder; },
      lte(c: string, v: any) { filters.push({ col: c, op: 'lte', val: v }); return builder; },
      ilike(c: string, v: any) { filters.push({ col: c, op: 'ilike', val: v }); return builder; },
      or(expr: string) { orPredicate = parseOrExpression(expr); return builder; },
      order(c: string, opts?: { ascending?: boolean }) { orderSpecs.push({ col: c, ascending: opts?.ascending !== false }); return builder; },
      range(a: number, b: number) { rangeSpec = [a, b]; return builder; },
      limit(n: number) { limitSpec = n; return builder; },
      insert(payload: any) { pendingOp = { type: 'insert', payload }; return builder; },
      update(payload: any) { pendingOp = { type: 'update', payload }; return builder; },
      upsert(payload: any, opts?: { onConflict?: string }) { pendingOp = { type: 'upsert', payload, onConflict: opts?.onConflict }; return builder; },
      delete() { pendingOp = { type: 'delete' }; return builder; },
      maybeSingle: () => execute('maybeSingle'),
      single: () => execute('single'),
      then(resolve: any, reject: any) { return execute('bare').then(resolve, reject); },
    };
    return builder;
  }

  return { from, rpc: vi.fn(async () => ({ data: null, error: null })) };
}
