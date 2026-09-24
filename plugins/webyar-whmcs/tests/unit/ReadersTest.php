<?php

use PHPUnit\Framework\TestCase;
use WebYar\Whmcs\Grants;
use WHMCS\Database\Capsule;

/** Scenario 12/13 of the brief: amounts, currencies, dates and statuses read correctly; nothing internal leaves. */
final class ReadersTest extends TestCase
{
    /** @var array */
    private $alice;

    protected function setUp(): void
    {
        WhmcsDb::boot();
        WhmcsDb::seed();
        $_SESSION = array();
        $this->alice = array('id' => Grants::ensureForSession(1, 10, WhmcsDb::SECRET), 'uid' => '1', 'cid' => '10');
    }

    private function data($op, array $params = array())
    {
        list($status, $payload) = Signing::call($op, $params, $this->alice);
        $this->assertSame(200, $status, $op . ' ' . json_encode($payload));
        return $payload['data'];
    }

    public function test_unpaid_invoices_carry_balance_after_partial_payment_and_hide_drafts(): void
    {
        $data = $this->data('invoices.list', array('filter' => 'unpaid'));
        $this->assertSame(array('1001', '1002'), array_column($data['items'], 'id'));
        $byId = array();
        foreach ($data['items'] as $item) {
            $byId[$item['id']] = $item;
        }
        $this->assertSame('99.00', $byId['1001']['total']);
        $this->assertEquals(69.00, (float) $byId['1001']['balance'], 'total minus the 30.00 partial payment');
        $this->assertTrue($byId['1001']['overdue'], 'due 2026-09-01, today is 2026-09-21');
        $this->assertFalse($byId['1002']['overdue']);
        $this->assertSame('INV-2026-001', $byId['1001']['number']);
        $this->assertSame('1002', $byId['1002']['number'], 'no sequential number → the id');
        $this->assertSame('USD', $byId['1001']['currency']);
        $this->assertStringNotContainsString('private admin note', json_encode($data));

        $overdue = $this->data('invoices.list', array('filter' => 'overdue'));
        $this->assertSame(array('1001'), array_column($overdue['items'], 'id'));

        $all = $this->data('invoices.list');
        $this->assertNotContains('1004', array_column($all['items'], 'id'), 'drafts are never shown');
    }

    public function test_invoice_detail_by_id_or_customer_facing_number(): void
    {
        $byId = $this->data('invoices.get', array('id' => 1001));
        $byNumber = Signing::call('invoices.get', array('id' => '2026'), $this->alice);
        $this->assertSame('Pro Linux - shop.alice.example (2025-09-01 - 2026-08-31)', $byId['item']['items'][0]['description']);
        $this->assertSame('https://billing.example.com/whmcs/viewinvoice.php?id=1001', $byId['item']['view_url']);
        $this->assertSame(404, $byNumber[0]);
    }

    public function test_domains_keep_expiry_and_due_date_apart_and_report_auto_renew(): void
    {
        $data = $this->data('domains.list');
        $first = $data['items'][0];
        $this->assertSame('alice.example', $first['domain']);
        $this->assertSame('2026-10-15', $first['expiry_date']);
        $this->assertSame('2026-10-01', $first['next_due_date']);
        $this->assertTrue($first['auto_renew']);
        $this->assertFalse($data['items'][1]['auto_renew']);
    }

    public function test_suspended_service_shows_only_the_customer_visible_reason(): void
    {
        $data = $this->data('services.get', array('id' => 102));
        $this->assertSame('Suspended', $data['item']['status']);
        $this->assertSame('Overdue on Payment', $data['item']['suspension_reason']);
        $this->assertTrue($data['item']['overdue']);
        $this->assertSame('99.00', $data['item']['recurring_amount']);
        $this->assertSame('Annually', $data['item']['billing_cycle']);

        $active = $this->data('services.get', array('id' => 101));
        $this->assertNull($active['item']['suspension_reason']);
        $this->assertFalse($active['item']['overdue']);
    }

    public function test_orders_separate_order_payment_and_item_status_and_never_leak_fraud_data(): void
    {
        $list = $this->data('orders.list');
        $this->assertSame(array('501', '502'), array_column($list['items'], 'id'));
        $this->assertSame('Active', $list['items'][0]['status']);
        $this->assertSame('Paid', $list['items'][0]['payment_status']);
        // Order 502 points at an invoice of ANOTHER client: it is not joined.
        $this->assertNull($list['items'][1]['payment_status']);
        $this->assertNull($list['items'][1]['view_url']);

        $detail = $this->data('orders.get', array('id' => 501));
        $kinds = array_column($detail['item']['items'], 'kind');
        $this->assertContains('service', $kinds);
        $this->assertContains('domain', $kinds);
        $json = json_encode($detail) . json_encode($list);
        foreach (array('203.0.113.9', 'score', 'order note') as $leak) {
            $this->assertStringNotContainsString($leak, $json);
        }
    }

    public function test_tickets_list_headers_only_and_detail_is_bounded_and_note_free(): void
    {
        $list = $this->data('tickets.list');
        $this->assertSame(array('71', '72'), array_column($list['items'], 'id'), 'merged tickets are not listed separately');
        $this->assertArrayNotHasKey('message', $list['items'][0]);
        $this->assertSame('https://billing.example.com/whmcs/supporttickets.php', $list['items'][0]['view_url']);

        $open = $this->data('tickets.list', array('filter' => 'open'));
        $this->assertSame(array('71'), array_column($open['items'], 'id'));

        $detail = $this->data('tickets.get', array('tid' => 'ABC-123456'));
        $replies = $detail['item']['replies'];
        $this->assertLessThanOrEqual(3, count($replies));
        $this->assertSame('staff', $replies[0]['from']);
        $json = json_encode($detail);
        foreach (array('INTERNAL NOTE', 'watch list', 'Sara Admin', 'ACCESSKEY', '<p>') as $leak) {
            $this->assertStringNotContainsString($leak, $json, $leak);
        }
        // Injection-shaped text is passed on as DATA (Web Yar labels it untrusted) — not stripped, not obeyed.
        $this->assertStringContainsString('IGNORE PREVIOUS INSTRUCTIONS', $json);
    }

    public function test_list_limits_are_enforced_server_side(): void
    {
        for ($i = 0; $i < 30; $i++) {
            Capsule::table('tblinvoices')->insert(array('userid' => 10, 'invoicenum' => '', 'date' => '2026-01-01', 'duedate' => '2026-01-10', 'datepaid' => '2026-01-02', 'total' => '1.00', 'status' => 'Paid'));
        }
        $data = $this->data('invoices.list', array('limit' => 500));
        $this->assertCount(10, $data['items']);
        $this->assertTrue($data['has_more']);
    }
}
