/**
 * The parity cases: supabase-js calls covering every builder feature the
 * backend uses (inventoried across server/ and worker/), plus the error paths
 * callers branch on (23505, 23503, PGRST116, PGRST202, PGRST204, PGRST205,
 * 42703, P0001).
 *
 * Each case runs against seeded data (seed.sql) through a client whose schema
 * is `pgrst_parity`. `expected.json` holds what PostgREST 13.0.8 — the
 * version Supabase runs — answered for each, recorded by record.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const A = '11111111-1111-1111-1111-111111111111';
export const B = '22222222-2222-2222-2222-222222222222';
export const C = '33333333-3333-3333-3333-333333333333';
export const W1 = 'aaaaaaaa-0000-0000-0000-000000000001';
export const W2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const D = '44444444-4444-4444-4444-444444444444';
const E = '55555555-5555-5555-5555-555555555555';

/** The two entry points the cases use, whatever schema the client was made for. */
export type Sb = Pick<SupabaseClient, 'from' | 'rpc'>;

export interface ParityCase {
  name: string;
  run: (sb: Sb) => PromiseLike<unknown>;
  /** A read run after `run`, to compare the state a mutation left behind. */
  after?: (sb: Sb) => PromiseLike<unknown>;
}

const parents = (sb: Sb) => sb.from('parent').select('id, name, n, status, meta, tags').order('name');

export const CASES: ParityCase[] = [
  // ── reads ──────────────────────────────────────────────────────────────
  { name: 'select star ordered', run: (sb) => sb.from('parent').select('*').order('name') },
  { name: 'select no args', run: (sb) => sb.from('kv').select().order('key') },
  { name: 'columns with whitespace', run: (sb) => sb.from('parent').select(' id ,\n  name ').order('name') },
  { name: 'eq + order desc', run: (sb) => sb.from('parent').select('id, name').eq('status', 'open').order('name', { ascending: false }) },
  { name: 'count exact head', run: (sb) => sb.from('parent').select('*', { count: 'exact', head: true }).eq('status', 'open') },
  { name: 'count exact head no match', run: (sb) => sb.from('parent').select('*', { count: 'exact', head: true }).eq('status', 'nope') },
  { name: 'count exact with range', run: (sb) => sb.from('parent').select('name', { count: 'exact' }).order('name').range(0, 1) },
  { name: 'count exact range offset', run: (sb) => sb.from('parent').select('name', { count: 'exact' }).order('name').range(1, 5) },
  { name: 'count exact full page', run: (sb) => sb.from('parent').select('name', { count: 'exact' }).order('name') },
  { name: 'count exact empty', run: (sb) => sb.from('parent').select('name', { count: 'exact' }).eq('name', 'nobody') },
  { name: 'limit', run: (sb) => sb.from('parent').select('name').order('name').limit(2) },
  { name: 'in with reserved chars', run: (sb) => sb.from('parent').select('name').in('name', ['alpha', 'be,ta', 'gamma', 'x(y)']).order('name') },
  { name: 'in empty list', run: (sb) => sb.from('parent').select('name').in('name', []) },
  { name: 'in uuids', run: (sb) => sb.from('parent').select('name').in('id', [A, C]).order('name') },
  { name: 'not in (string tuple)', run: (sb) => sb.from('parent').select('name').not('status', 'in', '(closed,archived)').order('name') },
  { name: 'is null', run: (sb) => sb.from('parent').select('name').is('meta', null).order('name') },
  { name: 'not is null', run: (sb) => sb.from('parent').select('name').not('meta', 'is', null).order('name') },
  { name: 'neq', run: (sb) => sb.from('parent').select('name').neq('status', 'closed').order('name') },
  { name: 'gt gte lt lte', run: (sb) => sb.from('parent').select('name').gte('n', 1).lte('n', 9).gt('created_at', '2025-01-01').lt('created_at', '2027-01-01').order('name') },
  { name: 'eq boolean-ish number', run: (sb) => sb.from('parent').select('name').eq('n', 7).order('name') },
  { name: 'like percent', run: (sb) => sb.from('parent').select('name').like('name', '%ph%') },
  { name: 'like star', run: (sb) => sb.from('parent').select('name').like('name', '*mm*') },
  { name: 'ilike no wildcard', run: (sb) => sb.from('parent').select('name').ilike('name', 'ALPHA') },
  { name: 'ilike prefix', run: (sb) => sb.from('parent').select('name').ilike('name', 'B%') },
  { name: 'or simple', run: (sb) => sb.from('parent').select('name').or('name.eq.alpha,name.eq.gamma').order('name') },
  { name: 'or nested and', run: (sb) => sb.from('parent').select('name').or('name.eq.alpha,and(n.gt.1,name.like.*mm*)').order('name') },
  { name: 'or with in list', run: (sb) => sb.from('parent').select('name').or('status.eq.closed,and(status.in.(open,pending),n.lt.8)').order('name') },
  { name: 'or quoted timestamp', run: (sb) => sb.from('child').select('label').or('sent_at.is.null,sent_at.lt."2026-03-01T00:00:00+00:00"').order('label') },
  { name: 'or quoted in values', run: (sb) => sb.from('parent').select('name').or(`id.in.("${A}","${B}")`).order('name') },
  { name: 'or json path', run: (sb) => sb.from('parent').select('name').or('meta->>k.is.null,meta->>k.neq.v').order('name') },
  { name: 'or ilike escaped', run: (sb) => sb.from('parent').select('name').or('name.ilike.*al*,status.ilike.%clo%').order('name') },
  { name: 'two or groups', run: (sb) => sb.from('parent').select('name').or('n.eq.7,n.eq.1').or('status.eq.open,status.eq.closed').order('name') },
  { name: 'contains object', run: (sb) => sb.from('parent').select('name').contains('meta', { k: 'v' }) },
  { name: 'contains text[]', run: (sb) => sb.from('parent').select('name').contains('tags', ['a']) },
  { name: 'contains jsonb with array (error)', run: (sb) => sb.from('parent').select('name').contains('meta', [{ k: 'v' }]) },
  { name: 'filter json path eq', run: (sb) => sb.from('child').select('label').filter('payload->>message_id', 'eq', 'm1') },
  { name: 'eq json path', run: (sb) => sb.from('parent').select('name').eq('meta->>k', 'v') },
  { name: 'not json path is null', run: (sb) => sb.from('parent').select('name').not('meta->>k', 'is', null).order('name') },
  { name: 'json path select with alias', run: (sb) => sb.from('parent').select('id, k:meta->>k, meta->num, first:tags->0').order('name') },
  { name: 'order nullsFirst false', run: (sb) => sb.from('child').select('label, score').order('score', { ascending: false, nullsFirst: false }) },
  { name: 'order nulls first asc', run: (sb) => sb.from('child').select('label, score').order('score', { ascending: true, nullsFirst: true }) },
  { name: 'two orders', run: (sb) => sb.from('parent').select('name, n').order('n', { ascending: false }).order('name') },
  { name: 'text search simple', run: (sb) => sb.from('parent').select('name').textSearch('doc', 'alpha', { config: 'simple' }) },
  { name: 'maybeSingle none', run: (sb) => sb.from('parent').select('name').eq('name', 'nobody').maybeSingle() },
  { name: 'maybeSingle one', run: (sb) => sb.from('parent').select('name, n').eq('name', 'alpha').maybeSingle() },
  { name: 'maybeSingle many', run: (sb) => sb.from('parent').select('name').maybeSingle() },
  { name: 'single none', run: (sb) => sb.from('parent').select('name').eq('name', 'nobody').single() },
  { name: 'single one', run: (sb) => sb.from('parent').select('*').eq('id', A).single() },
  { name: 'single many', run: (sb) => sb.from('parent').select('name').single() },

  // ── embeds ─────────────────────────────────────────────────────────────
  { name: 'embed to-many by fk hint', run: (sb) => sb.from('parent').select('name, child!child_parent_id_fkey(label, score, id)').order('name') },
  { name: 'embed to-one by fk hint', run: (sb) => sb.from('child').select('label, parent!child_parent_id_fkey(name)').order('id') },
  { name: 'embed via fk columns with aliases', run: (sb) => sb.from('child').select('label, p:parent_id(name), op:other_parent_id(name, n)').order('id') },
  { name: 'embed one-to-one', run: (sb) => sb.from('parent').select('name, profile(note)').order('name') },
  { name: 'embed one-to-one star', run: (sb) => sb.from('parent').select('*, profile(*)').order('name').limit(1) },
  { name: 'embed many-to-one by table', run: (sb) => sb.from('member').select('user_name, role, workspace(name, slug)').order('user_name') },
  { name: 'embed one-to-many by table', run: (sb) => sb.from('workspace').select('slug, member(user_name, role)').order('slug') },
  { name: 'embed star', run: (sb) => sb.from('member').select('*, workspace(*)').order('user_name') },
  { name: 'embed alias over table', run: (sb) => sb.from('member').select('user_name, ws:workspace(slug)').order('user_name') },
  { name: 'two hinted embeds of one table', run: (sb) => sb.from('child').select('*, a:parent!child_parent_id_fkey(name), b:parent!child_other_parent_id_fkey(name)').order('id') },
  { name: 'inner embed + embedded filter', run: (sb) => sb.from('child').select('label, parent!child_parent_id_fkey!inner(name)').eq('parent.name', 'beta') },
  { name: 'inner embed + count', run: (sb) => sb.from('member').select('user_name, workspace!inner(slug)', { count: 'exact' }).eq('workspace.slug', 'one').order('user_name').range(0, 0) },
  { name: 'non-inner embed filter keeps parents', run: (sb) => sb.from('child').select('label, p:parent_id(name)').eq('p.name', 'beta').order('id') },
  { name: 'inner embed whitespace template', run: (sb) => sb.from('member').select(`user_name, role, workspace!inner (
      id, slug, name
    )`).order('user_name') },
  { name: 'ambiguous embed', run: (sb) => sb.from('parent').select('*, child(*)') },
  { name: 'unknown relationship', run: (sb) => sb.from('parent').select('id, nothing_here(*)') },
  { name: 'filter on non-embedded path', run: (sb) => sb.from('parent').select('id').eq('ghost.name', 'x') },

  // ── schema errors ──────────────────────────────────────────────────────
  { name: 'unknown table', run: (sb) => sb.from('no_such_table').select('*') },
  { name: 'unknown column in select', run: (sb) => sb.from('parent').select('nope') },
  { name: 'unknown column in filter', run: (sb) => sb.from('parent').select('id').eq('nope', 1) },
  { name: 'invalid uuid', run: (sb) => sb.from('parent').select('id').eq('id', 'not-a-uuid') },

  // ── inserts ────────────────────────────────────────────────────────────
  {
    name: 'insert single select single',
    run: (sb) => sb.from('parent').insert({ id: D, name: 'delta', meta: { x: [1, 2] }, tags: ['p', 'q'] }).select().single(),
    after: parents,
  },
  {
    name: 'insert array missing keys -> null',
    run: (sb) => sb.from('parent').insert([{ id: D, name: 'delta' }, { id: E, name: 'epsilon', n: 3, status: 'closed' }]).select('id, name, n, status'),
  },
  { name: 'insert minimal', run: (sb) => sb.from('parent').insert({ id: D, name: 'delta' }), after: parents },
  { name: 'insert array minimal', run: (sb) => sb.from('child').insert([{ parent_id: A, label: 'n1' }, { parent_id: B, label: 'n2' }]), after: (sb) => sb.from('child').select('*').order('id') },
  { name: 'insert select id identity', run: (sb) => sb.from('child').insert([{ parent_id: A, label: 'n1' }]).select('id') },
  { name: 'insert select maybeSingle', run: (sb) => sb.from('kv').insert({ key: 'k9', value: { a: 1 }, updated_at: '2026-02-02T00:00:00Z' }).select('key, value').maybeSingle() },
  { name: 'insert duplicate pk', run: (sb) => sb.from('parent').insert({ id: A, name: 'dup' }) },
  { name: 'insert fk violation', run: (sb) => sb.from('child').insert({ parent_id: D, label: 'orphan' }) },
  { name: 'insert unknown column', run: (sb) => sb.from('parent').insert({ id: D, name: 'x', nope: 1 }) },
  { name: 'insert not null violation', run: (sb) => sb.from('parent').insert({ id: D }) },
  { name: 'insert empty array', run: (sb) => sb.from('parent').insert([]).select() },
  { name: 'insert with embed in representation', run: (sb) => sb.from('member').insert({ workspace_id: W2, user_name: 'zed' }).select('user_name, workspace(slug)').single() },

  // ── upserts ────────────────────────────────────────────────────────────
  {
    name: 'upsert merge existing',
    run: (sb) => sb.from('profile').upsert({ parent_id: A, note: 'merged' }, { onConflict: 'parent_id' }).select('note').single(),
    after: (sb) => sb.from('profile').select('*').order('parent_id'),
  },
  { name: 'upsert merge new', run: (sb) => sb.from('profile').upsert({ parent_id: C, note: 'fresh' }, { onConflict: 'parent_id' }).select() },
  { name: 'upsert ignore duplicates', run: (sb) => sb.from('profile').upsert({ parent_id: A, note: 'ignored' }, { onConflict: 'parent_id', ignoreDuplicates: true }).select(), after: (sb) => sb.from('profile').select('*').order('parent_id') },
  { name: 'upsert default pk conflict', run: (sb) => sb.from('kv').upsert({ key: 'k1', value: { b: 2 }, updated_at: '2026-03-03T00:00:00Z' }), after: (sb) => sb.from('kv').select('*').order('key') },
  {
    name: 'upsert array composite conflict',
    run: (sb) =>
      sb
        .from('member')
        .upsert(
          [
            { workspace_id: W1, user_name: 'ann', role: 'owner' },
            { workspace_id: W1, user_name: 'new', role: 'viewer' },
          ],
          { onConflict: 'workspace_id, user_name' },
        )
        .select('user_name, role'),
  },

  // ── updates ────────────────────────────────────────────────────────────
  { name: 'update eq select maybeSingle', run: (sb) => sb.from('parent').update({ n: 42, meta: { z: true } }).eq('id', A).select('id, n, meta').maybeSingle() },
  { name: 'update minimal count', run: (sb) => sb.from('parent').update({ status: 'pending' }, { count: 'exact' }).eq('status', 'open'), after: parents },
  { name: 'update no match single', run: (sb) => sb.from('parent').update({ n: 1 }).eq('name', 'nobody').select().single() },
  {
    name: 'update many rows single rolls back',
    run: (sb) => sb.from('parent').update({ n: 99 }).eq('status', 'open').select('name').single(),
    after: parents,
  },
  { name: 'update select limit', run: (sb) => sb.from('parent').update({ n: 5 }).eq('id', B).select('id').limit(1), after: parents },
  { name: 'update with or filter', run: (sb) => sb.from('child').update({ sent_at: '2026-05-05T00:00:00Z' }).eq('parent_id', A).or('sent_at.is.null,sent_at.lt."2026-03-01T00:00:00+00:00"').select('label, sent_at') },
  { name: 'update json path filter', run: (sb) => sb.from('kv').update({ value: { lease_until: '2026-12-01T00:00:00Z' } }).eq('key', 'lease').lt('value->>lease_until', '2026-06-01T00:00:00Z').select('key') },
  { name: 'update is null json path', run: (sb) => sb.from('parent').update({ status: 'tagged' }).is('meta->>k', null).select('name').order('name') },
  { name: 'update returning embed', run: (sb) => sb.from('member').update({ role: 'admin' }).eq('user_name', 'bob').select('*, workspace(name)').maybeSingle() },
  { name: 'update unknown column', run: (sb) => sb.from('parent').update({ nope: 1 }).eq('id', A) },
  { name: 'update to unique violation', run: (sb) => sb.from('workspace').update({ slug: 'two' }).eq('slug', 'one') },
  { name: 'update count exact select', run: (sb) => sb.from('parent').update({ n: 8 }, { count: 'exact' }).eq('name', 'alpha').select('name') },

  // ── deletes ────────────────────────────────────────────────────────────
  { name: 'delete count exact', run: (sb) => sb.from('child').delete({ count: 'exact' }).eq('parent_id', A), after: (sb) => sb.from('child').select('id, label').order('id') },
  { name: 'delete select', run: (sb) => sb.from('kv').delete().eq('key', 'k1').select() },
  { name: 'delete no match', run: (sb) => sb.from('kv').delete().eq('key', 'nope') },
  { name: 'delete fk restrict', run: (sb) => sb.from('parent').delete().eq('id', A) },
  {
    // server/services/privacy/anonymizer.ts deletes identity_merges this way.
    name: 'delete with or and select id',
    run: (sb) => sb.from('child').delete().eq('parent_id', A).or('sent_at.is.null,label.eq.c1').select('id'),
    after: (sb) => sb.from('child').select('id, label').order('id'),
  },
  { name: 'delete with or minimal', run: (sb) => sb.from('child').delete().or('sent_at.is.null,label.eq.c1'), after: (sb) => sb.from('child').select('id, label').order('id') },
  { name: 'update with or minimal', run: (sb) => sb.from('child').update({ sent_at: '2026-05-05T00:00:00Z' }).eq('parent_id', A).or('sent_at.is.null,sent_at.lt."2026-03-01T00:00:00+00:00"'), after: (sb) => sb.from('child').select('label, sent_at').order('id') },

  // ── functions ──────────────────────────────────────────────────────────
  { name: 'rpc composite', run: (sb) => sb.rpc('comp_one', { _n: 1 }) },
  { name: 'rpc void', run: (sb) => sb.rpc('do_nothing') },
  { name: 'rpc scalar default arg', run: (sb) => sb.rpc('scalar_fn', { a: 1 }) },
  { name: 'rpc scalar all args', run: (sb) => sb.rpc('scalar_fn', { a: 2, b: 'y' }) },
  { name: 'rpc setof text', run: (sb) => sb.rpc('set_text', { _n: 3 }) },
  { name: 'rpc setof text range', run: (sb) => sb.rpc('set_text', { _n: 5 }).range(1, 2) },
  { name: 'rpc returns table', run: (sb) => sb.rpc('set_table', { _n: 2 }) },
  { name: 'rpc jsonb arg', run: (sb) => sb.rpc('json_fn', { _x: { a: [1, 2], s: 'x' } }) },
  { name: 'rpc uuid[] and bool args', run: (sb) => sb.rpc('arr_fn', { _ids: [A, B], _flag: true }) },
  { name: 'rpc raise', run: (sb) => sb.rpc('raise_fn') },
  { name: 'rpc out params', run: (sb) => sb.rpc('out_fn') },
  { name: 'rpc boolean', run: (sb) => sb.rpc('bool_fn', { _x: 'a' }) },
  { name: 'rpc null scalar', run: (sb) => sb.rpc('null_fn') },
  { name: 'rpc setof table filtered', run: (sb) => sb.rpc('set_parents').eq('status', 'open').order('name') },
  { name: 'rpc unknown function', run: (sb) => sb.rpc('no_such_fn', { a: 1, b: 2 }) },
  { name: 'rpc unknown function no args', run: (sb) => sb.rpc('no_such_fn') },
  { name: 'rpc unknown argument', run: (sb) => sb.rpc('scalar_fn', { a: 1, zzz: 2 }) },
  { name: 'rpc missing required argument', run: (sb) => sb.rpc('scalar_fn', { b: 'x' }) },
  { name: 'rpc max rows', run: (sb) => sb.rpc('set_text', { _n: 1500 }).then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data.length : r.data })) },
];
