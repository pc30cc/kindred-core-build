<?php

use PHPUnit\Framework\TestCase;

/** Scenario 1 of the brief: a guest gets public plans only — never hidden, retired or group-restricted ones. */
final class CatalogTest extends TestCase
{
    protected function setUp(): void
    {
        WhmcsDb::boot();
        WhmcsDb::seed();
    }

    public function test_browse_lists_visible_products_only(): void
    {
        list($status, $payload) = Signing::call('catalog.browse', array('limit' => 10));
        $this->assertSame(200, $status);
        $names = array_column($payload['data']['items'], 'name');
        $this->assertSame(array('Starter Linux', 'Pro Linux', 'VPS Setup Service', 'Free Trial VPS'), $names);
        foreach (array('Secret Reseller Linux', 'Staff Linux', 'Old Linux') as $hidden) {
            $this->assertNotContains($hidden, $names);
        }
    }

    public function test_search_matches_words_and_prices_come_from_getproducts(): void
    {
        list(, $payload) = Signing::call('catalog.search', array('q' => 'قیمت هاست Linux starter چنده؟'));
        $items = $payload['data']['items'];
        $this->assertSame('Starter Linux', $items[0]['name'], 'two matching words rank above one');
        $this->assertSame('USD', $items[0]['currency']);
        $this->assertSame(array(
            array('cycle' => 'monthly', 'price' => '4.99', 'setup_fee' => null),
            array('cycle' => 'annually', 'price' => '49.90', 'setup_fee' => '5.00'),
        ), $items[0]['prices'], 'cycles priced -1.00 are not offered and are dropped');
        $this->assertTrue($items[0]['taxable']);
        $this->assertSame('exclusive', $payload['data']['tax_mode']);
        $this->assertSame('https://billing.example.com/whmcs/store/linux/starter', $items[0]['order_url']);
        $this->assertSame('1 site, 10 GB SSD', $items[0]['description'], 'markup stripped');
        $this->assertNotContains('Secret Reseller Linux', array_column($items, 'name'));
    }

    public function test_one_time_and_free_products(): void
    {
        list(, $payload) = Signing::call('catalog.search', array('q' => 'VPS'));
        $byName = array();
        foreach ($payload['data']['items'] as $item) {
            $byName[$item['name']] = $item;
        }
        $this->assertSame(array(array('cycle' => 'onetime', 'price' => '120.00', 'setup_fee' => '10.00')), $byName['VPS Setup Service']['prices']);
        $this->assertSame('free', $byName['Free Trial VPS']['prices'][0]['cycle']);
        $this->assertSame('https://billing.example.com/whmcs/cart.php?a=add&pid=5', $byName['VPS Setup Service']['order_url']);
    }

    public function test_like_wildcards_in_the_question_are_literal(): void
    {
        list(, $payload) = Signing::call('catalog.search', array('q' => '%% __'));
        $this->assertLessThanOrEqual(10, count($payload['data']['items']));
        list(, $payload) = Signing::call('catalog.search', array('q' => 'zz%zz'));
        $this->assertSame(array(), $payload['data']['items']);
    }
}
