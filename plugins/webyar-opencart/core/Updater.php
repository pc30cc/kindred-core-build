<?php
namespace WebYar\OpenCart;

/**
 * Self-update, for a connected store whose owner left "update automatically"
 * on (the default). Triggered by Web Yar (a signed `connector/update` call,
 * sent when Web Yar sees an older version answering) or by the owner opening
 * the settings page. There is no cron and no polling.
 *
 * Nothing is installed unless ALL of this holds:
 *   - the manifest comes from the fixed Web Yar address (Endpoints), over
 *     https, and its Ed25519 signature verifies against the public key built
 *     into this extension (the private key never leaves the release host);
 *   - it is strictly newer, same protocol major, and has a package for this
 *     OpenCart line;
 *   - the downloaded package matches the signed sha256 byte for byte;
 *   - every entry is a plain file under this extension's own folders, with an
 *     allowed extension, within size limits (no "..", no absolute paths, no
 *     links — files are written one by one, never with extractTo).
 *
 * Files are staged first; the originals are backed up and restored if any
 * write fails. One update at a time (a database lock).
 */
final class Updater {
	private const MANIFEST_PATH = '/downloads/opencart/manifest.json';
	private const MAX_MANIFEST_BYTES = 16384;
	private const MAX_PACKAGE_BYTES = 3145728;
	private const MAX_UNPACKED_BYTES = 6291456;
	private const MAX_ENTRIES = 400;
	private const ALLOWED_EXT = ['php', 'twig', 'json', 'html', 'txt', 'css', 'js', 'svg', 'png'];
	/** A check that found nothing new is not repeated sooner than this unless forced. */
	private const RECHECK_SECONDS = 600;

	private Db $db;
	private Settings $settings;
	private Platform $platform;
	private string $currentVersion;

	public function __construct(Db $db, Settings $settings, Platform $platform, string $currentVersion = Protocol::CONNECTOR_VERSION) {
		$this->db = $db;
		$this->settings = $settings;
		$this->platform = $platform;
		$this->currentVersion = $currentVersion;
	}

	public static function supported(): bool {
		return function_exists('sodium_crypto_sign_verify_detached') && class_exists(\ZipArchive::class) && function_exists('curl_init');
	}

	public function enabled(): bool {
		$value = $this->settings->get(0, 'auto_update');

		return $value === null || $value === '' || (bool)$value;
	}

	/** @return array<string,mixed> what the last check/update did (for the settings page and health) */
	public function state(): array {
		$state = $this->settings->get(0, 'update_state');

		return is_array($state) ? $state : [];
	}

	/**
	 * Checks and, if a newer signed release exists, installs it.
	 *
	 * @return array{status:string,from:string,to:?string,error?:string}
	 */
	public function run(bool $force = false): array {
		$state = $this->state();

		if (!$force && ($state['status'] ?? '') === 'up_to_date' && (int)($state['checked_at'] ?? 0) > time() - self::RECHECK_SECONDS && ($state['version'] ?? '') === $this->currentVersion) {
			return ['status' => 'up_to_date', 'from' => $this->currentVersion, 'to' => null];
		}

		if (!self::supported()) {
			return $this->remember(['status' => 'unsupported', 'from' => $this->currentVersion, 'to' => null, 'error' => 'sodium_zip_or_curl_missing']);
		}

		if (!$this->lock()) {
			return ['status' => 'busy', 'from' => $this->currentVersion, 'to' => null];
		}

		try {
			$release = $this->release();

			if ($release === null) {
				return $this->remember(['status' => 'up_to_date', 'from' => $this->currentVersion, 'to' => null]);
			}

			$zip = $this->download($release);
			$files = $this->unpack($zip);
			$this->install($files, $release['version']);

			return $this->remember(['status' => 'updated', 'from' => $this->currentVersion, 'to' => $release['version']]);
		} catch (\Throwable $e) {
			return $this->remember(['status' => 'failed', 'from' => $this->currentVersion, 'to' => null, 'error' => preg_replace('/[^a-z0-9_:\-. ]/i', '', substr($e->getMessage(), 0, 160))]);
		} finally {
			$this->unlock();
		}
	}

	// ── steps (public for the unit tests) ──────────────────────────────

	/**
	 * The signed manifest, verified; the package for this OpenCart line when
	 * it is newer than what is installed, otherwise null.
	 *
	 * @return array{version:string,path:string,sha256:string}|null
	 */
	public function release(): ?array {
		$base = Endpoints::app();
		$manifest = Http::get($base . self::MANIFEST_PATH, self::MAX_MANIFEST_BYTES, 10);
		$signature = Http::get($base . self::MANIFEST_PATH . '.sig', 1024, 10);

		if ($manifest['status'] !== 200 || $signature['status'] !== 200) {
			throw new \RuntimeException('manifest_unavailable');
		}

		return self::parseManifest($manifest['body'], trim($signature['body']), Endpoints::updatePublicKey(), $this->currentVersion, $this->platform->packageLine());
	}

	/** @return array{version:string,path:string,sha256:string}|null */
	public static function parseManifest(string $body, string $signatureB64, string $publicKeyB64, string $currentVersion, string $line): ?array {
		$signature = base64_decode($signatureB64, true);
		$publicKey = base64_decode($publicKeyB64, true);

		if ($signature === false || strlen($signature) !== 64 || $publicKey === false || strlen($publicKey) !== 32) {
			throw new \RuntimeException('bad_signature_format');
		}

		if (!sodium_crypto_sign_verify_detached($signature, $body, $publicKey)) {
			throw new \RuntimeException('signature_invalid');
		}

		$manifest = json_decode($body, true);

		if (!is_array($manifest) || ($manifest['slug'] ?? '') !== 'webyar-opencart' || !is_string($manifest['version'] ?? null)) {
			throw new \RuntimeException('manifest_invalid');
		}

		if (($manifest['protocol'] ?? '') !== Protocol::PROTOCOL_VERSION || !preg_match('/^\d+\.\d+\.\d+$/', $manifest['version'])) {
			throw new \RuntimeException('manifest_incompatible');
		}

		if (!version_compare($manifest['version'], $currentVersion, '>')) {
			return null;
		}

		foreach ((array)($manifest['packages'] ?? []) as $package) {
			if (is_array($package) && ($package['opencart'] ?? '') === $line) {
				$path = (string)($package['path'] ?? '');
				$sha = strtolower((string)($package['sha256'] ?? ''));

				if (!preg_match('#^/downloads/opencart/[a-z0-9./_-]+\.zip$#i', $path) || strpos($path, '..') !== false || !preg_match('/^[a-f0-9]{64}$/', $sha)) {
					throw new \RuntimeException('package_invalid');
				}

				return ['version' => $manifest['version'], 'path' => $path, 'sha256' => $sha];
			}
		}

		throw new \RuntimeException('no_package_for_' . $line);
	}

	/** @param array{version:string,path:string,sha256:string} $release */
	private function download(array $release): string {
		$res = Http::get(Endpoints::app() . $release['path'], self::MAX_PACKAGE_BYTES, 30);

		if ($res['status'] !== 200) {
			throw new \RuntimeException('package_unavailable');
		}

		if (!hash_equals($release['sha256'], hash('sha256', $res['body']))) {
			throw new \RuntimeException('package_checksum_mismatch');
		}

		return $res['body'];
	}

	/**
	 * Zip bytes → files (zip name, absolute target path, contents), after
	 * validating every entry against this platform's update targets.
	 *
	 * @return array<int,array{name:string,path:string,data:string}>
	 */
	public function unpack(string $zipBytes): array {
		return self::unpackFor($zipBytes, $this->platform->updateTargets($this->settings->get(0, 'admin_dir')));
	}

	/**
	 * @param array<string,string> $targets zip path prefix => absolute directory
	 * @return array<int,array{name:string,path:string,data:string}>
	 */
	public static function unpackFor(string $zipBytes, array $targets): array {
		if (!$targets) {
			throw new \RuntimeException('update_targets_unknown');
		}

		$tmp = tempnam(sys_get_temp_dir(), 'wyup');
		file_put_contents($tmp, $zipBytes);
		$zip = new \ZipArchive();
		$opened = false;

		try {
			if ($zip->open($tmp) !== true) {
				throw new \RuntimeException('package_unreadable');
			}

			$opened = true;

			if ($zip->numFiles < 1 || $zip->numFiles > self::MAX_ENTRIES) {
				throw new \RuntimeException('package_entry_count');
			}

			$files = [];
			$total = 0;

			for ($i = 0; $i < $zip->numFiles; $i++) {
				$stat = $zip->statIndex($i);
				$name = (string)($stat['name'] ?? '');

				if ($name === '' || substr($name, -1) === '/') {
					continue; // directory entry
				}

				if ($name[0] === '/' || strpos($name, '\\') !== false || strpos($name, "\0") !== false || preg_match('#(^|/)\.\.?(/|$)#', $name)) {
					throw new \RuntimeException('package_bad_path');
				}

				// Unix symlinks carry S_IFLNK in the high word of the external attributes.
				if ($zip->getExternalAttributesIndex($i, $opsys, $attr) && $opsys === \ZipArchive::OPSYS_UNIX && (($attr >> 16) & 0170000) === 0120000) {
					throw new \RuntimeException('package_symlink');
				}

				$ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));

				if (!in_array($ext, self::ALLOWED_EXT, true)) {
					throw new \RuntimeException('package_file_type');
				}

				$target = null;

				foreach ($targets as $prefix => $dir) {
					if ($prefix === '' || strpos($name, $prefix) === 0) {
						$target = rtrim($dir, '/') . '/' . substr($name, strlen($prefix));
						break;
					}
				}

				if ($target === null) {
					throw new \RuntimeException('package_outside_extension');
				}

				$total += (int)$stat['size'];

				if ($total > self::MAX_UNPACKED_BYTES) {
					throw new \RuntimeException('package_too_large');
				}

				$data = $zip->getFromIndex($i);

				if ($data === false) {
					throw new \RuntimeException('package_unreadable');
				}

				$files[] = ['name' => $name, 'path' => $target, 'data' => $data];
			}

			if (!$files) {
				throw new \RuntimeException('package_empty');
			}

			return $files;
		} finally {
			if ($opened) {
				$zip->close();
			}

			if (is_file($tmp)) {
				unlink($tmp);
			}
		}
	}

	/** @param array<int,array{name:string,path:string,data:string}> $files */
	private function install(array $files, string $version): void {
		$work = rtrim($this->platform->storageDir(), '/') . '/webyar/update-' . bin2hex(random_bytes(4));
		$backup = $work . '-backup';
		$written = [];

		try {
			// 1. Everything must be writable before anything is touched.
			foreach ($files as $file) {
				$path = $file['path'];
				$dir = dirname($path);

				if ((is_file($path) && !is_writable($path)) || (!is_dir($dir) && !is_writable(self::existingParent($dir))) || (is_dir($dir) && !is_writable($dir))) {
					throw new \RuntimeException('not_writable');
				}
			}

			// 2. Stage, then back up and swap file by file.
			foreach ($files as $file) {
				$path = $file['path'];
				$data = $file['data'];

				if (is_file($path)) {
					$copy = $backup . '/' . md5($path);
					if (!is_dir($backup)) {
						mkdir($backup, 0700, true);
					}

					if (!copy($path, $copy)) {
						throw new \RuntimeException('backup_failed');
					}

					$written[$path] = $copy;
				} else {
					$written[$path] = null;
				}

				if (!is_dir(dirname($path)) && !mkdir(dirname($path), 0755, true)) {
					throw new \RuntimeException('mkdir_failed');
				}

				$staged = $path . '.webyar-' . bin2hex(random_bytes(3));

				if (file_put_contents($staged, $data) !== strlen($data) || !rename($staged, $path)) {
					if (is_file($staged)) {
						unlink($staged);
					}
					throw new \RuntimeException('write_failed');
				}

				if (function_exists('opcache_invalidate') && substr($path, -4) === '.php') {
					opcache_invalidate($path, true);
				}
			}
		} catch (\Throwable $e) {
			// Put every original back; remove files that did not exist before.
			foreach ($written as $path => $copy) {
				if ($copy !== null) {
					copy($copy, $path);
				} else {
					if (is_file($path)) {
						unlink($path);
					}
				}

				if (function_exists('opcache_invalidate') && substr($path, -4) === '.php') {
					opcache_invalidate($path, true);
				}
			}

			throw $e;
		} finally {
			self::removeTree($backup);
			self::removeTree($work);
		}

		$this->platform->recordInstalledFiles(array_column($files, 'name'), $version);
		// The new code finishes its own upgrade (schema, event) on its first
		// admin visit; the schema step it needs for API calls is idempotent.
		(new Schema($this->db, $this->platform->databaseName()))->install();
	}

	/** @param array<string,mixed> $result */
	private function remember(array $result): array {
		$this->settings->set(0, 'update_state', $result + ['checked_at' => time(), 'version' => $result['to'] ?? $this->currentVersion]);

		return $result;
	}

	private function lock(): bool {
		$row = $this->db->row('SELECT GET_LOCK(' . $this->db->str('webyar_update_' . $this->platform->databaseName()) . ', 0) AS `l`');

		return (int)($row['l'] ?? 0) === 1;
	}

	private function unlock(): void {
		$this->db->row('SELECT RELEASE_LOCK(' . $this->db->str('webyar_update_' . $this->platform->databaseName()) . ') AS `l`');
	}

	private static function existingParent(string $dir): string {
		while ($dir !== '' && $dir !== '/' && !is_dir($dir)) {
			$dir = dirname($dir);
		}

		return $dir;
	}

	/*
	 * No "@" anywhere in this class: some OpenCart versions (4.1.0.0) print
	 * warnings even when suppressed, which would corrupt the JSON answer.
	 * Every call is guarded instead.
	 */
	private static function removeTree(string $dir): void {
		if (!is_dir($dir)) {
			return;
		}

		foreach (scandir($dir) ?: [] as $entry) {
			if ($entry !== '.' && $entry !== '..') {
				$path = $dir . '/' . $entry;
				is_dir($path) ? self::removeTree($path) : unlink($path);
			}
		}

		rmdir($dir);
	}
}
