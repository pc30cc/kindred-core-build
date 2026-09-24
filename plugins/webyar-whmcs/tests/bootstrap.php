<?php
/**
 * Test harness for the WHMCS addon — NOT a WHMCS install.
 *
 * `WHMCS\Database\Capsule` is Laravel's Capsule manager in WHMCS; here the
 * same Illuminate query builder runs against an in-memory SQLite database
 * whose tables carry the WHMCS column names the readers use. That exercises
 * the real queries (ownership WHERE clauses, filters, joins, balance SQL)
 * and lets the tests COUNT the queries each operation issues.
 *
 * What this cannot prove: behaviour on a real WHMCS (MySQL dialect details,
 * WHMCS's own models and hooks firing). See docs/commerce/WHMCS.md §Testing.
 */

define('WEBYAR_WHMCS_TESTING', true);
define('WHMCS', true);

$vendor = getenv('WEBYAR_PHP_VENDOR') ?: __DIR__ . '/../vendor';
require_once rtrim($vendor, '/') . '/autoload.php';
require_once __DIR__ . '/../modules/addons/webyar/lib/bootstrap.php';
require_once __DIR__ . '/support/Fakes.php';
require_once __DIR__ . '/support/WhmcsDb.php';
require_once __DIR__ . '/support/Signing.php';

date_default_timezone_set('UTC');
