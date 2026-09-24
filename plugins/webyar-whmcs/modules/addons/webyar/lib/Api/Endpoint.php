<?php

namespace WebYar\Whmcs\Api;

use WebYar\Whmcs\ReplayGuard;
use WebYar\Whmcs\Settings;
use WebYar\Whmcs\Signer;

/**
 * The addon's only machine endpoint (api.php). JSON in, JSON out, POST only,
 * signed by Web Yar with this installation's secret. Never sets or reads a
 * client-area session and never renders HTML.
 *
 * Nothing about a request's content is logged: no bodies, no customer data,
 * no secrets. Failures return a short code only.
 */
final class Endpoint
{
    public static function handle()
    {
        list($status, $payload) = self::process(
            isset($_SERVER['REQUEST_METHOD']) ? (string) $_SERVER['REQUEST_METHOD'] : 'GET',
            self::headers(),
            self::body()
        );
        self::respond($status, $payload);
    }

    /**
     * Pure request → response, used by handle() and by the tests.
     *
     * @param array<string,string> $headers lower-cased
     * @return array{0:int,1:array<string,mixed>}
     */
    public static function process($method, array $headers, $body)
    {
        if (strtoupper($method) !== 'POST') {
            return array(405, array('ok' => false, 'error' => 'method_not_allowed'));
        }
        if ($body === null) {
            return array(413, array('ok' => false, 'error' => 'body_too_large'));
        }
        $contentType = isset($headers['content-type']) ? strtolower($headers['content-type']) : '';
        if (strpos($contentType, 'application/json') === false) {
            return array(415, array('ok' => false, 'error' => 'invalid_content_type'));
        }
        $credential = Settings::credential();
        if ($credential === null) {
            return array(401, array('ok' => false, 'error' => 'not_connected'));
        }

        $failure = Signer::verify($headers, 'POST', $body, $credential['installation_id'], $credential['secret'], function ($nonce) {
            return ReplayGuard::remember($nonce);
        });
        if ($failure !== null) {
            $status = $failure === 'body_too_large' ? 413 : ($failure === 'protocol_mismatch' ? 400 : 401);
            return array($status, array('ok' => false, 'error' => $failure));
        }

        if (!RateGate::allow($credential['installation_id'], self::grantKey($body))) {
            return array(429, array('ok' => false, 'error' => 'rate_limited'));
        }

        $request = json_decode($body, true);
        if (!is_array($request)) {
            return array(400, array('ok' => false, 'error' => 'invalid_json'));
        }
        try {
            return Router::dispatch($request);
        } catch (\Exception $e) {
            return array(500, array('ok' => false, 'error' => 'internal_error'));
        } catch (\Error $e) {
            return array(500, array('ok' => false, 'error' => 'internal_error'));
        }
    }

    private static function grantKey($body)
    {
        $decoded = json_decode($body, true);
        return is_array($decoded) && isset($decoded['grant']['id']) && is_string($decoded['grant']['id']) ? $decoded['grant']['id'] : null;
    }

    /** @return array<string,string> */
    private static function headers()
    {
        $out = array();
        foreach ($_SERVER as $key => $value) {
            if (strpos($key, 'HTTP_') === 0) {
                $out[strtolower(str_replace('_', '-', substr($key, 5)))] = (string) $value;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $out['content-type'] = (string) $_SERVER['CONTENT_TYPE'];
        }
        return $out;
    }

    /** @return string|null null when larger than the signing limit */
    private static function body()
    {
        $stream = fopen('php://input', 'rb');
        if ($stream === false) {
            return '';
        }
        $body = stream_get_contents($stream, Signer::MAX_BODY_BYTES + 1);
        fclose($stream);
        if ($body === false) {
            return '';
        }
        return strlen($body) > Signer::MAX_BODY_BYTES ? null : $body;
    }

    private static function respond($status, array $payload)
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store, private');
            header('X-Content-Type-Options: nosniff');
        }
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}
