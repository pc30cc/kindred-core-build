<?php

namespace WebYar\Whmcs\Api;

/**
 * A second, WHMCS-side ceiling on how hard Web Yar may call this install.
 * Web Yar already rate-limits and circuit-breaks per installation and per
 * identity; this only protects WHMCS if that ever fails. It uses APCu when
 * the host has it (shared memory, zero database writes) and is a no-op
 * otherwise — it never writes to the WHMCS database.
 */
final class RateGate
{
    const PER_INSTALLATION_PER_MINUTE = 240;
    const PER_GRANT_PER_MINUTE = 30;

    /** @var bool|null test override */
    public static $enabledOverride = null;

    public static function allow($installationId, $grantId)
    {
        $enabled = self::$enabledOverride !== null ? self::$enabledOverride : (function_exists('apcu_enabled') && apcu_enabled());
        if (!$enabled) {
            return true;
        }
        $window = (int) floor(time() / 60);
        if (!self::take('webyar:i:' . $installationId . ':' . $window, self::PER_INSTALLATION_PER_MINUTE)) {
            return false;
        }
        if ($grantId !== null && !self::take('webyar:g:' . $grantId . ':' . $window, self::PER_GRANT_PER_MINUTE)) {
            return false;
        }
        return true;
    }

    private static function take($key, $limit)
    {
        if (!function_exists('apcu_add') || !function_exists('apcu_inc')) {
            return true;
        }
        apcu_add($key, 0, 120);
        $count = apcu_inc($key);
        return $count === false || $count <= $limit;
    }
}
