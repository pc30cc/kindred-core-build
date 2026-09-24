<?php
use PHPUnit\Framework\TestCase;
use WebYar\Whmcs\Updater;
use WebYar\Whmcs\Settings;
use WebYar\Whmcs\Version;

final class UpdaterTest extends TestCase
{
    private $root;
    private $target;
    private $work;
    protected function setUp(): void
    {
        WhmcsDb::boot(); WhmcsDb::seed();
        $this->root = sys_get_temp_dir() . '/webyar-updater-test-' . bin2hex(random_bytes(6));
        $this->target = $this->root . '/modules/addons/webyar';
        $this->work = $this->root . '/private';
        mkdir($this->target, 0755, true); mkdir($this->work, 0700);
        file_put_contents($this->target . '/original.php', '<?php // old addon');
        Updater::removeTree(Updater::workDir(dirname(__DIR__, 2) . '/modules/addons/webyar'));
    }
    protected function tearDown(): void
    {
        Updater::$downloadOverride = null;
        Updater::removeTree($this->root);
        Updater::removeTree(Updater::workDir(dirname(__DIR__, 2) . '/modules/addons/webyar'));
    }
    private function manifest(): array
    {
        return array('slug' => 'webyar-whmcs', 'version' => '9.0.0', 'sha256' => str_repeat('a', 64),
            'size' => 123, 'requires_php' => '7.2', 'requires_whmcs' => '8.0', 'package' => '/downloads/webyar-whmcs.zip');
    }
    private function archive(array $extra = array()): string
    {
        $file = $this->work . '/release.zip'; $zip = new ZipArchive(); $zip->open($file, ZipArchive::CREATE);
        foreach (array('webyar.php','hooks.php','api.php','lib/bootstrap.php','lib/Updater.php') as $name) {
            $zip->addFromString('modules/addons/webyar/' . $name, '<?php // new');
        }
        $zip->addFromString('modules/addons/webyar/lib/Version.php', "<?php class TestVersion { const ADDON = '9.0.0'; }");
        foreach ($extra as $name => $body) { $zip->addFromString($name, $body); }
        $zip->close(); return $file;
    }
    public function test_install_replaces_only_addon_and_retains_previous_files(): void
    {
        file_put_contents($this->root . '/configuration.php', 'untouched');
        Updater::install($this->archive(), $this->target, $this->work, '9.0.0');
        $this->assertFileExists($this->target . '/lib/Updater.php');
        $this->assertFileDoesNotExist($this->target . '/original.php');
        $this->assertFileExists($this->work . '/previous/original.php');
        $this->assertSame('untouched', file_get_contents($this->root . '/configuration.php'));
        $this->assertNotNull(Settings::credential());
    }
    /** @dataProvider badEntries */
    public function test_unsafe_or_invalid_archives_leave_original_intact($name, $body): void
    {
        $rejected = false;
        try { Updater::install($this->archive(array($name => $body)), $this->target, $this->work, '9.0.0'); }
        catch (Throwable $e) { $rejected = true; }
        $this->assertTrue($rejected, 'accepted unsafe archive');
        $this->assertFileExists($this->target . '/original.php');
    }
    public static function badEntries(): array
    {
        return array(
            array('../escape.php', '<?php'), array('modules/addons/webyar/../../escape.php', '<?php'),
            array('/absolute.php', '<?php'), array('modules/addons/other/file.php', '<?php'),
            array('modules/addons/webyar/lib/broken.php', '<?php syntax!'),
            array('modules/addons/webyar/.htaccess', 'bad'), array('modules/addons/webyar/file.sh', 'bad'),
            array('modules/addons/webyar//file.php', '<?php'),
        );
    }
    public function test_symlink_zip_is_rejected(): void
    {
        $file = $this->archive(array('modules/addons/webyar/link.php' => '/etc/passwd'));
        $zip = new ZipArchive(); $zip->open($file);
        $zip->setExternalAttributesName('modules/addons/webyar/link.php', ZipArchive::OPSYS_UNIX, 0120777 << 16); $zip->close();
        $this->expectExceptionMessage('archive'); Updater::install($file, $this->target, $this->work, '9.0.0');
    }
    public function test_manifest_and_archive_versions_must_match(): void
    {
        $this->expectExceptionMessage('integrity'); Updater::install($this->archive(), $this->target, $this->work, '9.1.0');
    }
    public function test_manifest_rejects_external_url(): void
    {
        $m = $this->manifest(); $m['package'] = 'https://evil.example/update.zip';
        $this->expectExceptionMessage('integrity'); Updater::validateManifest($m, '9.0.1');
    }
    public function test_manifest_rejects_incompatible_whmcs(): void
    {
        $this->expectExceptionMessage('incompatible'); Updater::validateManifest($this->manifest(), '7.10');
    }
    public function test_manifest_rejects_oversized_package(): void
    {
        $m = $this->manifest(); $m['size'] = Updater::MAX_ZIP + 1;
        $this->expectExceptionMessage('integrity'); Updater::validateManifest($m, '9.0.1');
    }
    public function test_http_is_never_allowed(): void
    {
        $this->expectExceptionMessage('failed'); Updater::download('http://localhost/update', 1024);
    }
    public function test_disabled_local_setting_makes_no_requests(): void
    {
        Settings::set('auto_update', '0');
        Updater::$downloadOverride = function () { $this->fail('unexpected request'); };
        Updater::run(); $this->assertTrue(true);
    }
    public function test_platform_pause_stops_download_and_throttles_next_cron(): void
    {
        $calls = 0;
        Updater::$downloadOverride = function ($url) use (&$calls) { $calls++; $this->assertStringEndsWith('/api/plugins/whmcs/updates', $url); return '{"enabled":false}'; };
        Updater::run(); Updater::run();
        $this->assertSame(1, $calls); $this->assertSame('paused', Updater::readStatus()['code']);
    }
    public function test_current_release_does_not_download_zip(): void
    {
        $calls = 0; $m = $this->manifest(); $m['version'] = Version::ADDON;
        Updater::$downloadOverride = function () use (&$calls, $m) { return ++$calls === 1 ? '{"enabled":true}' : json_encode($m); };
        Updater::run(); $this->assertSame(2, $calls); $this->assertSame('current', Updater::readStatus()['code']);
    }
    public function test_bad_checksum_never_installs(): void
    {
        $calls = 0; $m = $this->manifest(); $m['size'] = 3;
        Updater::$downloadOverride = function () use (&$calls, $m) { $calls++; return $calls === 1 ? '{"enabled":true}' : ($calls === 2 ? json_encode($m) : 'bad'); };
        Updater::run(); $this->assertSame('integrity', Updater::readStatus()['code']);
    }
}
