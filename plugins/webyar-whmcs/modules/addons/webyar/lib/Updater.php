<?php
namespace WebYar\Whmcs;

/** Hourly CLI cron updates. HTTPS publisher is the trust root; no remote URLs
 * from manifests, shell commands, customer requests, or database request logs. */
final class Updater
{
    const INTERVAL = 3600;
    const MAX_ZIP = 8388608;
    const MAX_EXPANDED = 33554432;
    public static $downloadOverride = null;

    public static function run()
    {
        if (PHP_SAPI !== 'cli' || !Settings::credential() || !Settings::flag('auto_update', true)) {
            return;
        }
        $target = dirname(__DIR__);
        $work = self::workDir($target);
        $lock = fopen($work . '/lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
            if ($lock) { fclose($lock); }
            return;
        }
        try {
            // Filesystem state, outside the web root. No per-request DB log.
            $last = is_file($work . '/checked') ? (int) file_get_contents($work . '/checked') : 0;
            if (time() - $last < self::INTERVAL) { return; }
            file_put_contents($work . '/checked', (string) time());
            $policy = json_decode(self::download(Settings::apiUrl() . '/api/plugins/whmcs/updates', 4096), true);
            if (!is_array($policy) || !isset($policy['enabled']) || $policy['enabled'] !== true) {
                self::status($work, 'paused'); return;
            }
            $manifest = json_decode(self::download(Settings::appUrl() . '/downloads/webyar-whmcs.json', 16384), true);
            self::validateManifest($manifest, Platform::whmcsVersion());
            if (!version_compare($manifest['version'], Version::ADDON, '>')) {
                self::status($work, 'current'); return;
            }
            $bytes = self::download(Settings::appUrl() . '/downloads/webyar-whmcs.zip', self::MAX_ZIP);
            if (strlen($bytes) !== $manifest['size'] || !hash_equals($manifest['sha256'], hash('sha256', $bytes))) {
                throw new \RuntimeException('integrity');
            }
            $zip = $work . '/package.zip';
            if (file_put_contents($zip, $bytes) !== strlen($bytes)) { throw new \RuntimeException('filesystem'); }
            self::install($zip, $target, $work, $manifest['version']);
            self::status($work, 'updated');
        } catch (\Throwable $e) {
            $code = in_array($e->getMessage(), array('integrity', 'incompatible', 'filesystem', 'archive'), true) ? $e->getMessage() : 'failed';
            self::status($work, $code);
        } finally {
            self::removeTree($work . '/stage');
            @unlink($work . '/package.zip');
            flock($lock, LOCK_UN); fclose($lock);
        }
    }

    public static function validateManifest($data, $whmcsVersion)
    {
        if (!is_array($data) || ($data['slug'] ?? '') !== 'webyar-whmcs'
            || !is_string($data['version'] ?? null) || !preg_match('/^\d+\.\d+\.\d+$/D', $data['version'])
            || !is_string($data['sha256'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $data['sha256'])
            || !is_int($data['size'] ?? null) || $data['size'] <= 0 || $data['size'] > self::MAX_ZIP
            || ($data['package'] ?? '') !== '/downloads/webyar-whmcs.zip') {
            throw new \RuntimeException('integrity');
        }
        foreach (array('requires_php', 'requires_whmcs') as $key) {
            if (!is_string($data[$key] ?? null) || !preg_match('/^\d+\.\d+(\.\d+)?$/D', $data[$key])) {
                throw new \RuntimeException('integrity');
            }
        }
        if ($whmcsVersion === '' || version_compare(PHP_VERSION, $data['requires_php'], '<')
            || version_compare($whmcsVersion, $data['requires_whmcs'], '<') || !class_exists('ZipArchive')) {
            throw new \RuntimeException('incompatible');
        }
    }

    /** Bounded HTTPS response, no redirects or insecure fallback. */
    public static function download($url, $limit)
    {
        $parts = parse_url($url);
        if (!$parts || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])) {
            throw new \RuntimeException('failed');
        }
        if (self::$downloadOverride !== null) { return call_user_func(self::$downloadOverride, $url, $limit); }
        $body = '';
        $curl = curl_init($url);
        curl_setopt_array($curl, array(
            CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 45,
            CURLOPT_HTTPHEADER => array('Cache-Control: no-cache'),
            CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$body, $limit) {
                if (strlen($body) + strlen($chunk) > $limit) { return 0; }
                $body .= $chunk; return strlen($chunk);
            },
        ));
        $ok = curl_exec($curl); $status = curl_getinfo($curl, CURLINFO_HTTP_CODE); curl_close($curl);
        if ($ok === false || $status !== 200) { throw new \RuntimeException('failed'); }
        return $body;
    }

    /** Private state and retained previous version; refuse web-accessible temp roots. */
    public static function workDir($target)
    {
        $configured = getenv('WEBYAR_UPDATE_DIR');
        $root = realpath($configured !== false && $configured !== '' ? $configured : sys_get_temp_dir());
        $web = realpath(dirname($target, 3));
        if (!$root || ($web && ($root === $web || strpos($root . '/', $web . '/') === 0))) {
            throw new \RuntimeException('filesystem');
        }
        $dir = $root . '/webyar-update-' . substr(hash('sha256', $target), 0, 24);
        if (is_link($dir) || (!is_dir($dir) && !mkdir($dir, 0700))) { throw new \RuntimeException('filesystem'); }
        if (function_exists('posix_geteuid') && fileowner($dir) !== posix_geteuid()) { throw new \RuntimeException('filesystem'); }
        if (!chmod($dir, 0700)) { throw new \RuntimeException('filesystem'); }
        return $dir;
    }

    private static function status($work, $code)
    {
        file_put_contents($work . '/status.json', json_encode(array('code' => $code, 'at' => time())));
    }

    public static function readStatus()
    {
        try {
            $file = self::workDir(dirname(__DIR__)) . '/status.json';
            $data = is_file($file) ? json_decode(file_get_contents($file), true) : null;
            return is_array($data) ? $data : array('code' => 'waiting');
        } catch (\Throwable $e) { return array('code' => 'filesystem'); }
    }

    /** Extract only our addon; no extractTo(), links, traversal or arbitrary paths.
     * Caller holds the per-installation lock. Same-device rename is required. */
    public static function install($archive, $target, $work, $version)
    {
        if (is_link($target) || !is_dir($target) || !is_writable(dirname($target))
            || stat(dirname($target))['dev'] !== stat($work)['dev']) { throw new \RuntimeException('filesystem'); }
        $stage = $work . '/stage'; $backup = $work . '/previous';
        self::removeTree($stage);
        if (!mkdir($stage, 0755)) { throw new \RuntimeException('filesystem'); }
        $zip = new \ZipArchive();
        if ($zip->open($archive) !== true) { throw new \RuntimeException('archive'); }
        try {
            if ($zip->numFiles > 512) { throw new \RuntimeException('archive'); }
            $size = 0; $seen = array();
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $entry = $zip->statIndex($i); $name = $entry['name'];
                $opsys = 0; $attributes = 0;
                $zip->getExternalAttributesIndex($i, $opsys, $attributes);
                $kind = ($attributes >> 16) & 0170000;
                if ($kind !== 0 && $kind !== 0100000 && $kind !== 0040000) { throw new \RuntimeException('archive'); }
                if (isset($seen[$name]) || strpos($name, '..') !== false || strpos($name, '\\') !== false
                    || !preg_match('#^[a-zA-Z0-9_./-]+$#D', $name)) { throw new \RuntimeException('archive'); }
                $seen[$name] = true;
                $size += $entry['size'];
                if ($size > self::MAX_EXPANDED) { throw new \RuntimeException('archive'); }
                if (in_array($name, array('INSTALL.txt', 'modules/', 'modules/addons/', 'modules/addons/webyar/'), true)) { continue; }
                $prefix = 'modules/addons/webyar/';
                if (strpos($name, $prefix) !== 0) { throw new \RuntimeException('archive'); }
                $relative = substr($name, strlen($prefix));
                if ($relative === '' || $relative[0] === '/' || strpos($relative, '//') !== false) { throw new \RuntimeException('archive'); }
                $path = $stage . '/' . $relative;
                if (substr($name, -1) === '/') {
                    if (!is_dir($path) && !mkdir($path, 0755, true)) { throw new \RuntimeException('filesystem'); }
                    continue;
                }
                if (!preg_match('/\.(php|json|png|svg|css|js|txt)$/D', $relative)) { throw new \RuntimeException('archive'); }
                if (!is_dir(dirname($path)) && !mkdir(dirname($path), 0755, true)) { throw new \RuntimeException('filesystem'); }
                $content = $zip->getFromIndex($i);
                if ($content === false || strlen($content) !== $entry['size'] || file_put_contents($path, $content) !== strlen($content)) {
                    throw new \RuntimeException('archive');
                }
                chmod($path, 0644);
                if (substr($path, -4) === '.php') {
                    // Token parsing catches syntax errors using the actual cron PHP.
                    token_get_all($content, TOKEN_PARSE);
                }
            }
            foreach (array('webyar.php', 'hooks.php', 'api.php', 'lib/bootstrap.php', 'lib/Updater.php', 'lib/Version.php') as $required) {
                if (!is_file($stage . '/' . $required)) { throw new \RuntimeException('archive'); }
            }
            $source = file_get_contents($stage . '/lib/Version.php');
            if (!preg_match("/const ADDON = '([0-9.]+)';/", $source, $match) || $match[1] !== $version) { throw new \RuntimeException('integrity'); }
        } finally { $zip->close(); }
        self::removeTree($backup);
        if (!rename($target, $backup)) { throw new \RuntimeException('filesystem'); }
        // Restore even on a PHP shutdown between the two directory renames.
        register_shutdown_function(function () use ($target, $backup) {
            if (!file_exists($target) && is_dir($backup)) { @rename($backup, $target); }
        });
        if (!@rename($stage, $target)) {
            @rename($backup, $target); throw new \RuntimeException('filesystem');
        }
        if (function_exists('opcache_reset')) { @opcache_reset(); }
        clearstatcache(true);
    }

    public static function removeTree($path)
    {
        if (is_link($path) || is_file($path)) { unlink($path); return; }
        if (!is_dir($path)) { return; }
        foreach (scandir($path) as $name) {
            if ($name !== '.' && $name !== '..') { self::removeTree($path . '/' . $name); }
        }
        rmdir($path);
    }
}
