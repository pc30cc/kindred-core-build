<?php
/**
 * PSR-4 autoloader for WebYar\Whmcs\ → lib/. No Composer at runtime: the
 * addon ships with zero third-party dependencies and uses only what WHMCS
 * itself provides (Capsule, localAPI, CurrentUser, hooks).
 */

if (!defined('WHMCS') && !defined('WEBYAR_WHMCS_TESTING')) {
    die('This file cannot be accessed directly');
}

spl_autoload_register(function ($class) {
    $prefix = 'WebYar\\Whmcs\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $file = __DIR__ . '/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($file)) {
        require_once $file;
    }
});
