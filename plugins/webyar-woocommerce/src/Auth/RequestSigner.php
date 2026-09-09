<?php
namespace WebYar\WooCommerce\Auth;

use WebYar\WooCommerce\Support\Version;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Canonical HMAC-SHA256 request signing — PHP mirror of
 * server/services/commerce/signing.ts on the Web Yar side. Same
 * string-to-sign, same header names, so verification is symmetric in both
 * directions (docs/commerce/SECURITY.md §Request signing).
 */
final class RequestSigner {

	public static function string_to_sign(
		string $protocol_version,
		string $method,
		string $canonical_path,
		string $installation_id,
		string $timestamp,
		string $nonce,
		string $body_sha256_hex
	): string {
		return implode(
			"\n",
			array( $protocol_version, strtoupper( $method ), $canonical_path, $installation_id, $timestamp, $nonce, $body_sha256_hex )
		);
	}

	public static function sign( string $secret, string $string_to_sign ): string {
		return hash_hmac( 'sha256', $string_to_sign, $secret );
	}

	/**
	 * Builds the outbound signed headers for a plugin → Web Yar call
	 * (events, customer-context assertions are signed differently — see
	 * Identity/CustomerContext.php).
	 *
	 * @return array<string,string>
	 */
	public static function build_headers( string $secret, string $installation_id, string $method, string $canonical_path, string $body ): array {
		$timestamp        = (string) time();
		$nonce            = bin2hex( random_bytes( 16 ) );
		$body_hash        = hash( 'sha256', $body );
		$string_to_sign   = self::string_to_sign( Version::protocol_version(), $method, $canonical_path, $installation_id, $timestamp, $nonce, $body_hash );
		$signature        = self::sign( $secret, $string_to_sign );

		return array(
			'X-WebYar-Installation' => $installation_id,
			'X-WebYar-Timestamp'    => $timestamp,
			'X-WebYar-Nonce'        => $nonce,
			'X-WebYar-Signature'    => $signature,
			'X-WebYar-Protocol'     => Version::protocol_version(),
			'Content-Type'          => 'application/json',
		);
	}

	public static function constant_time_equals( string $a, string $b ): bool {
		return hash_equals( $a, $b );
	}
}
