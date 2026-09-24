#!/usr/bin/env bash
# TEST ONLY — reproduces the OpenCart acceptance run from
# docs/commerce/OPENCART.md §11 on ONE machine, loopback only, fictitious data.
#
#   run.sh up     MariaDB (127.0.0.1:33306, 64 MB buffer pool, 30 connections)
#                 + OpenCart 4.1.0.4, 3.0.5.1 and 4.1.0.0 installed by their
#                 own CLI installers, each served for two stores by `php -S`
#                 + a "store" that never answers in time (8099)
#                 + a loopback "Web Yar" release server (8097) with a
#                   throwaway signing key; each store's config.php points
#                   the extension at it (WEBYAR_APP_URL, WEBYAR_API_URL,
#                   WEBYAR_UPDATE_PUBLIC_KEY)
#   run.sh test   (once per fresh `up`) for each version: install the built package through the
#                 real admin, seed, pair (test-only record), then the PHP
#                 scenarios, the TypeScript end-to-end run, SQL measurement,
#                 the admin checks, the settings page clicked in a real
#                 browser (PW_CHROMIUM=<path> if Playwright's own is not
#                 installed), the upgrade check and the self-update check. Results land in $WYOC/sp/*.json.
#   run.sh down   stop every process started by `up` and delete $WYOC.
#
# Nothing listens on anything but 127.0.0.1; nothing here ever talks to a
# real shop or to a Web Yar deployment. Needs: git, php >= 8.1 (mysqli, curl,
# gd, zip, mbstring), mariadb-server, python3 + requests, node with the
# repository's node_modules.
#
# The helper scripts expect the socket at /tmp/wyoc/my.sock, so WYOC is fixed.
set -euo pipefail

WYOC=/tmp/wyoc
SP=$WYOC/sp
SOCK=$WYOC/my.sock
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)

# name major version storefront-port second-store-port
SITES=(
  "oc4 4 4.1.0.4 8041 8042"
  "oc3 3 3.0.5.1 8031 8032"
  "oc40 4 4.1.0.0 8043 8044"
)
SLOW_PORT=8099
RELEASE_PORT=8097
WS=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
INST0=11111111-1111-4111-8111-111111111111
INST1=22222222-2222-4222-8222-222222222222

sql() { mariadb --socket=$SOCK -uroot "$@"; }
serve() { # dir port [extra args...]
  local dir=$1 port=$2; shift 2
  (cd "$dir" || exit 1
   php -S 127.0.0.1:$port -d memory_limit=128M "$@" </dev/null >"$SP/php-$port.log" 2>&1 &
   echo $! >"$SP/php-$port.pid")
}
zip_for() { [ "$1" = 4 ] && echo "$REPO/public/downloads/opencart/4.1/webyar.ocmod.zip" || echo "$REPO/public/downloads/opencart/3.0/webyar-oc3.ocmod.zip"; }
secret() { echo "test-secret-oc$1-store$2-$( [ "$2" = 0 ] && echo aaaaaaaaaaaaaaaaaaaa || echo bbbbbbbbbbbbbbbbbbbb )"; }
pair() { # name major store_id port
  local site=$SP/sites/$1 inst conn
  [ "$3" = 0 ] && { inst=$INST0; conn=cccccccc-cccc-4ccc-8ccc-cccccccccccc; } || { inst=$INST1; conn=dddddddd-dddd-4ddd-8ddd-dddddddddddd; }
  php "$HERE/fake_pair.php" "$1" oc_ "$site/system/storage/" "$3" "$inst" "$(secret "$2" "$3")" $WS $conn "http://127.0.0.1:$4/" http://127.0.0.1:9999 >/dev/null
}
# The extension talks to the loopback release server, never to a real Web Yar.
point_at_loopback() { # name site
  local pk; pk=$(cat "$SP/release-key.pub")
  for cfg in "$2/config.php" "$2/admin/config.php"; do
    grep -q WEBYAR_APP_URL "$cfg" || cat >>"$cfg" <<PHP

// TEST ONLY (run.sh): loopback Web Yar and a throwaway release key.
define('WEBYAR_APP_URL', 'http://127.0.0.1:$RELEASE_PORT/$1');
define('WEBYAR_API_URL', 'http://127.0.0.1:9999');
define('WEBYAR_UPDATE_PUBLIC_KEY', '$pk');
PHP
  done
}
fresh_data() { # name major second-store-port
  (cd "$HERE" && ./seed.sh "$2" "$1" "$SP/sites/$1" "http://127.0.0.1:$3/" >/dev/null)
  rm -f "$SP/sites/$1"/system/storage/cache/cache.*
}

up() {
  mkdir -p "$SP/oc" "$SP/sites" "$SP/slow"
  if [ ! -d "$SP/mysql-data/mysql" ]; then
    mariadb-install-db --user=root --datadir="$SP/mysql-data" --auth-root-authentication-method=normal >"$SP/mysql-init.log" 2>&1
  fi
  mariadbd --user=root --datadir="$SP/mysql-data" --socket=$SOCK --pid-file=$WYOC/my.pid \
    --bind-address=127.0.0.1 --port=33306 --innodb-buffer-pool-size=64M --max-connections=30 \
    --performance-schema=OFF </dev/null >"$SP/mysqld.log" 2>&1 &
  for _ in $(seq 30); do [ -S $SOCK ] && sql -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
  sql -e "CREATE USER IF NOT EXISTS 'oc'@'127.0.0.1' IDENTIFIED BY 'ocpass';"
  if [ ! -f "$SP/release-key" ]; then
    php -r '$k = sodium_crypto_sign_keypair(); file_put_contents($argv[1], base64_encode(sodium_crypto_sign_secretkey($k))); file_put_contents($argv[1] . ".pub", base64_encode(sodium_crypto_sign_publickey($k)));' "$SP/release-key"
  fi
  mkdir -p "$SP/release"

  for s in "${SITES[@]}"; do
    set -- $s; local name=$1 major=$2 ver=$3 p0=$4 p1=$5 site=$SP/sites/$1
    [ -d "$SP/oc/oc-$ver" ] || git -c advice.detachedHead=false clone -q --depth 1 --branch "$ver" https://github.com/opencart/opencart.git "$SP/oc/oc-$ver"
    sql -e "DROP DATABASE IF EXISTS $name; CREATE DATABASE $name CHARACTER SET utf8mb4; GRANT ALL ON $name.* TO 'oc'@'127.0.0.1';"
    rm -rf "$site" && cp -r "$SP/oc/oc-$ver/upload" "$site"
    cp "$site/config-dist.php" "$site/config.php" && cp "$site/admin/config-dist.php" "$site/admin/config.php"
    (cd "$site" && php install/cli_install.php install --username admin --email admin@example.test --password 'Admin12345!' \
      --http_server "http://127.0.0.1:$p0/" --db_driver mysqli --db_hostname 127.0.0.1 --db_username oc --db_password ocpass \
      --db_database "$name" --db_port 33306 --db_prefix oc_ >"$SP/install-$name.log" 2>&1)
    rm -rf "$site/install"
    point_at_loopback "$name" "$site"
    serve "$site" "$p0"; serve "$site" "$p1"
    echo "OpenCart $ver: http://127.0.0.1:$p0/ (store 0), http://127.0.0.1:$p1/ (store 1)"
  done

  cat >"$SP/slow/router.php" <<'PHP'
<?php
// TEST ONLY: a store that accepts the connection and never answers in time.
sleep(20);
header('Content-Type: application/json');
echo '{}';
PHP
  serve "$SP/slow" $SLOW_PORT -t . router.php
  serve "$SP/release" $RELEASE_PORT
}

test_all() {
  (cd "$REPO" && node scripts/build-opencart-plugin-zip.mjs >/dev/null)
  local status=0
  for s in "${SITES[@]}"; do
    set -- $s; local name=$1 major=$2 ver=$3 p0=$4 p1=$5 zip; zip=$(zip_for "$major")
    local A="python3 $HERE/oc_admin.py $major http://127.0.0.1:$p0 admin Admin12345!"
    cd "$HERE"
    $A install "$zip" >/dev/null && $A module-install >/dev/null && $A page >/dev/null

    fresh_data "$name" "$major" "$p1"; pair "$name" "$major" 0 "$p0"; pair "$name" "$major" 1 "$p1"
    python3 scenarios.py "$major" "http://127.0.0.1:$p0/" "http://127.0.0.1:$p1/" "$name" >"$SP/final-scen-$name.json" || status=1
    echo "$ver php scenarios: $(python3 -c "import json;d=json.load(open('$SP/final-scen-$name.json'));print(d['passed'],'/',d['passed']+d['failed'])")"

    fresh_data "$name" "$major" "$p1"
    local r=ok
    (cd "$REPO" && OPENCART_E2E_BASE="http://127.0.0.1:$p0/" OPENCART_E2E_BASE1="http://127.0.0.1:$p1/" OPENCART_E2E_VERSION="$ver" \
      OPENCART_E2E_SECRET0="$(secret "$major" 0)" OPENCART_E2E_SECRET1="$(secret "$major" 1)" \
      OPENCART_E2E_SLOW_BASE="http://127.0.0.1:$SLOW_PORT/" OPENCART_E2E_REPORT="$SP/final-e2e-$name.json" \
      node node_modules/vitest/vitest.mjs run src/test/commerce/opencartLive.e2e.test.ts >"$SP/e2e-$name.log" 2>&1) || { r=FAILED; status=1; }
    echo "$ver ts end-to-end: $r $(grep -E 'Tests ' "$SP/e2e-$name.log" | tr -s ' ') (log: $SP/e2e-$name.log)"

    fresh_data "$name" "$major" "$p1"
    python3 measure_sql.py "$major" "http://127.0.0.1:$p0/" "$name" "$(secret "$major" 0)" >"$SP/sql-$name.json" || status=1
    echo "$ver per-request SQL: $SP/sql-$name.json"

    python3 admin_checks.py "$major" "http://127.0.0.1:$p0" "$name" >"$SP/admin-$name.json" || status=1
    echo "$ver admin checks: $(python3 -c "import json;d=json.load(open('$SP/admin-$name.json'));print(d['passed'],'/',d['passed']+d['failed'],'page view SQL',d['pageview_queries'])")"
    pair "$name" "$major" 1 "$p1"   # admin_checks disconnected store 1

    (cd "$REPO" && node "$HERE/browser_checks.mjs" "$major" "http://127.0.0.1:$p0" "$SP/browser-$name.png" >"$SP/browser-$name.json" 2>&1) || status=1
    echo "$ver browser clicks: $(python3 -c "import json;d=json.load(open('$SP/browser-$name.json'));print(d['passed'],'/',d['passed']+d['failed'])" 2>/dev/null || echo FAILED)"

    echo "$ver upgrade: $(./upgrade_check.sh "$major" "http://127.0.0.1:$p0" "$name" "$zip" 2>&1 | tail -1)"

    python3 update_check.py "$major" "http://127.0.0.1:$p0" "$name" "$SP/sites/$name" "$SP/release/$name" "http://127.0.0.1:$RELEASE_PORT/$name" \
      "$(cat "$SP/release-key")" "$INST0" "$(secret "$major" 0)" >"$SP/update-$name.json" || status=1
    echo "$ver self-update: $(python3 -c "import json;d=json.load(open('$SP/update-$name.json'));print(d['passed'],'/',d['passed']+d['failed'])")"
    # Back to the real package for the next run (4.1: copy over, see upgrade_check.sh).
    if [ "$major" = 4 ]; then python3 -c "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$zip" "$SP/sites/$name/extension/webyar"; else $A install "$zip" >/dev/null; fi
    $A page >/dev/null
  done
  echo "overall: $( [ $status = 0 ] && echo PASS || echo FAIL )"
  return $status
}

down() {
  for f in "$SP"/php-*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
  [ -f $WYOC/my.pid ] && kill "$(cat $WYOC/my.pid)" 2>/dev/null || true
  for _ in $(seq 20); do [ -f $WYOC/my.pid ] || break; sleep 1; done
  rm -rf "$WYOC"
  echo "stopped; $WYOC removed"
}

case "${1:-}" in
  up) up ;;
  test) test_all ;;
  down) down ;;
  *) echo "usage: $0 up|test|down" >&2; exit 2 ;;
esac
