<?php

use PHPUnit\Framework\TestCase;
use WebYar\Whmcs\Grants;
use WebYar\Whmcs\Platform;
use WHMCS\Database\Capsule;

final class GrantsTest extends TestCase
{
    protected function setUp(): void
    {
        WhmcsDb::boot();
        WhmcsDb::seed();
        $_SESSION = array();
    }

    private function queries(callable $fn): array
    {
        $db = Capsule::connection();
        $db->flushQueryLog();
        $db->enableQueryLog();
        $fn();
        $log = $db->getQueryLog();
        $db->disableQueryLog();
        return $log;
    }

    public function test_first_page_creates_one_grant_and_later_pages_touch_no_table(): void
    {
        $first = $this->queries(function () use (&$id) {
            $id = Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        });
        $this->assertNotNull($id);
        $this->assertNotNull(Grants::validate($id, '1', '10'));

        // Next page loads inside the refresh window: served from the PHP session.
        Platform::$nowOverride += 60;
        $again = $this->queries(function () use (&$same) {
            $same = Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        });
        $this->assertSame($id, $same);
        $this->assertCount(0, $again, 'a page load inside the refresh window must not query the database');
        $this->assertGreaterThanOrEqual(1, count($first));
    }

    public function test_browsing_refreshes_at_most_once_per_window(): void
    {
        $id = Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        Platform::$nowOverride += Grants::REFRESH_SECONDS + 1;
        $log = $this->queries(function () {
            Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        });
        $updates = array_filter($log, function ($q) {
            return stripos($q['query'], 'update') === 0;
        });
        $this->assertCount(1, $updates);
        $this->assertNotNull(Grants::validate($id, '1', '10'));
    }

    public function test_switching_client_account_ends_the_previous_grant(): void
    {
        $alice = Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        $company = Grants::ensureForSession(1, 30, WhmcsDb::SECRET);
        $this->assertNotSame($alice, $company);
        $this->assertNull(Grants::validate($alice, '1', '10'), 'the old account grant must be revoked on switch');
        $this->assertNotNull(Grants::validate($company, '1', '30'));
    }

    public function test_logout_ends_the_grant_immediately(): void
    {
        $id = Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        Grants::revokeCurrentSession(WhmcsDb::SECRET);
        $this->assertNull(Grants::validate($id, '1', '10'));
        $this->assertArrayNotHasKey(Grants::SESSION_KEY, $_SESSION);
    }

    public function test_session_that_ended_after_bind_is_refused(): void
    {
        $id = Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        // No client-area activity for longer than the idle window: the WHMCS
        // session is gone even though nobody clicked "logout".
        Platform::$nowOverride += Grants::IDLE_SECONDS + 1;
        $this->assertNull(Grants::validate($id, '1', '10'));
    }

    public function test_absolute_lifetime_cannot_be_extended_by_activity(): void
    {
        $id = Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        for ($t = 0; $t < Grants::ABSOLUTE_SECONDS; $t += Grants::REFRESH_SECONDS + 1) {
            Platform::$nowOverride += Grants::REFRESH_SECONDS + 1;
            Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        }
        $this->assertNull(Grants::validate($id, '1', '10'));
    }

    public function test_a_grant_only_matches_its_own_user_and_account(): void
    {
        $id = Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        $this->assertNull(Grants::validate($id, '2', '10'));
        $this->assertNull(Grants::validate($id, '1', '20'));
        $this->assertNull(Grants::validate('not-a-grant', '1', '10'));
        $this->assertNull(Grants::validate(str_repeat('0', 32), '1', '10'));
    }

    public function test_password_change_and_account_closure_end_grants(): void
    {
        $id = Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        Grants::revokeForUser(1);
        $this->assertNull(Grants::validate($id, '1', '10'));

        $_SESSION = array();
        $id2 = Grants::ensureForSession(2, 20, WhmcsDb::SECRET);
        Grants::revokeForClient(20);
        $this->assertNull(Grants::validate($id2, '2', '20'));
    }
}
