<?php

use PHPUnit\Framework\TestCase;
use WebYar\Whmcs\Grants;
use WebYar\Whmcs\Settings;

/**
 * Scenario 2/3/4 of the brief: a customer sees only their own account's data;
 * changing an id buys nothing; a restricted WHMCS user stays restricted.
 */
final class AccountAccessTest extends TestCase
{
    /** @var array */
    private $alice;
    /** @var array */
    private $bob;

    protected function setUp(): void
    {
        WhmcsDb::boot();
        WhmcsDb::seed();
        $_SESSION = array();
        $this->alice = array('id' => Grants::ensureForSession(1, 10, WhmcsDb::SECRET), 'uid' => '1', 'cid' => '10');
        $_SESSION = array();
        $this->bob = array('id' => Grants::ensureForSession(2, 20, WhmcsDb::SECRET), 'uid' => '2', 'cid' => '20');
    }

    public function test_no_grant_no_account_data(): void
    {
        foreach (array('services.list', 'domains.list', 'invoices.list', 'orders.list', 'tickets.list', 'session.check') as $op) {
            list($status, $payload) = Signing::call($op, array(), null);
            $this->assertSame(403, $status, $op);
            $this->assertSame('grant_invalid', $payload['error']);
        }
    }

    public function test_services_are_the_callers_own_and_carry_no_secrets(): void
    {
        list($status, $payload) = Signing::call('services.list', array('limit' => 10), $this->alice);
        $this->assertSame(200, $status);
        $ids = array_column($payload['data']['items'], 'id');
        // Live services first, most urgent due date first.
        $this->assertSame(array('102', '101'), $ids);
        $json = json_encode($payload);
        foreach (array('SECRET-PASSWORD', 'alice"', 'internal note', '10.0.0.5', 'bob.example') as $leak) {
            $this->assertStringNotContainsString($leak, $json);
        }
        $this->assertSame('USD', $payload['data']['items'][0]['currency']);
        $this->assertSame('https://billing.example.com/whmcs/clientarea.php?action=productdetails&id=102', $payload['data']['items'][0]['manage_url']);
    }

    public function test_changing_an_id_to_someone_elses_is_just_not_found(): void
    {
        $probes = array(
            array('services.get', array('id' => 201)),
            array('domains.get', array('id' => 61)),
            array('invoices.get', array('id' => 2001)),
            array('orders.get', array('id' => 601)),
            array('tickets.get', array('id' => 81)),
            array('tickets.get', array('tid' => 'XYZ-111111')),
        );
        foreach ($probes as $probe) {
            list($status, $payload) = Signing::call($probe[0], $probe[1], $this->alice);
            $this->assertSame(404, $status, json_encode($probe));
            $this->assertSame('not_found', $payload['error']);
        }
    }

    public function test_the_grant_cannot_be_pointed_at_another_account(): void
    {
        $forged = array('id' => $this->alice['id'], 'uid' => '1', 'cid' => '20');
        list($status, $payload) = Signing::call('services.list', array(), $forged);
        $this->assertSame(403, $status);
        $this->assertSame('grant_invalid', $payload['error']);

        $stolen = array('id' => $this->alice['id'], 'uid' => '2', 'cid' => '10');
        $this->assertSame(403, Signing::call('services.list', array(), $stolen)[0]);
    }

    public function test_a_restricted_user_keeps_their_restriction(): void
    {
        // Bob on the shared company account may see tickets and products only.
        $_SESSION = array();
        $bobOnCompany = array('id' => Grants::ensureForSession(2, 30, WhmcsDb::SECRET), 'uid' => '2', 'cid' => '30');

        list($status, $payload) = Signing::call('session.check', array(), $bobOnCompany);
        $this->assertSame(200, $status);
        $this->assertEqualsCanonicalizing(array('tickets', 'products'), $payload['data']['permissions']);

        $this->assertSame(200, Signing::call('services.list', array(), $bobOnCompany)[0]);
        foreach (array('invoices.list', 'domains.list', 'orders.list') as $op) {
            list($status, $payload) = Signing::call($op, array(), $bobOnCompany);
            $this->assertSame(403, $status, $op);
            $this->assertSame('permission_denied', $payload['error']);
        }
    }

    public function test_permission_removed_in_whmcs_takes_effect_on_the_next_read(): void
    {
        $_SESSION = array();
        $bobOnCompany = array('id' => Grants::ensureForSession(2, 30, WhmcsDb::SECRET), 'uid' => '2', 'cid' => '30');
        $this->assertSame(200, Signing::call('tickets.list', array(), $bobOnCompany)[0]);
        \WHMCS\Database\Capsule::table('tblusers_clients')->where('auth_user_id', 2)->where('client_id', 30)->update(array('permissions' => 'products'));
        $this->assertSame('permission_denied', Signing::call('tickets.list', array(), $bobOnCompany)[1]['error']);
        \WHMCS\Database\Capsule::table('tblusers_clients')->where('auth_user_id', 2)->where('client_id', 30)->delete();
        $this->assertSame(200, Signing::call('session.check', array(), $bobOnCompany)[0]);
        $this->assertSame(array(), Signing::call('session.check', array(), $bobOnCompany)[1]['data']['permissions']);
    }

    public function test_a_closed_account_is_not_readable(): void
    {
        $_SESSION = array();
        $closed = array('id' => Grants::ensureForSession(1, 40, WhmcsDb::SECRET), 'uid' => '1', 'cid' => '40');
        $this->assertSame('grant_invalid', Signing::call('services.list', array(), $closed)[1]['error']);
    }

    public function test_logout_is_honoured_on_the_very_next_read(): void
    {
        $this->assertSame(200, Signing::call('invoices.list', array(), $this->bob)[0]);
        Grants::revokeCurrentSession(WhmcsDb::SECRET); // Bob's session (the last one created)
        $this->assertSame('grant_invalid', Signing::call('invoices.list', array(), $this->bob)[1]['error']);
    }

    public function test_the_admin_can_switch_a_section_off_at_the_source(): void
    {
        Settings::set('section_invoices', '0');
        list($status, $payload) = Signing::call('invoices.list', array(), $this->alice);
        $this->assertSame(403, $status);
        $this->assertSame('feature_disabled', $payload['error']);
    }
}
