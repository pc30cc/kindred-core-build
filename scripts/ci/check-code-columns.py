#!/usr/bin/env python3
"""
Every table, column and function the server code names in a query must exist
in the schema the migrations build.

    DATABASE_URL=postgresql://… python3 scripts/ci/check-code-columns.py

Reads the catalog of DATABASE_URL (a database built by
scripts/migrate-database.sh) and scans server/, worker/, channels/,
ai-runtime/ and shared/ for supabase-js chains:

  .from('t')            t must be a table or view in public
  .select('a, b:c, …')  each plain column must exist on t (embedded
                        resources `rel(…)` and JSON paths are left alone)
  .eq('col', …), .in(…), .order(…), …
                        the filtered or ordered column must exist on t
  .rpc('fn', …)         fn must be a function in public

A column the database does not have does not fail loudly in production: the
whole read errors (42703), and code that treats the error as "no row" quietly
runs on defaults. This check found five such reads (conversations.channel,
ai_usage_events.model, platform_settings.ai_topup_*, workspaces.timezone,
call_sessions.contact_id) and ai_runs.billing_cycle_id.

Only literal names are checked; a name built at run time is skipped.
"""
import os
import re
import subprocess
import sys

ROOTS = ['server', 'worker', 'channels', 'ai-runtime', 'shared']
FILTERS = {'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
           'containedBy', 'order', 'not', 'filter', 'overlaps', 'textSearch', 'match'}


def catalog(url):
    def q(sql):
        out = subprocess.run(['psql', url, '-qAtX', '-v', 'ON_ERROR_STOP=1', '-c', sql],
                             check=True, capture_output=True, text=True,
                             env={**os.environ, 'PGOPTIONS': '-c default_transaction_read_only=on'}).stdout
        return set(out.split())
    cols = q("SELECT c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid "
             "WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','v','m','p') "
             "AND a.attnum > 0 AND NOT a.attisdropped")
    tables = q("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','v','m','p')")
    functions = q("SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace")
    return cols, tables, functions


def args_end(src, i):
    """Index just past the ')' closing the call whose arguments start at i."""
    depth, j, quote = 1, i, None
    while j < len(src) and depth:
        ch = src[j]
        if quote:
            if ch == '\\':
                j += 2
                continue
            if ch == quote:
                quote = None
        elif ch in '\'"`':
            quote = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        j += 1
    return j


def split_top(s):
    out, depth, cur = [], 0, ''
    for ch in s:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            out.append(cur)
            cur = ''
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return [x.strip() for x in out]


def literal(arg):
    m = re.match(r"""\s*(['"`])((?:(?!\1).)*)\1\s*(?:,|$)""", arg, re.S)
    if not m or (m.group(1) == '`' and '${' in m.group(2)):
        return None
    return m.group(2)


def main():
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit('DATABASE_URL is required')
    cols, tables, functions = catalog(url)
    start = re.compile(r"""\.from\(\s*['"]([a-z_0-9]+)['"]\s*\)""")
    rpc = re.compile(r"""\.rpc\(\s*['"]([a-z_0-9]+)['"]""")
    method = re.compile(r"""\s*\.([a-zA-Z]+)\(""")
    problems = set()
    for root in ROOTS:
        for dirpath, _, names in os.walk(root):
            if 'node_modules' in dirpath:
                continue
            for name in names:
                if not name.endswith('.ts') or name.endswith('.test.ts'):
                    continue
                path = os.path.join(dirpath, name)
                src = open(path, encoding='utf-8', errors='ignore').read()
                line = lambda pos: src.count('\n', 0, pos) + 1
                for m in rpc.finditer(src):
                    if m.group(1) not in functions:
                        problems.add(f'{path}:{line(m.start())}  rpc {m.group(1)}() does not exist')
                for m in start.finditer(src):
                    table = m.group(1)
                    if table not in tables:
                        problems.add(f'{path}:{line(m.start())}  table {table} does not exist')
                        continue
                    i = m.end()
                    while True:
                        mm = method.match(src, i)
                        if not mm:
                            break
                        meth, a = mm.group(1), mm.end()
                        e = args_end(src, a)
                        arg = src[a:e - 1]
                        i = e
                        if meth == 'select':
                            sel = literal(arg)
                            if sel is None:
                                continue
                            for part in split_top(sel.replace('\n', ' ')):
                                if not part or part == '*' or '(' in part:
                                    continue
                                c = part.split(':')[-1] if (':' in part and '::' not in part) else part
                                c = re.split(r'->>?', c.split('::')[0])[0].strip()
                                if c in ('*', 'count') or not re.match(r'^[a-z_][a-z_0-9]*$', c):
                                    continue
                                if f'{table}.{c}' not in cols:
                                    problems.add(f'{path}:{line(m.start())}  {table}.{c} does not exist (select)')
                        elif meth in FILTERS:
                            am = re.match(r"""\s*['"]([a-z_][a-z_0-9]*)(?:->>?[^'"]*)?['"]""", arg)
                            if am and f'{table}.{am.group(1)}' not in cols:
                                problems.add(f'{path}:{line(m.start())}  {table}.{am.group(1)} does not exist (.{meth})')
    for p in sorted(problems):
        print(p)
    print(f'check-code-columns: {len(problems)} name(s) the schema does not have', file=sys.stderr)
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
