<?php

use PHPUnit\Framework\TestCase;
use WebYar\Whmcs\Settings;
use WebYar\Whmcs\WidgetInjector;
use WHMCS\Authentication\CurrentUser;

final class WidgetInjectorTest extends TestCase
{
    protected function setUp(): void
    {
        WhmcsDb::boot();
        WhmcsDb::seed();
        $_SESSION = array();
        CurrentUser::$state = array('user' => null, 'client' => null, 'masquerading' => false);
    }

    private function attr($html, $name)
    {
        if (!preg_match('/s\.setAttribute\("' . preg_quote($name, '/') . '", "([^"]*)"\)/', $html, $m)) {
            return null;
        }
        return json_decode('"' . $m[1] . '"');
    }

    public function test_guest_gets_the_widget_without_any_identity(): void
    {
        $html = WidgetInjector::render(array());
        $this->assertStringContainsString('https://app.webyar.test/widget/loader.js', $html);
        $this->assertSame(WhmcsDb::WORKSPACE, $this->attr($html, 'data-workspace-id'));
        $this->assertSame('anon', $this->attr($html, 'data-commerce-subject'));
        $this->assertNull($this->attr($html, 'data-commerce-assertion'));
        $this->assertStringContainsString('window.__gs_loader_injected', $html, 'never injected twice');
    }

    public function test_logged_in_user_gets_a_signed_short_lived_assertion(): void
    {
        CurrentUser::$state['user'] = (object) array('id' => 1, 'email' => 'alice@example.com', 'fullName' => 'Alice <b>Example</b>');
        CurrentUser::$state['client'] = (object) array('id' => 10);
        $html = WidgetInjector::render(array());
        $assertion = $this->attr($html, 'data-commerce-assertion');
        $this->assertNotNull($assertion);
        list($prefix, $body, $sig) = explode('.', $assertion);
        $this->assertSame('whmcs1', $prefix);
        $this->assertSame(hash_hmac('sha256', 'whmcs1.' . $body, WhmcsDb::SECRET), $sig);
        $payload = json_decode(base64_decode(strtr($body, '-_', '+/')), true);
        $this->assertSame('1', $payload['uid']);
        $this->assertSame('10', $payload['cid']);
        $this->assertSame(300, $payload['exp'] - $payload['iat']);
        $this->assertSame('alice@example.com', $payload['email']);
        $this->assertSame('Alice Example', $payload['name'], 'markup stripped from the name');
        $this->assertSame('u' . $payload['sub'], $this->attr($html, 'data-commerce-subject'));
        $this->assertNotEmpty($this->attr($html, 'data-commerce-binding'));
        $this->assertStringNotContainsString(WhmcsDb::SECRET, $html);
    }

    public function test_contact_details_can_be_withheld(): void
    {
        Settings::set('share_contact', '0');
        CurrentUser::$state['user'] = (object) array('id' => 1, 'email' => 'alice@example.com', 'fullName' => 'Alice');
        CurrentUser::$state['client'] = (object) array('id' => 10);
        $assertion = $this->attr(WidgetInjector::render(array()), 'data-commerce-assertion');
        $payload = json_decode(base64_decode(strtr(explode('.', $assertion)[1], '-_', '+/')), true);
        $this->assertArrayNotHasKey('email', $payload);
        $this->assertArrayNotHasKey('name', $payload);
    }

    public function test_an_admin_logged_in_as_the_client_is_not_introduced_as_them(): void
    {
        CurrentUser::$state = array('user' => (object) array('id' => 1, 'email' => 'a@b.c', 'fullName' => 'A'), 'client' => (object) array('id' => 10), 'masquerading' => true);
        $this->assertNull($this->attr(WidgetInjector::render(array()), 'data-commerce-assertion'));
    }

    public function test_disabled_or_unconnected_renders_nothing(): void
    {
        Settings::set('auto_widget', '0');
        $this->assertSame('', WidgetInjector::render(array()));
        Settings::set('auto_widget', '1');
        Settings::delete('credential');
        $this->assertSame('', WidgetInjector::render(array()));
    }

    public function test_attribute_values_cannot_break_out_of_the_script(): void
    {
        $html = WidgetInjector::script('https://x/loader.js', 'ws"</script><script>alert(1)</script>', 'https://api', array('data-x' => "</script>'\""));
        $this->assertStringNotContainsString('</script><script>', $html);
        $this->assertSame(1, substr_count($html, '</script>'));
    }
}
