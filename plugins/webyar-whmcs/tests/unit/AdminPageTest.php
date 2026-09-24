<?php

use PHPUnit\Framework\TestCase;
use WebYar\Whmcs\Admin\Page;
use WebYar\Whmcs\Platform;
use WebYar\Whmcs\Settings;
use WHMCS\Database\Capsule;

final class AdminPageTest extends TestCase
{
    protected function setUp(): void
    {
        WhmcsDb::boot(); WhmcsDb::seed();
        $_SESSION = array('adminid' => 1);
        $_REQUEST = $_POST = $_GET = array();
        $_SERVER['REQUEST_METHOD'] = 'GET';
    }

    private function render(): string
    {
        ob_start(); Page::render(array('_lang' => array('title' => 'WRONG LANGUAGE'))); return ob_get_clean();
    }

    public function test_language_direction_fonts_icon_and_locked_addresses(): void
    {
        // Match the admin-language table available in the installed WHMCS.
        if (!Capsule::schema()->hasTable('tbladmins')) {
            Capsule::schema()->create('tbladmins', function ($t) { $t->integer('id'); $t->text('language'); });
        }
        // Use a temporary row and restore it, including in dedicated MySQL tests.
        $id = 987654;
        Capsule::table('tbladmins')->insert(array('id' => $id, 'language' => 'farsi'));
        $_SESSION['adminid'] = $id;
        try {
            Platform::$settingsOverride['Language'] = 'english';
            $fa = $this->render();
            $this->assertStringContainsString('dir="rtl"', $fa);
            $this->assertStringContainsString('family=Vazirmatn', $fa);
            $this->assertStringContainsString('assets/icon.png', $fa);
            $this->assertStringContainsString('پایگاه دانش', $fa);
            $this->assertStringNotContainsString('name="api_url"', $fa);
            $this->assertStringNotContainsString('name="webyar_url"', $fa);
            Capsule::table('tbladmins')->where('id', $id)->update(array('language' => 'english'));
            Platform::$settingsOverride['Language'] = 'farsi';
            $en = $this->render();
            $this->assertStringContainsString('dir="ltr"', $en);
            $this->assertStringContainsString('family=Inter', $en);
            $this->assertStringContainsString('Knowledge base', $en);
            $this->assertStringNotContainsString('پایگاه دانش', $en);
            $this->assertStringNotContainsString('WRONG LANGUAGE', $en);
        } finally { Capsule::table('tbladmins')->where('id', $id)->delete(); }
    }

    public function test_forged_post_cannot_change_addresses_and_invalid_csrf_cannot_toggle(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'POST';
        $_REQUEST = array('a' => 'save');
        $_POST = array('token_webyar' => Page::csrfToken(), 'api_url' => 'https://evil.example',
            'webyar_url' => 'https://evil.example', 'section_knowledgebase' => '1');
        $this->render();
        $this->assertSame('https://api.webyar.test', Settings::apiUrl());
        $this->assertSame('https://app.webyar.test', Settings::appUrl());
        $this->assertTrue(Settings::sectionEnabled('knowledgebase'));
        $_POST = array('token_webyar' => 'invalid');
        $this->render();
        $this->assertTrue(Settings::sectionEnabled('knowledgebase'));
    }

    public function test_new_install_uses_published_addresses_without_admin_configuration(): void
    {
        Settings::delete('webyar_url'); Settings::delete('api_url');
        $this->assertSame('https://app.webyar.ai', Settings::appUrl());
        $this->assertSame('https://api.webyar.ai', Settings::apiUrl());
    }
}
