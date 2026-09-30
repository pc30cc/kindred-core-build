#!/usr/bin/env bash
# build.sh <db> <selfhost|hosted> [before] : fresh DB with one migration chain
# applied — every file, or only the files whose name sorts before [before]
set -uo pipefail
db=$1; chain=$2; before=${3:-}; R=$(cd "$(dirname "$0")/../../.." && pwd); P="psql -h 127.0.0.1 -p 55432 -U postgres -q"
S=$(cd "$(dirname "$0")" && pwd)
$P -c "drop database if exists $db" -c "create database $db"
$P -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
end \$\$;"
$P -d $db -f $S/auth_stub.sql >/dev/null
$P -d $db -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator noinherit login; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin; end if;
  if not exists (select 1 from pg_roles where rolname='dashboard_user') then create role dashboard_user; end if;
  if not exists (select 1 from pg_roles where rolname='pgbouncer') then create role pgbouncer; end if;
end \$\$;" -c "create schema if not exists storage; create schema if not exists realtime; create schema if not exists graphql_public;" -c "create publication supabase_realtime" 2>/dev/null
if [ $chain = selfhost ]; then files=$(ls $R/database/migrations/*.sql | sort); else files=$(ls $R/supabase/migrations/*.sql | sort); fi
fail=0
for f in $files; do
  if [ -n "$before" ] && [[ ! "$(basename "$f")" < "$before" ]]; then continue; fi
  if ! $P -d $db -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>"$S/.mig.err"; then fail=$((fail+1)); echo "FAIL $(basename $f): $(grep -m1 ERROR "$S/.mig.err")"; fi
done
echo "$db ($chain): failures=$fail"
