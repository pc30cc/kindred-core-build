<?php

namespace WebYar\Whmcs\Admin;

use WebYar\Whmcs\Grants;
use WebYar\Whmcs\Pairing;
use WebYar\Whmcs\Platform;
use WebYar\Whmcs\Schema;
use WebYar\Whmcs\Settings;
use WebYar\Whmcs\Version;

/**
 * Addons → Web Yar. Only reachable for administrators WHMCS has granted
 * access to this addon (Setup → Addon Modules → Access Control); every
 * state-changing action is a POST carrying this page's own session-bound
 * CSRF token, and the pairing callback is bound to the random `state` it
 * started with.
 *
 * Opening the page costs: settings reads (one table), one admin-language
 * lookup, and one COUNT of active grants. It never contacts Web Yar by itself — "Check connection" does,
 * once per click.
 */
final class Page
{
    const CSRF_KEY = 'webyar_whmcs_csrf';

    /** @param array<string,mixed> $vars WHMCS addon _output vars */
    public static function render(array $vars)
    {
        $lang = isset($vars['_lang']) && is_array($vars['_lang']) ? $vars['_lang'] : array();
        // The WHMCS addon default is English; use the logged-in admin's
        // preference so the whole page follows WHMCS when it is Persian.
        if (self::isPersian()) {
            require __DIR__ . '/../../lang/farsi.php';
            $lang = array_merge($lang, $_ADDONLANG);
        }
        $moduleLink = isset($vars['modulelink']) ? (string) $vars['modulelink'] : 'addonmodules.php?module=webyar';
        $notice = null;

        if (empty($_SESSION['adminid'])) {
            echo '<div class="alert alert-danger">' . self::t($lang, 'no_access') . '</div>';
            return;
        }

        $action = isset($_REQUEST['a']) ? (string) $_REQUEST['a'] : '';
        if ($action === 'pair_callback') {
            $code = isset($_GET['code']) ? (string) $_GET['code'] : '';
            $state = isset($_GET['state']) ? (string) $_GET['state'] : '';
            $result = Pairing::complete($code, $state);
            $notice = $result['ok'] ? array('success', self::t($lang, 'connected')) : array('danger', self::t($lang, 'error_' . $result['error'], $result['error']));
        } elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && $action !== '') {
            if (!self::csrfValid(isset($_POST['token_webyar']) ? (string) $_POST['token_webyar'] : '')) {
                $notice = array('danger', self::t($lang, 'csrf_failed'));
            } else {
                $notice = self::handle($action, $moduleLink, $lang);
                if ($notice === 'redirected') {
                    return;
                }
            }
        }

        self::view($moduleLink, $lang, $notice);
    }

    /** @return array{0:string,1:string}|string|null */
    private static function handle($action, $moduleLink, array $lang)
    {
        switch ($action) {
            case 'save':
                Settings::set('auto_widget', !empty($_POST['auto_widget']) ? '1' : '0');
                Settings::set('share_contact', !empty($_POST['share_contact']) ? '1' : '0');
                foreach (Settings::SECTIONS as $section) {
                    Settings::set('section_' . $section, !empty($_POST['section_' . $section]) ? '1' : '0');
                }
                return array('success', self::t($lang, 'saved'));
            case 'connect':
                $result = Pairing::start(self::callbackUrl($moduleLink));
                if ($result['ok']) {
                    header('Location: ' . $result['redirect']);
                    echo '<a href="' . htmlspecialchars($result['redirect'], ENT_QUOTES) . '">' . self::t($lang, 'continue') . '</a>';
                    return 'redirected';
                }
                return array('danger', self::t($lang, 'error_' . $result['error'], $result['error']));
            case 'test':
                Schema::resetCache();
                Schema::supportedCapabilities(false);
                $result = Pairing::test();
                return $result['ok'] ? array('success', self::t($lang, 'test_ok')) : array('danger', self::t($lang, 'test_failed') . ' (' . (int) $result['status'] . ')');
            case 'disconnect':
                Pairing::disconnect();
                return array('success', self::t($lang, 'disconnected'));
            case 'revoke_grants':
                Grants::revokeAll();
                return array('success', self::t($lang, 'grants_revoked'));
        }
        return null;
    }

    private static function view($moduleLink, array $lang, $notice)
    {
        $e = function ($value) {
            return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
        };
        $token = self::csrfToken();
        $credential = Settings::credential();
        $rtl = self::isPersian();
        $logo = '../modules/addons/webyar/assets/icon.png';
        echo '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>';
        echo '<link href="https://fonts.googleapis.com/css2?family=' . ($rtl ? 'Vazirmatn' : 'Inter') . ':wght@400;500;600;700&display=swap" rel="stylesheet">';
        echo '<style>.webyar-whmcs{font-family:' . ($rtl ? 'Vazirmatn' : 'Inter') . ',sans-serif;max-width:1080px;margin:24px auto;padding:28px;border-radius:24px;background:#f6f8fc;color:#14213d;box-shadow:0 18px 60px rgba(20,33,61,.08)}.webyar-whmcs .wy-head{display:flex;align-items:center;gap:16px;margin-bottom:26px}.webyar-whmcs .wy-head img{width:58px;height:58px;border-radius:16px;object-fit:contain;background:#fff;padding:8px}.webyar-whmcs .wy-head h2{margin:0;font-weight:700}.webyar-whmcs .wy-head p{margin:6px 0 0;color:#55657b;line-height:1.8}.webyar-whmcs .panel{border:1px solid #e6ecf5;border-radius:17px;overflow:hidden;box-shadow:0 8px 25px rgba(20,33,61,.04);margin-bottom:20px}.webyar-whmcs .panel-heading{background:white;border-bottom:1px solid #eef2f7;padding:17px 22px}.webyar-whmcs .panel-title{font-weight:700}.webyar-whmcs .panel-body{padding:22px}.webyar-whmcs .btn{border-radius:9px;margin:3px;padding:9px 15px}.webyar-whmcs .btn-primary{background:#2764d8;border-color:#2764d8}.webyar-whmcs .checkbox{padding:5px 0}.webyar-whmcs .checkbox label{font-weight:500}.webyar-whmcs .help-block{line-height:1.7}.webyar-whmcs .wy-readonly{direction:ltr;unicode-bidi:plaintext;overflow-wrap:anywhere;background:#f6f8fc;padding:11px;border-radius:8px}</style>';
        $capabilities = Schema::supportedCapabilities();
        // Admin language controls direction; URL and ids stay LTR.
        echo '<div class="webyar-whmcs" dir="' . ($rtl ? 'rtl' : 'ltr') . '">';
        if (is_array($notice)) {
            echo '<div class="alert alert-' . $e($notice[0]) . '">' . $e($notice[1]) . '</div>';
        }

        echo '<div class="wy-head"><img src="' . $e($logo) . '" alt="Web Yar"><div><h2>' . $e(self::t($lang, 'title')) . '</h2><p>' . $e(self::t($lang, 'intro')) . '</p></div></div>';

        // ── Connection ──
        echo '<div class="panel panel-default"><div class="panel-heading"><h3 class="panel-title">' . $e(self::t($lang, 'connection')) . '</h3></div><div class="panel-body">';
        if ($credential) {
            echo '<p><span class="label label-success">' . $e(self::t($lang, 'status_connected')) . '</span> ';
            echo $e(self::t($lang, 'workspace')) . ': <code>' . $e($credential['workspace_id']) . '</code></p>';
            echo self::form($moduleLink, $token, 'test', self::t($lang, 'check_connection'), 'btn-default');
            echo ' ' . self::form($moduleLink, $token, 'revoke_grants', self::t($lang, 'revoke_grants'), 'btn-warning');
            echo ' ' . self::form($moduleLink, $token, 'disconnect', self::t($lang, 'disconnect'), 'btn-danger', self::t($lang, 'disconnect_confirm'));
            echo '<p class="help-block">' . $e(self::t($lang, 'check_help')) . '</p>';
        } else {
            echo '<p><span class="label label-default">' . $e(self::t($lang, 'status_not_connected')) . '</span></p>';
            echo self::form($moduleLink, $token, 'connect', self::t($lang, 'connect'), 'btn-primary');
            echo '<p class="help-block">' . $e(self::t($lang, 'connect_help')) . '</p>';
        }
        echo '</div></div>';

        // ── Settings ──
        echo '<form method="post" action="' . $e($moduleLink) . '">';
        echo '<input type="hidden" name="a" value="save"><input type="hidden" name="token_webyar" value="' . $e($token) . '">';
        echo '<div class="panel panel-default"><div class="panel-heading"><h3 class="panel-title">' . $e(self::t($lang, 'settings')) . '</h3></div><div class="panel-body">';
        echo '<div class="form-group"><label>' . $e(self::t($lang, 'webyar_url')) . '</label><div class="wy-readonly" dir="ltr">' . $e(Settings::appUrl()) . '</div></div>';
        echo '<div class="form-group"><label>' . $e(self::t($lang, 'api_url')) . '</label><div class="wy-readonly" dir="ltr">' . $e(Settings::apiUrl()) . '</div></div>';
        echo self::checkbox('auto_widget', Settings::autoWidget(), self::t($lang, 'auto_widget'));
        echo self::checkbox('share_contact', Settings::shareContact(), self::t($lang, 'share_contact'));
        echo '<h4>' . $e(self::t($lang, 'sections')) . '</h4><p class="help-block">' . $e(self::t($lang, 'sections_help')) . '</p>';
        foreach (Settings::SECTIONS as $section) {
            echo self::checkbox('section_' . $section, Settings::sectionEnabled($section), self::t($lang, 'section_' . $section));
        }
        echo '<button type="submit" class="btn btn-primary">' . $e(self::t($lang, 'save')) . '</button>';
        echo '</div></div></form>';

        // ── Diagnostics (cheap: settings + one COUNT) ──
        echo '<div class="panel panel-default"><div class="panel-heading"><h3 class="panel-title">' . $e(self::t($lang, 'diagnostics')) . '</h3></div><div class="panel-body"><table class="table table-condensed">';
        $rows = array(
            self::t($lang, 'addon_version') => Version::ADDON,
            self::t($lang, 'whmcs_version') => Platform::whmcsVersion(),
            self::t($lang, 'php_version') => PHP_VERSION,
            self::t($lang, 'system_url') => Platform::systemUrl(),
            self::t($lang, 'schema') => count($capabilities) . ' / ' . count(Schema::CAPABILITY_TABLES),
            self::t($lang, 'active_grants') => (string) Grants::countActive(),
        );
        foreach ($rows as $label => $value) {
            echo '<tr><th>' . $e($label) . '</th><td dir="ltr">' . $e($value) . '</td></tr>';
        }
        echo '</table></div></div>';
        echo '</div>';
    }

    private static function form($moduleLink, $token, $action, $label, $class, $confirm = null)
    {
        $onsubmit = $confirm !== null ? ' onsubmit="return confirm(' . htmlspecialchars(json_encode($confirm), ENT_QUOTES, 'UTF-8') . ');"' : '';
        return '<form method="post" action="' . htmlspecialchars($moduleLink, ENT_QUOTES, 'UTF-8') . '" style="display:inline"' . $onsubmit . '>'
            . '<input type="hidden" name="a" value="' . htmlspecialchars($action, ENT_QUOTES, 'UTF-8') . '">'
            . '<input type="hidden" name="token_webyar" value="' . htmlspecialchars($token, ENT_QUOTES, 'UTF-8') . '">'
            . '<button type="submit" class="btn ' . $class . '">' . htmlspecialchars($label, ENT_QUOTES, 'UTF-8') . '</button></form>';
    }

    private static function checkbox($name, $checked, $label)
    {
        return '<div class="checkbox"><label><input type="checkbox" name="' . htmlspecialchars($name, ENT_QUOTES, 'UTF-8') . '" value="1"' . ($checked ? ' checked' : '') . '> '
            . htmlspecialchars($label, ENT_QUOTES, 'UTF-8') . '</label></div>';
    }

    public static function csrfToken()
    {
        if (empty($_SESSION[self::CSRF_KEY]) || !is_string($_SESSION[self::CSRF_KEY])) {
            $_SESSION[self::CSRF_KEY] = bin2hex(random_bytes(32));
        }
        return $_SESSION[self::CSRF_KEY];
    }

    public static function csrfValid($submitted)
    {
        return !empty($_SESSION[self::CSRF_KEY]) && is_string($submitted) && $submitted !== '' && hash_equals((string) $_SESSION[self::CSRF_KEY], $submitted);
    }

    /** Absolute URL of this admin page's pairing callback (must sit on the System URL's origin). */
    private static function callbackUrl($moduleLink)
    {
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (isset($_SERVER['SERVER_PORT']) && (int) $_SERVER['SERVER_PORT'] === 443);
        $host = isset($_SERVER['HTTP_HOST']) ? (string) $_SERVER['HTTP_HOST'] : '';
        $path = isset($_SERVER['SCRIPT_NAME']) ? (string) $_SERVER['SCRIPT_NAME'] : '/admin/addonmodules.php';
        $query = parse_url($moduleLink, PHP_URL_QUERY);
        return ($https ? 'https' : 'http') . '://' . $host . $path . '?' . ($query ? $query . '&' : '') . 'a=pair_callback';
    }

    private static function isPersian()
    {
        $language = '';
        if (!empty($_SESSION['adminid'])) {
            try {
                $language = strtolower((string) \WHMCS\Database\Capsule::table('tbladmins')->where('id', (int) $_SESSION['adminid'])->value('language'));
            } catch (\Exception $e) {
                $language = '';
            }
        }
        if ($language === '') {
            $language = strtolower((string) Platform::setting('Language'));
        }
        return in_array($language, array('farsi', 'persian', 'fa', 'fa_ir'), true);
    }

    private static function t(array $lang, $key, $fallback = null)
    {
        if (isset($lang[$key])) {
            return (string) $lang[$key];
        }
        return $fallback !== null ? (string) $fallback : $key;
    }
}
