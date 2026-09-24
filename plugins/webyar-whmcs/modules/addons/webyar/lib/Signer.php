<?php

namespace WebYar\Whmcs;

/**
 * HMAC-SHA256 request signing — the PHP mirror of
 * server/services/commerce/signing.ts. Same string-to-sign, same headers,
 * both directions:
 *
 *   <protocol>\n<METHOD>\n<canonical_path>\n<installation_id>\n<timestamp>\n<nonce>\n<sha256(body)>
 */
final class Signer
{
    const CLOCK_SKEW_SECONDS = 300;
    const MAX_BODY_BYTES = 65536;

    public static function stringToSign($protocol, $method, $path, $installationId, $timestamp, $nonce, $bodySha256)
    {
        return implode("\n", array($protocol, strtoupper($method), $path, $installationId, $timestamp, $nonce, $bodySha256));
    }

    public static function sign($secret, $stringToSign)
    {
        return hash_hmac('sha256', $stringToSign, $secret);
    }

    /** @return array<string,string> */
    public static function headers($secret, $installationId, $method, $path, $body)
    {
        $timestamp = (string) Platform::now();
        $nonce = bin2hex(random_bytes(16));
        $signature = self::sign($secret, self::stringToSign(Version::PROTOCOL, $method, $path, $installationId, $timestamp, $nonce, hash('sha256', $body)));
        return array(
            'X-WebYar-Installation' => $installationId,
            'X-WebYar-Timestamp' => $timestamp,
            'X-WebYar-Nonce' => $nonce,
            'X-WebYar-Signature' => $signature,
            'X-WebYar-Protocol' => Version::PROTOCOL,
            'Content-Type' => 'application/json',
        );
    }

    /**
     * Verifies an inbound Web Yar → addon request. Returns null when valid,
     * otherwise a short error code. Order: cheap structural checks first, the
     * HMAC next, and only a request that proved possession of the secret may
     * spend a nonce row.
     *
     * @param array<string,string> $headers lower-cased header names
     * @return string|null
     */
    public static function verify(array $headers, $method, $body, $installationId, $secret, callable $rememberNonce)
    {
        $protocol = isset($headers['x-webyar-protocol']) ? $headers['x-webyar-protocol'] : '';
        $sentId = isset($headers['x-webyar-installation']) ? $headers['x-webyar-installation'] : '';
        $timestamp = isset($headers['x-webyar-timestamp']) ? $headers['x-webyar-timestamp'] : '';
        $nonce = isset($headers['x-webyar-nonce']) ? $headers['x-webyar-nonce'] : '';
        $signature = isset($headers['x-webyar-signature']) ? $headers['x-webyar-signature'] : '';

        if ($protocol === '' || $sentId === '' || $timestamp === '' || $nonce === '' || $signature === '') {
            return 'missing_signature_headers';
        }
        if ($protocol !== Version::PROTOCOL) {
            return 'protocol_mismatch';
        }
        if (!hash_equals($installationId, $sentId)) {
            return 'unknown_installation';
        }
        if (strlen($body) > self::MAX_BODY_BYTES) {
            return 'body_too_large';
        }
        if (!preg_match('/^\d{1,12}$/', $timestamp) || abs(Platform::now() - (int) $timestamp) > self::CLOCK_SKEW_SECONDS) {
            return 'clock_skew';
        }
        if (!preg_match('/^[a-f0-9]{16,64}$/', $nonce) || !preg_match('/^[a-f0-9]{64}$/', $signature)) {
            return 'bad_signature';
        }
        $expected = self::sign($secret, self::stringToSign($protocol, $method, Version::API_CANONICAL_PATH, $installationId, $timestamp, $nonce, hash('sha256', $body)));
        if (!hash_equals($expected, $signature)) {
            return 'bad_signature';
        }
        if (!call_user_func($rememberNonce, $nonce)) {
            return 'replay';
        }
        return null;
    }
}
