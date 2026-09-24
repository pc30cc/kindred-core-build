<?php

namespace WebYar\Whmcs;

/**
 * Outbound calls to Web Yar — only ever from an administrator's explicit
 * action (connect, check, disconnect) or the pairing callback. Never during a
 * client-area page render. Short timeouts, TLS verification on, no redirects.
 */
final class Http
{
    /** @var callable|null test override: fn(string $url, string $body, array $headers): array{status:int,json:mixed} */
    public static $transportOverride = null;

    /**
     * @param array<string,string> $headers
     * @return array{status:int,json:mixed}
     */
    public static function postJson($url, $body, array $headers, $timeoutSeconds)
    {
        if (self::$transportOverride !== null) {
            return call_user_func(self::$transportOverride, $url, $body, $headers);
        }
        if (!preg_match('#^https://#i', $url) && !self::allowInsecureLocal($url)) {
            return array('status' => 0, 'json' => null);
        }
        $lines = array();
        foreach ($headers as $name => $value) {
            $lines[] = $name . ': ' . $value;
        }
        if (!isset($headers['Content-Type'])) {
            $lines[] = 'Content-Type: application/json';
        }
        $ch = curl_init($url);
        curl_setopt_array($ch, array(
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => min(5, (int) $timeoutSeconds),
            CURLOPT_TIMEOUT => (int) $timeoutSeconds,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
        ));
        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if (!is_string($response) || strlen($response) > 65536) {
            return array('status' => $status, 'json' => null);
        }
        return array('status' => $status, 'json' => json_decode($response, true));
    }

    /** http:// only for a Web Yar running on this same machine during development. */
    private static function allowInsecureLocal($url)
    {
        $host = parse_url($url, PHP_URL_HOST);
        return in_array($host, array('localhost', '127.0.0.1'), true);
    }
}
