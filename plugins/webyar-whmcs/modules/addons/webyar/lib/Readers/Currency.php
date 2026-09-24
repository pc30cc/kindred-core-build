<?php

namespace WebYar\Whmcs\Readers;

use WHMCS\Database\Capsule;

/**
 * The currency an account is billed in (WHMCS stores money per client in
 * that client's currency), and the store's default currency for the public
 * catalogue. Memoised per request: one indexed read at most.
 */
final class Currency
{
    /** @var array<string,string|null> */
    private static $memo = array();

    public static function codeForClient($clientId)
    {
        $key = 'c' . (int) $clientId;
        if (!array_key_exists($key, self::$memo)) {
            try {
                $code = Capsule::table('tblclients')
                    ->join('tblcurrencies', 'tblcurrencies.id', '=', 'tblclients.currency')
                    ->where('tblclients.id', (int) $clientId)
                    ->value('tblcurrencies.code');
            } catch (\Exception $e) {
                $code = null;
            }
            self::$memo[$key] = $code !== null ? strtoupper((string) $code) : null;
        }
        return self::$memo[$key];
    }

    public static function defaultCode()
    {
        if (!array_key_exists('default', self::$memo)) {
            try {
                $code = Capsule::table('tblcurrencies')->where('default', 1)->value('code');
            } catch (\Exception $e) {
                $code = null;
            }
            self::$memo['default'] = $code !== null ? strtoupper((string) $code) : null;
        }
        return self::$memo['default'];
    }

    /** Records a client's currency already read elsewhere in this request. */
    public static function prime($clientId, $code)
    {
        self::$memo['c' . (int) $clientId] = $code !== null && $code !== '' ? strtoupper((string) $code) : null;
    }

    public static function reset()
    {
        self::$memo = array();
    }
}
