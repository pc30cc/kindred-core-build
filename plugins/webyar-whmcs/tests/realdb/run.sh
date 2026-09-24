#!/bin/sh
# Runs the addon test suite against a real MariaDB/MySQL holding the WHMCS
# schema. See README.md. Needs: php (pdo_mysql), composer deps installed,
# the mariadb/mysql client, and the official WHMCS package's install.sql.
#
#   WHMCS_INSTALL_SQL=/path/to/whmcs/install/sql/install.sql \
#   WEBYAR_TEST_DB_HOST=db WEBYAR_TEST_DB_PASSWORD=... tests/realdb/run.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${WHMCS_INSTALL_SQL:?path to the WHMCS package install/sql/install.sql}"
: "${WEBYAR_TEST_DB_HOST:=127.0.0.1}"
: "${WEBYAR_TEST_DB_USER:=root}"
: "${WEBYAR_TEST_DB_NAME:=webyar_realdb_test}"
: "${WEBYAR_TEST_DB_PASSWORD:=}"
client=$(command -v mariadb || command -v mysql)
db() { "$client" -h "$WEBYAR_TEST_DB_HOST" -u "$WEBYAR_TEST_DB_USER" -p"$WEBYAR_TEST_DB_PASSWORD" "$@"; }

db -e "DROP DATABASE IF EXISTS \`$WEBYAR_TEST_DB_NAME\`; CREATE DATABASE \`$WEBYAR_TEST_DB_NAME\` CHARACTER SET utf8 COLLATE utf8_unicode_ci;"
db --init-command="SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION'" "$WEBYAR_TEST_DB_NAME" < "$WHMCS_INSTALL_SQL"
db --init-command="SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION'" "$WEBYAR_TEST_DB_NAME" < "$here/whmcs-later-additions.sql"
echo "schema: $(db -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$WEBYAR_TEST_DB_NAME'") tables, server $(db -N -e 'SELECT VERSION()')"

export WEBYAR_TEST_DB=mysql WEBYAR_TEST_DB_HOST WEBYAR_TEST_DB_USER WEBYAR_TEST_DB_NAME WEBYAR_TEST_DB_PASSWORD
cd "$here/../.."
exec "${PHPUNIT:-vendor/bin/phpunit}" "$@"
