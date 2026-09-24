#!/usr/bin/env bash
# TEST ONLY: upgrade in place through OpenCart's own installer, as a merchant
# would: the store stays connected, the widget event exists exactly once,
# the schema record moves to the new version. Simulates "previous version
# installed" by rewinding the stored connector version first.
#   upgrade_check.sh <4|3> <base> <db> <zip>
set -euo pipefail
MAJOR=$1 BASE=$2 DB=$3 ZIP=$4
M="mariadb --socket=/tmp/wyoc/my.sock -uroot -N $DB -e"
A="python3 oc_admin.py $MAJOR $BASE admin Admin12345!"
$M "UPDATE oc_setting SET value = REPLACE(value, '\"connector\":\"1.0.0\"', '\"connector\":\"0.9.0\"') WHERE \`key\` = 'module_webyar_schema'"
CONN_BEFORE=$($M "SELECT MD5(value) FROM oc_setting WHERE \`key\`='module_webyar_conn' AND store_id=0")
if [ "$MAJOR" = 4 ]; then $A uninstall >/dev/null; fi   # OC4: remove old files (module + settings stay)
$A install "$ZIP" >/dev/null
$A page >/dev/null   # first admin visit runs the idempotent upgrade
$A page >/dev/null   # and a second one must change nothing
EVENTS=$($M "SELECT COUNT(*) FROM oc_event WHERE code='webyar_widget'")
SCHEMA=$($M "SELECT value FROM oc_setting WHERE \`key\`='module_webyar_schema'")
CONN_AFTER=$($M "SELECT MD5(value) FROM oc_setting WHERE \`key\`='module_webyar_conn' AND store_id=0")
TABLE=$($M "SHOW TABLES LIKE 'oc_webyar_nonce'")
ok=1
[ "$EVENTS" = 1 ] || { echo "FAIL events=$EVENTS"; ok=0; }
echo "$SCHEMA" | grep -q '"connector":"1.0.0"' || { echo "FAIL schema not upgraded"; ok=0; }
[ "$CONN_BEFORE" = "$CONN_AFTER" ] || { echo "FAIL connection changed by upgrade"; ok=0; }
[ -n "$TABLE" ] || { echo "FAIL nonce table missing"; ok=0; }
curl -s "$BASE/" | grep -c 's.id="gs-widget-loader"' | grep -qx 1 || { echo "FAIL loader count after upgrade"; ok=0; }
[ $ok = 1 ] && echo "upgrade ok: events=$EVENTS connection kept, schema upgraded"
