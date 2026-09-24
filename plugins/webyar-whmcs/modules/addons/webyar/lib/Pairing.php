<?php

namespace WebYar\Whmcs;

/**
 * Connecting this WHMCS install to a Web Yar workspace: authorization code +
 * PKCE, the same flow the WooCommerce plugin uses
 * (server/services/commerce/pairing.ts). No API key is ever copied by hand.
 *
 *   1. register  — server-to-server: state, PKCE challenge, the exact admin
 *                  callback URL, this install's origin and System URL;
 *   2. authorize — the administrator's browser approves it in Web Yar;
 *   3. exchange  — server-to-server with the PKCE verifier; the installation
 *                  secret is returned exactly once and stored encrypted.
 */
final class Pairing
{
    const STATE_TTL = 600;

    private static function base64url($raw)
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }

    /** @return array{ok:bool,redirect?:string,error?:string} */
    public static function start($callbackUrl)
    {
        $app = Settings::appUrl();
        $api = Settings::apiUrl();
        $systemUrl = Platform::systemUrl();
        if ($app === '' || $api === '') {
            return array('ok' => false, 'error' => 'webyar_url_missing');
        }
        if ($systemUrl === '') {
            return array('ok' => false, 'error' => 'system_url_missing');
        }
        $origin = self::origin($systemUrl);
        if ($origin === null || self::origin($callbackUrl) !== $origin) {
            return array('ok' => false, 'error' => 'origin_mismatch');
        }

        $state = self::base64url(random_bytes(32));
        $verifier = self::base64url(random_bytes(32));
        $challenge = self::base64url(hash('sha256', $verifier, true));
        Settings::set('pairing', json_encode(array('state' => $state, 'verifier' => $verifier, 'at' => Platform::now())));

        $response = Http::postJson($api . '/api/commerce/pairing/register', json_encode(array(
            'state' => $state,
            'codeChallenge' => $challenge,
            'redirectUri' => $callbackUrl,
            'storeOrigin' => $origin,
            'provider' => 'whmcs',
            'storeBaseUrl' => $systemUrl,
        )), array('Content-Type' => 'application/json'), 10);
        if ($response['status'] !== 200 || !is_array($response['json']) || empty($response['json']['ok'])) {
            $code = is_array($response['json']) && isset($response['json']['error']) ? (string) $response['json']['error'] : 'register_failed';
            return array('ok' => false, 'error' => preg_replace('/[^a-z_]/', '', $code));
        }
        return array('ok' => true, 'redirect' => $app . '/commerce/authorize?' . http_build_query(array('state' => $state, 'provider' => 'whmcs')));
    }

    /** @return array{ok:bool,error?:string} */
    public static function complete($code, $state)
    {
        $pending = json_decode((string) Settings::get('pairing'), true);
        if (!is_array($pending) || !isset($pending['state'], $pending['verifier'], $pending['at'])) {
            return array('ok' => false, 'error' => 'no_pairing_in_progress');
        }
        if (!is_string($state) || !hash_equals((string) $pending['state'], $state)) {
            return array('ok' => false, 'error' => 'state_mismatch');
        }
        if (Platform::now() - (int) $pending['at'] > self::STATE_TTL) {
            Settings::delete('pairing');
            return array('ok' => false, 'error' => 'pairing_expired');
        }
        if (!is_string($code) || strlen($code) < 16 || strlen($code) > 400) {
            return array('ok' => false, 'error' => 'invalid_code');
        }
        $response = Http::postJson(Settings::apiUrl() . '/api/commerce/pairing/exchange', json_encode(array(
            'state' => $state,
            'code' => $code,
            'codeVerifier' => $pending['verifier'],
        )), array('Content-Type' => 'application/json'), 15);
        Settings::delete('pairing');
        $json = $response['json'];
        if ($response['status'] !== 200 || !is_array($json) || empty($json['installationId']) || empty($json['installationSecret']) || empty($json['workspaceId'])) {
            return array('ok' => false, 'error' => 'exchange_failed');
        }
        Settings::storeCredential(array(
            'installation_id' => $json['installationId'],
            'secret' => $json['installationSecret'],
            'workspace_id' => $json['workspaceId'],
            'connection_id' => isset($json['connectionId']) ? $json['connectionId'] : '',
        ));
        Schema::supportedCapabilities(false);
        return array('ok' => true);
    }

    /** Asks Web Yar to run its capability check against this install; reports what it observed. */
    public static function test()
    {
        return self::signedAction('/api/commerce/connection/test', 12);
    }

    /**
     * Disconnect: tell Web Yar (best effort), then forget the credential and
     * end every grant locally whatever the network said. WHMCS data is not
     * touched.
     */
    public static function disconnect()
    {
        $result = self::signedAction('/api/commerce/connection/disconnect', 8);
        Settings::delete('credential');
        Grants::revokeAll();
        return $result;
    }

    /** @return array{ok:bool,status:int} */
    private static function signedAction($path, $timeout)
    {
        $credential = Settings::credential();
        if ($credential === null) {
            return array('ok' => false, 'status' => 0);
        }
        $headers = Signer::headers($credential['secret'], $credential['installation_id'], 'POST', $path, '');
        $response = Http::postJson(Settings::apiUrl() . $path, '', $headers, $timeout);
        return array('ok' => $response['status'] === 200, 'status' => $response['status']);
    }

    /** scheme://host[:port] or null. */
    public static function origin($url)
    {
        $parts = parse_url((string) $url);
        if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            return null;
        }
        $scheme = strtolower($parts['scheme']);
        $port = isset($parts['port']) ? ':' . $parts['port'] : '';
        if (($scheme === 'https' && $port === ':443') || ($scheme === 'http' && $port === ':80')) {
            $port = '';
        }
        return $scheme . '://' . strtolower($parts['host']) . $port;
    }
}
