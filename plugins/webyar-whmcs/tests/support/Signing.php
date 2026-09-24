<?php

use WebYar\Whmcs\Platform;
use WebYar\Whmcs\Signer;
use WebYar\Whmcs\Version;

/** Builds requests exactly as server/services/commerce/connectors/whmcs.ts signs them. */
final class Signing
{
    public static function headers($body, $secret = WhmcsDb::SECRET, $installation = WhmcsDb::INSTALLATION, array $override = array())
    {
        $timestamp = (string) Platform::now();
        $nonce = bin2hex(random_bytes(16));
        $signature = Signer::sign($secret, Signer::stringToSign(Version::PROTOCOL, 'POST', Version::API_CANONICAL_PATH, $installation, $timestamp, $nonce, hash('sha256', $body)));
        return array_merge(array(
            'x-webyar-installation' => $installation,
            'x-webyar-timestamp' => $timestamp,
            'x-webyar-nonce' => $nonce,
            'x-webyar-signature' => $signature,
            'x-webyar-protocol' => Version::PROTOCOL,
            'content-type' => 'application/json',
        ), $override);
    }

    /** @return array{0:int,1:array} */
    public static function call($op, array $params = array(), $grant = null)
    {
        $body = json_encode(array('op' => $op, 'params' => (object) $params, 'grant' => $grant));
        return \WebYar\Whmcs\Api\Endpoint::process('POST', self::headers($body), $body);
    }
}
