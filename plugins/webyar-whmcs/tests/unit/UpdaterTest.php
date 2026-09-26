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
    /** Throwaway release key; the addon is pointed at it via WEBYAR_UPDATE_PUBLIC_KEY. */
    private $signingKey;
    protected function setUp(): void
    {
        WhmcsDb::boot(); WhmcsDb::seed();
        $pair = sodium_crypto_sign_keypair();
        $this->signingKey = sodium_crypto_sign_secretkey($pair);
        putenv('WEBYAR_UPDATE_PUBLIC_KEY=' . base64_encode(sodium_crypto_sign_publickey($pair)));
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
        putenv('WEBYAR_UPDATE_PUBLIC_KEY');
        Updater::removeTree($this->root);
        Updater::removeTree(Updater::workDir(dirname(__DIR__, 2) . '/modules/addons/webyar'));
    }
    public function test_private_update_root_rejects_a_different_filesystem(): void
    {
        if (!is_dir('/dev/shm') || stat('/dev/shm')['dev'] === stat($this->root)['dev']) {
            $this->markTestSkipped('Requires a second filesystem');
        }
        $previous = getenv('WEBYAR_UPDATE_DIR');
        putenv('WEBYAR_UPDATE_DIR=/dev/shm');
        try {
            $this->expectExceptionMessage('filesystem');
            Updater::workDir($this->target);
        } finally {
            putenv($previous === false ? 'WEBYAR_UPDATE_DIR' : 'WEBYAR_UPDATE_DIR=' . $previous);
        }
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
    private function sign($body, $key = null)
    {
        return base64_encode(sodium_crypto_sign_detached($body, $key === null ? $this->signingKey : $key));
    }
    /** Scripted publisher: URL suffix => body (null = HTTP failure); records every URL asked for. */
    private function publish(array $files, array &$asked)
    {
        Updater::$downloadOverride = function ($url) use ($files, &$asked) {
            $asked[] = $url;
            foreach ($files as $suffix => $body) {
                if (substr($url, -strlen($suffix)) === $suffix) {
                    if ($body === null) { throw new RuntimeException('failed'); }
                    return $body;
                }
            }
            throw new RuntimeException('failed');
        };
    }
    private static function zipRequests(array $asked)
    {
        return count(array_filter($asked, function ($url) { return substr($url, -4) === '.zip'; }));
    }
    public function test_current_release_does_not_download_zip(): void
    {
        $m = $this->manifest(); $m['version'] = Version::ADDON; $body = json_encode($m); $asked = array();
        $this->publish(array('/updates' => '{"enabled":true}', '/webyar-whmcs.json' => $body, '/webyar-whmcs.json.sig' => $this->sign($body)), $asked);
        Updater::run();
        $this->assertCount(3, $asked); $this->assertSame('current', Updater::readStatus()['code']);
    }
    public function test_bad_checksum_never_installs(): void
    {
        $m = $this->manifest(); $m['size'] = 3; $body = json_encode($m); $asked = array();
        $this->publish(array('/updates' => '{"enabled":true}', '/webyar-whmcs.json' => $body, '/webyar-whmcs.json.sig' => $this->sign($body), '/webyar-whmcs.zip' => 'bad'), $asked);
        Updater::run(); $this->assertSame('integrity', Updater::readStatus()['code']);
    }
    public function test_unsigned_manifest_never_downloads_the_package(): void
    {
        // A host that serves a manifest but no signature: an old deploy, or
        // someone who controls the host but not the release key.
        $body = json_encode($this->manifest()); $asked = array();
        $this->publish(array('/updates' => '{"enabled":true}', '/webyar-whmcs.json' => $body, '/webyar-whmcs.json.sig' => null, '/webyar-whmcs.zip' => 'zip'), $asked);
        Updater::run();
        $this->assertSame('unsigned', Updater::readStatus()['code']);
        $this->assertSame(0, self::zipRequests($asked));
    }
    public function test_tampered_manifest_never_downloads_the_package(): void
    {
        // The attack this exists to stop: the host swaps in the checksum of
        // its own archive. The signature covers every byte of the manifest.
        $signed = json_encode($this->manifest());
        $m = $this->manifest(); $m['sha256'] = str_repeat('b', 64); $asked = array();
        $this->publish(array('/updates' => '{"enabled":true}', '/webyar-whmcs.json' => json_encode($m), '/webyar-whmcs.json.sig' => $this->sign($signed), '/webyar-whmcs.zip' => 'zip'), $asked);
        Updater::run();
        $this->assertSame('signature', Updater::readStatus()['code']);
        $this->assertSame(0, self::zipRequests($asked));
    }
    public function test_manifest_signed_by_another_key_is_refused(): void
    {
        $body = json_encode($this->manifest()); $asked = array();
        $other = sodium_crypto_sign_secretkey(sodium_crypto_sign_keypair());
        $this->publish(array('/updates' => '{"enabled":true}', '/webyar-whmcs.json' => $body, '/webyar-whmcs.json.sig' => $this->sign($body, $other), '/webyar-whmcs.zip' => 'zip'), $asked);
        Updater::run();
        $this->assertSame('signature', Updater::readStatus()['code']);
        $this->assertSame(0, self::zipRequests($asked));
    }
    public function test_verify_manifest_returns_the_signed_data(): void
    {
        $body = json_encode($this->manifest());
        $data = Updater::verifyManifest($body, $this->sign($body) . "\n", Updater::publicKey());
        $this->assertSame('9.0.0', $data['version']);
    }
    /** @dataProvider badSignatures */
    public function test_verify_manifest_rejects_malformed_signatures($signature, $code): void
    {
        $this->expectExceptionMessage($code);
        Updater::verifyManifest(json_encode($this->manifest()), $signature, Updater::publicKey());
    }
    public static function badSignatures(): array
    {
        return array(
            array('', 'unsigned'), array('not base64!', 'unsigned'), array(base64_encode('short'), 'unsigned'),
            array(base64_encode(str_repeat("\0", 64)), 'signature'),
        );
    }
    public function test_built_in_release_key_is_an_ed25519_public_key(): void
    {
        $this->assertSame(32, strlen((string) base64_decode(Updater::UPDATE_PUBLIC_KEY, true)));
    }
}
