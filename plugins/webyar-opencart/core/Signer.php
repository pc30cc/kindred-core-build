<?php
namespace WebYar\OpenCart;

/**
 * HMAC request signing, mirroring server/services/commerce/signing.ts:
 *
 *   protocol \n METHOD \n canonical_path \n installation_id \n timestamp \n nonce \n sha256(body)
 */
final class Signer {
	public static function stringToSign(string $protocol, string $method, string $path, string $installationId, string $timestamp, string $nonce, string $body): string {
		return implode("\n", [$protocol, strtoupper($method), $path, $installationId, $timestamp, $nonce, hash('sha256', $body)]);
	}

	/** @return array<string,string> */
	public static function headers(string $secret, string $installationId, string $method, string $path, string $body): array {
		$timestamp = (string)time();
		$nonce = Crypto::random(16);

		return [
			'X-WebYar-Installation' => $installationId,
			'X-WebYar-Timestamp'    => $timestamp,
			'X-WebYar-Nonce'        => $nonce,
			'X-WebYar-Signature'    => Crypto::hmac($secret, self::stringToSign(Protocol::PROTOCOL_VERSION, $method, $path, $installationId, $timestamp, $nonce, $body)),
			'X-WebYar-Protocol'     => Protocol::PROTOCOL_VERSION,
			'Content-Type'          => 'application/json',
		];
	}

	/**
	 * Checks everything that can be checked WITHOUT a database: protocol,
	 * skew, header shape and the HMAC itself. The nonce replay check is
	 * separate (ReplayGuard) and runs only after this succeeds, so an
	 * unauthenticated caller can never make the store write a nonce row.
	 *
	 * @param array<string,string> $headers lower-cased header names
	 */
	public static function verify(array $headers, string $secret, string $installationId, string $method, string $path, string $body, ?int $now = null): ?string {
		$protocol = $headers['x-webyar-protocol'] ?? '';
		$sentId = $headers['x-webyar-installation'] ?? '';
		$timestamp = $headers['x-webyar-timestamp'] ?? '';
		$nonce = $headers['x-webyar-nonce'] ?? '';
		$signature = $headers['x-webyar-signature'] ?? '';

		if ($protocol === '' || $sentId === '' || $timestamp === '' || $nonce === '' || $signature === '') {
			return 'missing_signature_headers';
		}

		if ($protocol !== Protocol::PROTOCOL_VERSION) {
			return 'protocol_mismatch';
		}

		if (!Crypto::equals($installationId, $sentId)) {
			return 'unknown_installation';
		}

		if (!ctype_digit($timestamp) || !preg_match('/^[a-f0-9]{16,64}$/', $nonce) || !preg_match('/^[a-f0-9]{64}$/', $signature)) {
			return 'bad_signature';
		}

		$now = $now ?? time();

		if (abs($now - (int)$timestamp) > Protocol::CLOCK_SKEW_SECONDS) {
			return 'clock_skew';
		}

		if (strlen($body) > Protocol::MAX_BODY_BYTES) {
			return 'body_too_large';
		}

		$expected = Crypto::hmac($secret, self::stringToSign($protocol, $method, $path, $installationId, $timestamp, $nonce, $body));

		return Crypto::equals($expected, $signature) ? null : 'bad_signature';
	}
}
