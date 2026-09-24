<?php
/**
 * Web Yar for OpenCart — version-agnostic core.
 *
 * Loaded by the OpenCart 3.0.x and 4.1.x wrappers with require_once; it
 * registers ONE autoloader for the `WebYar\OpenCart\` namespace and nothing
 * else. It never touches OpenCart's own autoloader or core classes.
 */
if (!defined('WEBYAR_OC_CORE_LOADED')) {
	define('WEBYAR_OC_CORE_LOADED', 1);

	spl_autoload_register(static function (string $class): void {
		$prefix = 'WebYar\\OpenCart\\';

		if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
			return;
		}

		$relative = substr($class, strlen($prefix));

		if (!preg_match('/^[A-Za-z0-9_\\\\]+$/', $relative)) {
			return;
		}

		$file = __DIR__ . '/' . str_replace('\\', '/', $relative) . '.php';

		if (is_file($file)) {
			require_once $file;
		}
	});
}
