<?php
namespace WebYar\OpenCart;

/**
 * The store-local encryption key.
 *
 * Kept in OpenCart's storage directory (DIR_STORAGE, which OpenCart's own
 * installer recommends moving outside the web root), NOT in the database, so
 * a database-only leak (a dump, an SQL injection elsewhere in the shop)
 * yields neither the installation secret nor usable session references.
 * Web Yar never sees this key.
 */
final class LocalKey {
	public static function path(string $storageDir): string {
		return rtrim($storageDir, '/\\') . '/webyar/local.key';
	}

	public static function load(string $storageDir, bool $create = false): ?string {
		$file = self::path($storageDir);

		if (is_file($file)) {
			$key = trim((string)file_get_contents($file));

			return strlen($key) >= 64 ? $key : null;
		}

		if (!$create) {
			return null;
		}

		$dir = dirname($file);

		if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
			return null;
		}

		@file_put_contents($dir . '/index.html', '');
		$key = Crypto::random(32);

		if (@file_put_contents($file, $key, LOCK_EX) === false) {
			return null;
		}

		@chmod($file, 0600);

		return $key;
	}

	public static function remove(string $storageDir): void {
		$file = self::path($storageDir);

		if (is_file($file)) {
			@unlink($file);
		}

		@unlink(dirname($file) . '/index.html');
		@rmdir(dirname($file));
	}
}
