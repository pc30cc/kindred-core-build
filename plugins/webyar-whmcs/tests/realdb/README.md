# Addon tests against a real MariaDB/MySQL

The default suite runs on in-memory SQLite. This mode runs the same 55 tests
against a real MariaDB/MySQL database that holds the WHMCS schema, so every
seed row and every addon query meets WHMCS's real column types, defaults,
collation and SQL dialect.

It is **not** a WHMCS installation: no WHMCS code runs and no licence is used.

## Schema

- **Base schema:** `install/sql/install.sql` from the official WHMCS package
  (download it from WHMCS; it is not committed here).
- **Later additions:** [`whmcs-later-additions.sql`](whmcs-later-additions.sql).
  WHMCS creates `tblcurrencies`, `tblusers` and `tblusers_clients`, and some
  newer columns, through encoded upgrade scripts that only run in a licensed
  install. This file reconstructs the ones the addon reads, from the WHMCS
  developer documentation. The public-content fields were also checked against an isolated WHMCS 9.0.1 installation.

## Run

```
cd plugins/webyar-whmcs
composer install
WHMCS_INSTALL_SQL=/path/to/whmcs/install/sql/install.sql \
WEBYAR_TEST_DB_HOST=127.0.0.1 WEBYAR_TEST_DB_USER=root WEBYAR_TEST_DB_PASSWORD=... \
tests/realdb/run.sh
```

`run.sh` recreates the database `webyar_realdb_test` (override with
`WEBYAR_TEST_DB_NAME`) and loads both files in non-strict SQL mode, as WHMCS
runs. It then runs PHPUnit with `WEBYAR_TEST_DB=mysql`. Between tests the
harness empties the seeded WHMCS tables and drops the addon's `mod_webyar_*`
tables; it never creates WHMCS tables itself.

For release 1.1.0 the suite also passed on a dedicated empty database made
from the installed WHMCS 9.0.1 schema (55 tests, 322 assertions). Use a
separate test database: this harness truncates seeded tables between tests.
