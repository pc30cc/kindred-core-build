#!/usr/bin/env python3
"""Generate an add-only self-host parity migration from two scratch databases:
  s_chain = database/migrations applied, h_chain = supabase/migrations applied.
Both were built with Supabase's default privileges so ACLs are comparable."""
import re, subprocess, sys, os

D = os.path.dirname(os.path.abspath(__file__))
PG = ['-h', '127.0.0.1', '-p', '55432', '-U', 'postgres']
OUT = sys.argv[1]
# Scratch databases to diff (see README): self-host build, hosted build.
S_DB = os.environ.get('S_DB', 's_chain')
H_DB = os.environ.get('H_DB', 'h_chain')


def psql(db, sql):
    r = subprocess.run(['psql', *PG, '-d', db, '-tA', '-F', '\x1f', '-R', '\x1e', '-v', 'ON_ERROR_STOP=1', '-c', sql], capture_output=True, text=True, check=True)
    return [l.split('\x1f') for l in r.stdout.rstrip('\n').split('\x1e') if l.strip('\n')]


def toc(db):
    subprocess.run(['pg_dump', *PG, '-d', db, '-n', 'public', '-s', '-Fc', '--no-owner', '-f', f'{D}/{db}.dump'], check=True)
    out = subprocess.run(['pg_restore', '-l', f'{D}/{db}.dump'], capture_output=True, text=True, check=True).stdout
    entries = {}
    for l in out.splitlines():
        if l.startswith(';') or not l.strip():
            continue
        m = re.match(r'^(\d+); (\d+) (\d+) (.*) (\S+)$', l)
        entries[m.group(4)] = l
    return entries


# The hosted billing gate, absent from self-host ON PURPOSE: the self-host
# billing model is "no check_workspace_entitlement". With
# SELF_HOST_BILLING_MODE=unlimited the server treats every workspace as
# unlimited exactly when that function is missing
# (server/middleware/featureGating.ts, checkEntitlementFromDB and the
# module/channel probes), so installing it would put an "unlimited" install
# under plan limits. The three callers go with it.
SELF_HOST_ABSENT = ('check_workspace_entitlement', 'check_module_access', 'check_channel_access', 'deduct_ai_credits')


def self_host_absent(fn_signature):
    return fn_signature.split('(')[0] in SELF_HOST_ABSENT


s_toc, h_toc = toc(S_DB), toc(H_DB)
missing = [(k, l) for k, l in h_toc.items() if k not in s_toc
           and not (k.startswith('FUNCTION public ') and self_host_absent(k[len('FUNCTION public '):]))]

# Object kinds handled here; ACLs are generated from catalogs instead (see below).
skip_prefix = ('ACL ',)
pre_types, pre_rest, views, post = [], [], [], []
for k, l in missing:
    if k.startswith(skip_prefix):
        continue
    kind = k.split(' public ')[0] if ' public ' in k else k.split()[0]
    if kind == 'TYPE':
        pre_types.append(l)
    elif kind in ('FUNCTION', 'TABLE', 'SEQUENCE', 'SEQUENCE OWNED BY', 'DEFAULT', 'TABLE ATTACH'):
        pre_rest.append(l)
    elif kind == 'VIEW':
        views.append(l)
    elif kind == 'COMMENT':
        post.append(l)
    else:
        post.append(l)


def restore(lines):
    if not lines:
        return ''
    lf = f'{D}/_list.txt'
    open(lf, 'w').write('\n'.join(lines) + '\n')
    return subprocess.run(['pg_restore', '--no-owner', '--no-privileges', '-L', lf, '-f', '-', f'{D}/{H_DB}.dump'], capture_output=True, text=True, check=True).stdout


def blocks(sql):
    """Split pg_restore output into (type, name, statement) blocks."""
    sql = sql.split('\n--\n-- PostgreSQL database dump complete')[0]
    sql = '\n'.join(l for l in sql.splitlines() if not l.startswith(('\\restrict', '\\unrestrict')))
    parts = re.split(r'\n--\n-- Name: ', sql)
    res = []
    for p in parts[1:]:
        hdr, _, body = p.partition('\n--\n')
        m = re.search(r'; Type: ([A-Z ]+);', hdr)
        res.append((m.group(1) if m else '?', hdr.split(';')[0], body.strip()))
    return res


def guard(stmt, errs):
    return f"DO $parity$ BEGIN\n  EXECUTE $stmt${stmt}$stmt$;\nEXCEPTION WHEN {' OR '.join(errs)} THEN NULL;\nEND $parity$;"


def make_idempotent(kind, stmt):
    s = stmt
    if kind == 'TABLE':
        s = re.sub(r'^CREATE (UNLOGGED )?TABLE ', r'CREATE \1TABLE IF NOT EXISTS ', s, flags=re.M)
    elif kind == 'SEQUENCE':
        s = re.sub(r'^CREATE SEQUENCE ', 'CREATE SEQUENCE IF NOT EXISTS ', s, flags=re.M)
    elif kind in ('FUNCTION', 'PROCEDURE'):
        s = re.sub(r'^CREATE (FUNCTION|PROCEDURE) ', r'CREATE OR REPLACE \1 ', s, flags=re.M)
    elif kind == 'VIEW':
        s = re.sub(r'^CREATE VIEW ', 'CREATE OR REPLACE VIEW ', s, flags=re.M)
    elif kind == 'INDEX':
        s = re.sub(r'^CREATE (UNIQUE )?INDEX ', r'CREATE \1INDEX IF NOT EXISTS ', s, flags=re.M)
    elif kind == 'TRIGGER':
        s = re.sub(r'^CREATE (CONSTRAINT )?TRIGGER ', r'CREATE OR REPLACE \1TRIGGER ', s, flags=re.M)
    elif kind == 'TYPE':
        s = '\n'.join(guard(x.strip().rstrip(';'), ['duplicate_object']) for x in split_top(s))
    elif kind in ('CONSTRAINT', 'FK CONSTRAINT', 'CHECK CONSTRAINT'):
        s = '\n'.join(guard(x.strip().rstrip(';'), ['duplicate_object', 'duplicate_table', 'invalid_table_definition']) for x in split_top(s))
    elif kind == 'POLICY':
        s = '\n'.join(guard(x.strip().rstrip(';'), ['duplicate_object']) for x in split_top(s))
    elif kind == 'TABLE ATTACH':
        s = '\n'.join(guard(x.strip().rstrip(';'), ['duplicate_object', 'invalid_object_definition', 'wrong_object_type']) for x in split_top(s))
    return s


def split_top(s):
    # statements in these blocks never contain dollar quotes; split on ';' at line ends
    return [x for x in re.split(r';\s*\n', s.strip() + '\n') if x.strip()]


# pgvector is optional on self-host: stock postgres:16 (the Integration CI job,
# and installs that are not on the Supabase image) does not ship it. Every
# column of type vector and every index over one is held back from the plain
# DDL and emitted in PGVECTOR_BLOCK, which runs only where the extension is
# installed — in whatever schema it lives.
vector_deferred = []


def defer_vector(kind, stmt):
    """Strip pgvector-typed columns / indexes out of `stmt`, recording them."""
    if kind == 'TABLE':
        table = re.search(r'CREATE TABLE (\S+) \(', stmt).group(1)
        keep = []
        for line in stmt.split('\n'):
            m = re.match(r'^\s+(\w+) public\.vector(\(\d+\))?,?$', line)
            if m:
                vector_deferred.append(f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {m.group(1)} %1$I.vector{m.group(2) or ""}')
            else:
                keep.append(line)
        return re.sub(r',(\n\);?)$', r'\1', '\n'.join(keep))
    if kind == 'INDEX' and 'public.vector_' in stmt:
        vector_deferred.append(make_idempotent(kind, stmt).rstrip(';').replace('public.vector_', '%1$I.vector_'))
        return ''
    return stmt


def emit(sql):
    out = []
    for kind, name, stmt in blocks(sql):
        stmt = defer_vector(kind, stmt)
        if not stmt:
            continue
        out.append(f'-- {kind}: {name}\n{make_idempotent(kind, stmt)}\n')
    return '\n'.join(out)


def pgvector_block():
    if not vector_deferred:
        return ''
    body = '\n'.join(f"  EXECUTE format($ddl${d}$ddl$, s);" for d in vector_deferred)
    return f"""DO $pgvector$
DECLARE s text;
BEGIN
  SELECT n.nspname INTO s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'vector';
  IF s IS NULL THEN
    RAISE NOTICE 'pgvector is not installed: skipping the vector columns and indexes below (AI knowledge retrieval needs them)';
    RETURN;
  END IF;
{body}
END $pgvector$;
"""


# ── columns missing on tables that exist in both chains ─────────────────
col_sql = """select c.relname, a.attname, format_type(a.atttypid,a.atttypmod), a.attnotnull,
  pg_get_expr(d.adbin,d.adrelid), a.attgenerated, a.attidentity
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped and not c.relispartition
  order by c.relname, a.attnum"""
s_cols = {(r[0], r[1]) for r in psql(S_DB, col_sql)}
s_tables = {r[0] for r in psql(S_DB, "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind in ('r','p')")}
col_lines = []
for t, col, typ, notnull, dflt, gen, ident in psql(H_DB, col_sql):
    if t not in s_tables or (t, col) in s_cols:
        continue
    q = f'ALTER TABLE public.{t} ADD COLUMN IF NOT EXISTS {col} {typ}'
    if gen == 's':
        q += f' GENERATED ALWAYS AS ({dflt}) STORED'
    else:
        if ident:
            q += ' GENERATED ' + ('ALWAYS' if ident == 'a' else 'BY DEFAULT') + ' AS IDENTITY'
        elif dflt:
            q += f' DEFAULT {dflt}'
        if notnull == 't':
            q += ' NOT NULL'
    col_lines.append(q + ';')

# ── constraints on shared tables that pg_dump prints inline (CHECKs) ──
con_sql = "select c.relname, co.conname, pg_get_constraintdef(co.oid), co.contype from pg_constraint co join pg_class c on c.oid=co.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and co.contype='c'"
s_con = {(r[0], r[1]) for r in psql(S_DB, con_sql)}
con_lines = [guard(f'ALTER TABLE public.{t} ADD CONSTRAINT {n} {d}', ['duplicate_object', 'duplicate_table']) for t, n, d, _ in psql(H_DB, con_sql) if t in s_tables and (t, n) not in s_con]

# ── enum values present in hosted but not self-host ────────────────────
enum_sql = "select t.typname, e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' order by t.typname, e.enumsortorder"
s_enum = {tuple(r) for r in psql(S_DB, enum_sql)}
s_types = {r[0] for r in psql(S_DB, "select typname from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'")}
enum_lines = [f"ALTER TYPE public.{t} ADD VALUE IF NOT EXISTS '{v}';" for t, v in psql(H_DB, enum_sql) if t in s_types and (t, v) not in s_enum]

# ── ACLs: new objects + objects whose privileges differ ────────────────
PRIV = {'r': 'SELECT', 'a': 'INSERT', 'w': 'UPDATE', 'd': 'DELETE', 'D': 'TRUNCATE', 'x': 'REFERENCES', 't': 'TRIGGER', 'X': 'EXECUTE', 'U': 'USAGE', 'm': 'MAINTAIN'}
ROLES = ('anon', 'authenticated', 'service_role')
rel_acl_sql = "select c.relname, c.relkind, coalesce(c.relacl::text,'') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S')"
fn_acl_sql = "select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', p.prokind, coalesce(p.proacl::text,'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')"


def acl_map(acl):
    m = {}
    for item in re.findall(r'[^{},"]*=[^,}"]*', acl):
        grantee, _, rest = item.partition('=')
        privs = rest.split('/')[0].replace('*', '')
        m[grantee or 'PUBLIC'] = privs
    return m


def effective(objtype, acl):
    """Privileges per grantee; a NULL acl is the built-in default."""
    if acl:
        return acl_map(acl)
    return {'PUBLIC': 'X'} if objtype in ('FUNCTION', 'PROCEDURE') else {}


def acl_stmts(objtype, name, m):
    targets = ('PUBLIC',) + ROLES
    out = [f'REVOKE ALL ON {objtype} {name} FROM {", ".join(targets)};']
    for g in targets:
        p = m.get(g, '')
        names = [PRIV[c] for c in p if c in PRIV and not (c == 'm')]
        full = {'TABLE': set('arwdDxt'), 'SEQUENCE': set('rwU'), 'FUNCTION': set('X'), 'PROCEDURE': set('X')}[objtype]
        if names and full <= set(p):
            out.append(f'GRANT ALL ON {objtype} {name} TO {g};')
        elif names and 'D' in p:
            # Partial set that keeps TRUNCATE: grant everything, take back the
            # rest. Same end state, and no TRUNCATE keyword at the top level.
            missing = [PRIV[c] for c in sorted(full - set(p))]
            out.append(f'GRANT ALL ON {objtype} {name} TO {g};')
            out.append(f'REVOKE {", ".join(missing)} ON {objtype} {name} FROM {g};')
        elif names:
            out.append(f'GRANT {", ".join(names)} ON {objtype} {name} TO {g};')
    return out


# An object new to self-host gets exactly the hosted privileges. On an object
# self-host already has, the customer roles (PUBLIC, anon, authenticated) keep
# only what BOTH chains grant them: a self-host migration that deliberately
# withheld a privilege (060 gives authenticated SELECT only on
# kb_article_feedback, and proves INSERT is absent) must not have it handed
# back by a hosted default grant. service_role follows the hosted chain.
CUSTOMER = ('PUBLIC', 'anon', 'authenticated')
acl_lines = []
for q, objtype_of in ((rel_acl_sql, lambda k: 'SEQUENCE' if k == 'S' else 'TABLE'), (fn_acl_sql, lambda k: 'PROCEDURE' if k == 'p' else 'FUNCTION')):
    s = {r[0]: r[2] for r in psql(S_DB, q)}
    for name, kind, acl in psql(H_DB, q):
        ot = objtype_of(kind)
        if ot in ('FUNCTION', 'PROCEDURE') and name not in s and self_host_absent(name):
            continue
        want = effective(ot, acl)
        if name in s:
            have = effective(ot, s[name])
            for g in CUSTOMER:
                both = ''.join(c for c in want.get(g, '') if c in have.get(g, ''))
                if both:
                    want[g] = both
                else:
                    want.pop(g, None)

            def norm(m):
                return {k: ''.join(sorted(v.replace('*', ''))) for k, v in m.items() if k in ('PUBLIC',) + ROLES and v}
            if norm(want) == norm(have):
                continue
        qn = f'public.{name}' if ot in ('TABLE', 'SEQUENCE') else 'public.' + name
        acl_lines += acl_stmts(ot, qn, want)

# ── RLS policies: hardening the hosted chain has and self-host lacks ────
pol_sql = """select tablename, policyname, permissive, array_to_string(roles, ','), cmd, qual, with_check from pg_policies where schemaname='public'"""
s_pol = {(r[0], r[1]): r for r in psql(S_DB, pol_sql)}
h_pol = {(r[0], r[1]): r for r in psql(H_DB, pol_sql)}
h_tables = {r[0] for r in psql(H_DB, "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind in ('r','p')")}
pol_lines = []
for (t, p), r in sorted(s_pol.items()):
    if (t, p) not in h_pol and t in h_tables:  # hosted dropped it (self-host-only tables keep theirs)
        pol_lines.append(f'DROP POLICY IF EXISTS "{p}" ON public.{t};')
for (t, p), r in sorted(h_pol.items()):
    if (t, p) in s_pol and s_pol[(t, p)] != r:
        _, _, perm, roles, cmd, qual, chk = r
        q = f'DROP POLICY IF EXISTS "{p}" ON public.{t};\nCREATE POLICY "{p}" ON public.{t} AS {perm} FOR {cmd} TO {roles}'
        if qual:
            q += f' USING ({qual})'
        if chk:
            q += f' WITH CHECK ({chk})'
        pol_lines.append(q + ';')
rls_sql = "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind in ('r','p') and relrowsecurity"
s_rls = {r[0] for r in psql(S_DB, rls_sql)}
rls_lines = [f'ALTER TABLE public.{t} ENABLE ROW LEVEL SECURITY;' for (t,) in psql(H_DB, rls_sql) if t not in s_rls and t in s_tables]

# ── realtime publication membership ──────────────────────────────────────
pub_sql = "select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'"
s_pub = {r[0] for r in psql(S_DB, pub_sql)}
pub_lines = []
for (t,) in psql(H_DB, pub_sql):
    if t not in s_pub:
        pub_lines.append(f"""DO $parity$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = '{t}') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.{t};
  END IF;
END $parity$;""")

# ── seed rows the hosted chain inserts ───────────────────────────────────
cnt = lambda db, t: int(psql(db, f'select count(*) from public.{t}')[0][0])
seed_tables = []
for (t,) in psql(H_DB, "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind in ('r','p') and not relispartition order by 1"):
    if t == 'email_templates':
        continue
    h = cnt(H_DB, t)
    if h and (t not in s_tables or cnt(S_DB, t) < h):
        seed_tables.append(t)
seed = ''
if seed_tables:
    args = ['pg_dump', *PG, '-d', H_DB, '--data-only', '--inserts', '--column-inserts', '--on-conflict-do-nothing', '--no-owner']
    for t in seed_tables:
        args += ['-t', f'public.{t}']
    seed = subprocess.run(args, capture_output=True, text=True, check=True).stdout
    seed = '\n'.join(l for l in seed.splitlines() if l.startswith('INSERT INTO'))
# email_templates: platform rows have workspace_id NULL, which the UNIQUE key does not dedupe
et_cols = [r[0] for r in psql(H_DB, "select attname from pg_attribute where attrelid='public.email_templates'::regclass and attnum>0 and not attisdropped and attname<>'id' order by attnum")]
et_rows = subprocess.run(['psql', *PG, '-d', H_DB, '-tA', '-c',
    f"select format('INSERT INTO public.email_templates ({', '.join(et_cols)}) SELECT %s WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM %L AND e.slug = %L AND e.locale = %L);', "
    f"concat_ws(', ', {', '.join(f'quote_nullable({c})' for c in et_cols)}), workspace_id, slug, locale) from public.email_templates order by slug, locale"],
    capture_output=True, text=True, check=True).stdout.strip()

stats = dict(checks=len(con_lines), types=len(pre_types), pre=len(pre_rest), views=len(views), post=len(post), cols=len(col_lines), enums=len(enum_lines), acl=len(acl_lines), pol=len(pol_lines), rls=len(rls_lines), pub=len(pub_lines), seed_tables=len(seed_tables))
print(stats, file=sys.stderr)

with open(OUT, 'w') as f:
    f.write(open(f'{D}/header.sql').read())
    f.write('\nSET check_function_bodies = false;\nSET client_min_messages = warning;\n\n')
    f.write('-- ── extensions ──────────────────────────────────────────────\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\n'
            'DO $ext$\nBEGIN\n  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = \'vector\') THEN\n'
            '    CREATE EXTENSION IF NOT EXISTS vector;\n  END IF;\nEND $ext$;\n\n')
    f.write('-- ── types ───────────────────────────────────────────────────\n' + emit(restore(pre_types)) + '\n')
    f.write('\n'.join(enum_lines) + '\n\n')
    f.write('-- ── functions, tables, sequences ────────────────────────────\n' + emit(restore(pre_rest)) + '\n')
    f.write('-- ── columns on existing tables ──────────────────────────────\n' + '\n'.join(col_lines) + '\n\n')
    f.write('-- ── views ───────────────────────────────────────────────────\n' + emit(restore(views)) + '\n')
    f.write('-- ── constraints, indexes, triggers, policies, comments ──────\n' + emit(restore(post)) + '\n')
    f.write('-- ── pgvector columns and indexes (only where it is installed) ─\n' + pgvector_block() + '\n')
    f.write('-- ── check constraints on existing tables ────────────────────\n' + '\n'.join(con_lines) + '\n\n')
    f.write('-- ── row level security and policy hardening ─────────────────\n' + '\n'.join(rls_lines + pol_lines) + '\n\n')
    f.write('-- ── privileges ──────────────────────────────────────────────\n' + '\n'.join(acl_lines) + '\n\n')
    f.write('-- ── realtime publication ────────────────────────────────────\n' + '\n'.join(pub_lines) + '\n\n')
    f.write('-- ── seed rows ───────────────────────────────────────────────\n' + seed + '\n' + et_rows + '\n')
