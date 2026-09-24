<?php

use PHPUnit\Framework\TestCase;
use WebYar\Whmcs\Grants;
use WebYar\Whmcs\Platform;
use WebYar\Whmcs\Readers\Content;
use WebYar\Whmcs\Settings;
use WHMCS\Database\Capsule;

final class ContentTest extends TestCase
{
    protected function setUp(): void
    {
        WhmcsDb::boot();
        WhmcsDb::seed();
        $_SESSION = array();
        foreach (array('announcements', 'knowledgebase', 'networkstatus') as $s) {
            Settings::set('section_' . $s, '1');
        }
    }

    public function test_announcements_exclude_drafts_future_and_unpublished_translations(): void
    {
        foreach (range(1, 9) as $id) {
            Capsule::table('tblannouncements')->insert(array('id' => $id, 'title' => 'News ' . $id,
                'announcement' => '<p>' . str_repeat('x', 3000) . '</p>', 'parentid' => 0, 'language' => '',
                'date' => $id === 9 ? '2099-01-01' : '2026-01-01', 'published' => $id === 8 ? 0 : 1));
        }
        Capsule::table('tblannouncements')->insert(array('id' => 10, 'title' => 'FUTURE SECRET',
            'announcement' => 'future', 'date' => '2099-01-01', 'published' => 1, 'parentid' => 7, 'language' => 'farsi'));
        list($status, $payload) = Signing::call('content.announcements', array('limit' => 999, 'locale' => 'fa'));
        $this->assertSame(200, $status);
        $data = $payload['data'];
        $this->assertCount(5, $data['items']);
        $this->assertTrue($data['has_more']);
        $this->assertSame(array('7', '6', '5', '4', '3'), array_column($data['items'], 'id'));
        $this->assertSame('News 7', $data['items'][0]['title']);
        $this->assertLessThanOrEqual(700, mb_strlen($data['items'][0]['excerpt']));
        $this->assertStringNotContainsString('<p>', $data['items'][0]['excerpt']);
    }

    private function seedKnowledge(): void
    {
        foreach (array(1 => array(0, ''), 2 => array(0, 'on'), 3 => array(2, ''), 4 => array(99, ''), 5 => array(5, '')) as $id => $v) {
            Capsule::table('tblknowledgebasecats')->insert(array('id' => $id, 'parentid' => $v[0], 'hidden' => $v[1], 'catid' => 0, 'name' => 'Category'));
        }
        foreach (range(1, 7) as $id) {
            Capsule::table('tblknowledgebase')->insert(array('id' => $id, 'title' => 'DNS ' . $id, 'article' => '<p>Configure DNS records</p>',
                'private' => $id === 6 ? 'on' : '', 'parentid' => 0, 'language' => '', 'views' => 4));
            Capsule::table('tblknowledgebaselinks')->insert(array('articleid' => $id, 'categoryid' => $id <= 5 ? $id : 1));
        }
        Capsule::table('tblknowledgebaselinks')->insert(array('articleid' => 7, 'categoryid' => 2));
        Capsule::table('tblknowledgebase')->insert(array('id' => 10, 'title' => 'تنظیم دامنه', 'article' => 'راهنمای رکوردها',
            'private' => '', 'parentid' => 1, 'language' => 'farsi', 'views' => 0));
    }

    public function test_kb_filters_private_hidden_ancestors_orphans_cycles_and_mixed_links(): void
    {
        $this->seedKnowledge();
        list($status, $payload) = Signing::call('content.knowledgebase', array('q' => 'DNS'));
        $this->assertSame(200, $status);
        $this->assertSame(array('1'), array_column($payload['data']['items'], 'id'));
        $this->assertSame(4, (int) Capsule::table('tblknowledgebase')->where('id', 1)->value('views'));
    }

    public function test_kb_searches_public_translations_and_reader_never_writes(): void
    {
        $this->seedKnowledge();
        $db = Capsule::connection(); $db->flushQueryLog(); $db->enableQueryLog();
        $data = Content::read('knowledgebase', array('q' => 'دامنه', 'locale' => 'fa'));
        $log = $db->getQueryLog(); $db->disableQueryLog();
        $this->assertSame('تنظیم دامنه', $data['items'][0]['title']);
        $this->assertLessThanOrEqual(3, count($log));
        foreach ($log as $q) { $this->assertSame(0, stripos($q['query'], 'select')); }
        Capsule::table('tblknowledgebase')->where('id', 10)->update(array('private' => 'on'));
        $this->assertSame(array(), Content::read('knowledgebase', array('q' => 'دامنه', 'locale' => 'fa'))['items']);
    }

    public function test_oversized_category_tree_fails_closed_with_explicit_limit(): void
    {
        foreach (range(1, 513) as $id) {
            Capsule::table('tblknowledgebasecats')->insert(array('id' => $id, 'name' => 'Category', 'parentid' => 0, 'hidden' => '', 'catid' => 0));
        }
        $data = Content::read('knowledgebase', array());
        $this->assertTrue($data['limited']);
        $this->assertSame(array(), $data['items']);
    }

    public function test_network_login_setting_and_revocation_are_checked_on_every_call(): void
    {
        foreach (array('Investigating', 'Resolved') as $status) {
            Capsule::table('tblnetworkissues')->insert(array('title' => 'Incident', 'description' => 'Update',
                'status' => $status, 'startdate' => '2026-01-01', 'lastupdate' => '2026-01-02', 'server' => 998));
        }
        Platform::$settingsOverride['NetworkIssuesRequireLogin'] = '';
        list($status, $payload) = Signing::call('content.networkstatus');
        $this->assertSame(200, $status); $this->assertCount(1, $payload['data']['items']);
        $this->assertArrayNotHasKey('server', $payload['data']['items'][0]);
        Platform::$settingsOverride['NetworkIssuesRequireLogin'] = 'on';
        $this->assertSame(403, Signing::call('content.networkstatus')[0]);
        $id = Grants::ensureForSession(1, 10, WhmcsDb::SECRET);
        $grant = array('id' => $id, 'uid' => '1', 'cid' => '10');
        $this->assertSame(200, Signing::call('content.networkstatus', array(), $grant)[0]);
        Grants::revokeAll();
        $this->assertSame(403, Signing::call('content.networkstatus', array(), $grant)[0]);
    }

    public function test_source_switches_block_each_reader(): void
    {
        foreach (array('announcements', 'knowledgebase', 'networkstatus') as $s) {
            Settings::set('section_' . $s, '0');
            list($status, $payload) = Signing::call('content.' . $s);
            $this->assertSame(403, $status); $this->assertSame('feature_disabled', $payload['error']);
        }
    }
}
