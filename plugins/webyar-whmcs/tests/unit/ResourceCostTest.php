<?php

use PHPUnit\Framework\TestCase;
use WebYar\Whmcs\Grants;
use WebYar\Whmcs\ReplayGuard;
use WebYar\Whmcs\Readers\Currency;
use WebYar\Whmcs\Schema;
use WebYar\Whmcs\Settings;
use WHMCS\Database\Capsule;

/**
 * MEASURED (not estimated): the SQL statements each operation issues through
 * the query builder, for one fresh request. SQLite stands in for MySQL, so
 * this counts statements, not their cost on a real WHMCS database. WHMCS's
 * own bootstrap (init.php) runs queries of its own before the addon; those
 * are NOT included and can only be measured on a real install.
 *
 * The numbers are asserted as ceilings so a change that adds a query per
 * item (N+1) fails here. The table is printed for docs/commerce/WHMCS.md.
 */
final class ResourceCostTest extends TestCase
{
    /** @var array<string,array{select:int,insert:int,update:int,delete:int,bytes:int}> */
    private static $report = array();

    protected function setUp(): void
    {
        WhmcsDb::boot();
        WhmcsDb::seed();
        ReplayGuard::$sweepOneIn = 0;
        $_SESSION = array();
    }

    public static function tearDownAfterClass(): void
    {
        ReplayGuard::$sweepOneIn = 50;
        $lines = array('op | SELECT | INSERT | UPDATE | DELETE | response bytes', '---|---|---|---|---|---');
        foreach (self::$report as $op => $r) {
            $lines[] = sprintf('%s | %d | %d | %d | %d | %d', $op, $r['select'], $r['insert'], $r['update'], $r['delete'], $r['bytes']);
        }
        $driver = WhmcsDb::realDatabase() ? Capsule::connection()->getDriverName() : 'sqlite';
        fwrite(STDERR, "\n\nWHMCS addon — statements per request (measured, " . $driver . ")\n" . implode("\n", $lines) . "\n");
    }

    private function measure($label, callable $fn)
    {
        // A new PHP request starts with empty per-request memos.
        Settings::resetMemo();
        Currency::reset();
        Schema::resetCache();
        $db = Capsule::connection();
        $db->flushQueryLog();
        $db->enableQueryLog();
        $result = $fn();
        $log = $db->getQueryLog();
        $db->disableQueryLog();
        $count = array('select' => 0, 'insert' => 0, 'update' => 0, 'delete' => 0);
        foreach ($log as $q) {
            $verb = strtolower(strtok(ltrim($q['query']), ' '));
            if (isset($count[$verb])) {
                $count[$verb]++;
            }
        }
        $count['bytes'] = is_array($result) ? strlen(json_encode($result[1])) : 0;
        self::$report[$label] = $count;
        return $count;
    }

    public function test_statement_ceilings_per_operation(): void
    {
        $grant = array('id' => Grants::ensureForSession(1, 10, WhmcsDb::SECRET), 'uid' => '1', 'cid' => '10');
        $ceilings = array(
            // op, params, grant, max SELECT, max write
            array('health', array(), null, 4, 1),
            array('catalog.search', array('q' => 'linux'), null, 5, 1),
            array('catalog.browse', array(), null, 5, 1),
            array('session.check', array(), $grant, 4, 1),
            array('services.list', array(), $grant, 6, 1),
            array('services.get', array('id' => 101), $grant, 6, 1),
            array('domains.list', array(), $grant, 6, 1),
            array('invoices.list', array('filter' => 'unpaid'), $grant, 6, 1),
            array('invoices.get', array('id' => 1001), $grant, 7, 1),
            array('orders.list', array(), $grant, 6, 1),
            array('orders.get', array('id' => 501), $grant, 8, 1),
            array('tickets.list', array(), $grant, 6, 1),
            array('tickets.get', array('id' => 71), $grant, 7, 1),
        );
        foreach ($ceilings as $c) {
            list($op, $params, $g, $maxSelect, $maxWrite) = $c;
            $count = $this->measure($op, function () use ($op, $params, $g) {
                return Signing::call($op, $params, $g);
            });
            $this->assertLessThanOrEqual($maxSelect, $count['select'], $op . ' SELECTs');
            $this->assertLessThanOrEqual($maxWrite, $count['insert'] + $count['update'] + $count['delete'], $op . ' writes (the nonce row only)');
        }
    }

    public function test_client_area_page_cost(): void
    {
        \WHMCS\Authentication\CurrentUser::$state = array('user' => null, 'client' => null, 'masquerading' => false);
        $guest = $this->measure('page: guest', function () {
            return array(0, \WebYar\Whmcs\WidgetInjector::render(array()));
        });
        $this->assertSame(0, $guest['insert'] + $guest['update'] + $guest['delete']);

        \WHMCS\Authentication\CurrentUser::$state = array('user' => (object) array('id' => 1, 'email' => 'a@example.com', 'fullName' => 'A'), 'client' => (object) array('id' => 10), 'masquerading' => false);
        $first = $this->measure('page: first logged-in view', function () {
            return array(0, \WebYar\Whmcs\WidgetInjector::render(array()));
        });
        $again = $this->measure('page: next logged-in view', function () {
            return array(0, \WebYar\Whmcs\WidgetInjector::render(array()));
        });
        $this->assertLessThanOrEqual(1, $first['insert']);
        $this->assertSame(0, $again['insert'] + $again['update'] + $again['delete'], 'no write on an ordinary page view');
    }
}
