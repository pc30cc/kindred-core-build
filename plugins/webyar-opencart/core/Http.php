<?php
namespace WebYar\OpenCart;

/**
 * Outbound calls from the store to Web Yar. Admin-initiated only (connect,
 * test, disconnect) — never on a storefront page load or at checkout.
 * Bounded timeouts, no redirects, JSON only, capped response size.
 */
final class Http {
	/** @return array{status:int,json:?array} */
	public static function postJson(string $url, string $body, array $headers = [], int $timeout = 10): array {
		if (!self::allowedUrl($url)) {
			throw new \RuntimeException('Web Yar address must be an https:// URL');
		}

		$lines = ['Content-Type: application/json', 'Accept: application/json'];

		foreach ($headers as $name => $value) {
			if ($name !== 'Content-Type') {
				$lines[] = $name . ': ' . $value;
			}
		}

		$ch = curl_init($url);
		curl_setopt_array($ch, [
			CURLOPT_POST            => true,
			CURLOPT_POSTFIELDS      => $body,
			CURLOPT_HTTPHEADER      => $lines,
			CURLOPT_RETURNTRANSFER  => true,
			CURLOPT_FOLLOWLOCATION  => false,
			CURLOPT_CONNECTTIMEOUT  => 5,
			CURLOPT_TIMEOUT         => $timeout,
			CURLOPT_PROTOCOLS       => CURLPROTO_HTTPS | CURLPROTO_HTTP,
			CURLOPT_USERAGENT       => 'WebYar-OpenCart/' . Protocol::CONNECTOR_VERSION,
		]);
		$raw = curl_exec($ch);
		$status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
		$error = curl_error($ch);
		curl_close($ch);

		if ($raw === false) {
			throw new \RuntimeException('Web Yar is not reachable: ' . $error);
		}

		$raw = substr((string)$raw, 0, 65536);
		$json = json_decode($raw, true);

		return ['status' => $status, 'json' => is_array($json) ? $json : null];
	}

	/**
	 * https only. Plain http is accepted for a loopback Web Yar ONLY, which is
	 * what a local development install uses.
	 */
	public static function allowedUrl(string $url): bool {
		$parts = parse_url($url);

		if (!$parts || empty($parts['host']) || empty($parts['scheme'])) {
			return false;
		}

		if ($parts['scheme'] === 'https') {
			return true;
		}

		return $parts['scheme'] === 'http' && in_array($parts['host'], ['127.0.0.1', 'localhost', '::1'], true);
	}
}
