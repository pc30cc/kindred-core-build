<?php

namespace WebYar\Whmcs;

/**
 * The only file that touches WHMCS globals other than Capsule. Keeping them
 * behind one seam lets the unit tests run the real readers against SQLite
 * without a WHMCS install, and makes every platform dependency auditable in
 * one place:
 *
 *   localAPI()                              — WHMCS Internal API
 *   \WHMCS\Config\Setting::getValue()       — documented in "Admin Area" dev docs
 *   \WHMCS\Authentication\CurrentUser       — WHMCS 8.0+
 */
final class Platform
{
    /** @var callable|null test override for localAPI */
    public static $localApiOverride = null;
    /** @var array<string,string>|null test override for settings */
    public static $settingsOverride = null;

    /**
     * @param array<string,mixed> $params
     * @return array<string,mixed>
     */
    public static function localApi($command, array $params)
    {
        if (self::$localApiOverride !== null) {
            return call_user_func(self::$localApiOverride, $command, $params);
        }
        if (!function_exists('localAPI')) {
            return array('result' => 'error', 'message' => 'localAPI unavailable');
        }
        $result = localAPI($command, $params);
        return is_array($result) ? $result : array('result' => 'error');
    }

    /** @return string|null */
    public static function setting($name)
    {
        if (self::$settingsOverride !== null) {
            return isset(self::$settingsOverride[$name]) ? self::$settingsOverride[$name] : null;
        }
        if (!class_exists('\WHMCS\Config\Setting')) {
            return null;
        }
        try {
            $value = \WHMCS\Config\Setting::getValue($name);
        } catch (\Exception $e) {
            return null;
        }
        return $value === null ? null : (string) $value;
    }

    /** WHMCS System URL without a trailing slash, or '' when unknown. */
    public static function systemUrl()
    {
        $url = (string) self::setting('SystemURL');
        return rtrim($url, '/');
    }

    public static function whmcsVersion()
    {
        $version = self::setting('Version');
        return $version !== null ? $version : '';
    }

    /** @return string */
    public static function encrypt($plain)
    {
        $result = self::localApi('EncryptPassword', array('password2' => $plain));
        if (!isset($result['result']) || $result['result'] !== 'success' || !isset($result['password'])) {
            throw new \RuntimeException('encrypt_failed');
        }
        return (string) $result['password'];
    }

    /** @return string|null */
    public static function decrypt($cipher)
    {
        if ($cipher === '' || $cipher === null) {
            return null;
        }
        $result = self::localApi('DecryptPassword', array('password2' => $cipher));
        if (!isset($result['result']) || $result['result'] !== 'success' || !isset($result['password'])) {
            return null;
        }
        return (string) $result['password'];
    }

    /** @var int|null test clock */
    public static $nowOverride = null;

    public static function now()
    {
        return self::$nowOverride !== null ? (int) self::$nowOverride : time();
    }
}
