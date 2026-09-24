#!/usr/bin/env bash
# TEST ONLY: upgrade in place by hand, as a merchant would, and check the
# store stays connected, the widget event exists exactly once and the schema
# record moves to the new version. Simulates "previous version installed" by
# rewinding the stored connector version (and, on 4.1, the files) first.
#   3.0: upload through OpenCart's own installer (it overwrites).
#   4.1: OpenCart's installer never overwrites files and will not remove
#        them while the module is installed, so the connection-keeping
#        manual path is copying the package over extension/webyar/ (FTP).
#   upgrade_check.sh <4|3> <base> <db> <zip>
set -euo pipefail
MAJOR=$1 BASE=$2 DB=$3 ZIP=$4
M="mariadb --socket=/tmp/wyoc/my.sock -uroot -N $DB -e"
VERSION=$(sed -n "s/.*CONNECTOR_VERSION = '\([^']*\)'.*/\1/p" ../../core/Protocol.php)
A="python3 oc_admin.py $MAJOR $BASE admin Admin12345!"
$M "UPDATE oc_setting SET value = REPLACE(value, '\"connector\":\"$VERSION\"', '\"connector\":\"0.9.0\"') WHERE \`key\` = 'module_webyar_schema'"
CONN_BEFORE=$($M "SELECT MD5(value) FROM oc_setting WHERE \`key\`='module_webyar_conn' AND store_id=0")
SITE=/tmp/wyoc/sp/sites/$DB
PROTO=$( [ "$MAJOR" = 4 ] && echo "$SITE/extension/webyar/system/library/webyar/Protocol.php" || echo "$SITE/system/library/webyar/Protocol.php" )
sed -i "s/CONNECTOR_VERSION = '[^']*'/CONNECTOR_VERSION = '0.9.0'/" "$PROTO"   # "old files"
sleep 3             # opcache re-reads file dates at most every 2 s (revalidate_freq)
$A page >/dev/null   # the old page is compiled into OpenCart's template cache
MARKER="wy-upgrade-$RANDOM$RANDOM"
if [ "$MAJOR" = 4 ]; then
  # unzip / FTP keep the package's fixed file dates
  python3 copy_over.py extract "$ZIP" "$SITE/extension/webyar" "$MARKER"
else
  python3 copy_over.py mark "$ZIP" "/tmp/wyoc/sp/marked-$DB.ocmod.zip" "$MARKER"
  $A install "/tmp/wyoc/sp/marked-$DB.ocmod.zip" >/dev/null
fi
sleep 3             # opcache re-reads file dates at most every 2 s (revalidate_freq)
PAGE=$($A page)      # first admin visit runs the idempotent upgrade
$A page >/dev/null   # and a second one must change nothing
HTML=$(python3 -c "
import oc_admin; oc_admin.log = lambda *a, **k: None
print(oc_admin.Admin($MAJOR, '$BASE', 'admin', 'Admin12345!').page()[0])")
EVENTS=$($M "SELECT COUNT(*) FROM oc_event WHERE code='webyar_widget'")
SCHEMA=$($M "SELECT value FROM oc_setting WHERE \`key\`='module_webyar_schema'")
CONN_AFTER=$($M "SELECT MD5(value) FROM oc_setting WHERE \`key\`='module_webyar_conn' AND store_id=0")
TABLE=$($M "SHOW TABLES LIKE 'oc_webyar_nonce'")
ok=1
[ "$EVENTS" = 1 ] || { echo "FAIL events=$EVENTS"; ok=0; }
echo "$HTML" | grep -q "$MARKER" || { echo "FAIL the admin still renders the old compiled page"; ok=0; }
grep -q "CONNECTOR_VERSION = '$VERSION'" "$PROTO" || { echo "FAIL files not replaced"; ok=0; }
echo "$SCHEMA" | grep -q "\"connector\":\"$VERSION\"" || { echo "FAIL schema not upgraded"; ok=0; }
[ "$CONN_BEFORE" = "$CONN_AFTER" ] || { echo "FAIL connection changed by upgrade"; ok=0; }
[ -n "$TABLE" ] || { echo "FAIL nonce table missing"; ok=0; }
curl -s "$BASE/" | grep -c 's.id="gs-widget-loader"' | grep -qx 1 || { echo "FAIL loader count after upgrade"; ok=0; }
[ $ok = 1 ] && echo "upgrade ok: files replaced, new page rendered, events=$EVENTS, connection kept, schema upgraded"
