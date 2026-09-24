<?php
/**
 * Web Yar hooks. Client hooks never do network I/O; the CLI cron checks for updates hourly.
 *
 *   ClientAreaFooterOutput — the existing Web Yar widget loader; on a
 *                            logged-in page also a short-lived signed
 *                            introduction (see lib/WidgetInjector.php).
 *   UserLogin / UserLogout — end this session's grant.
 *   UserChangePassword     — end every grant of that user.
 *   ClientClose / ClientDelete — end every grant on that client account.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/lib/bootstrap.php';

use WebYar\Whmcs\Grants;
use WebYar\Whmcs\Settings;
use WebYar\Whmcs\WidgetInjector;

add_hook('ClientAreaFooterOutput', 1, function ($vars) {
    try {
        return WidgetInjector::render(is_array($vars) ? $vars : array());
    } catch (\Exception $e) {
        return '';
    }
});

$webyarEndSession = function ($vars) {
    try {
        $credential = Settings::credential();
        Grants::revokeCurrentSession($credential !== null ? $credential['secret'] : null);
    } catch (\Exception $e) {
    }
};
add_hook('UserLogout', 1, $webyarEndSession);
add_hook('UserLogin', 1, $webyarEndSession);

add_hook('UserChangePassword', 1, function ($vars) {
    if (isset($vars['userid'])) {
        Grants::revokeForUser((int) $vars['userid']);
    }
});

$webyarEndClient = function ($vars) {
    if (isset($vars['userid'])) {
        Grants::revokeForClient((int) $vars['userid']);
    }
};
add_hook('ClientClose', 1, $webyarEndClient);
add_hook('ClientDelete', 1, $webyarEndClient);

add_hook('AfterCronJob', 1, function () {
    try { \WebYar\Whmcs\Updater::run(); } catch (\Throwable $e) { /* Never interrupt WHMCS automation. */ }
});
