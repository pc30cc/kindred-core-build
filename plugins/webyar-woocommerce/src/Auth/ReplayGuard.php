<?php
namespace WebYar\WooCommerce\Auth;

use WebYar\WooCommerce\Support\Version;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Verifies inbound signed requests FROM Web Yar to this plugin's REST
 * routes. This is server authentication, NOT WordPress's own nonce system
 * (wp_verify_nonce is CSRF protection for admin-UI form submissions only —
 * spec §8/§78 — and is never used as a substitute here).
 *
 * Nonce replay cache uses WordPress transients (no new dependency); bounded
 * clock skew and body-size/content-type checks mirror the Web Yar side
 * exactly (server/services/commerce/signing.ts).
 */
final class ReplayGuard {

	private const CLOCK_SKEW_SECONDS = 300;
	private const MAX_BODY_BYTES     = 256 * 1024;

	/**
	 * @return true|\WP_Error
	 */
	public static function verify( \WP_REST_Request $request, string $installation_secret, string $installation_id ) {
		$protocol   = (string) $request->get_header( 'X-WebYar-Protocol' );
		$sent_id    = (string) $request->get_header( 'X-WebYar-Installation' );
		$timestamp  = (string) $request->get_header( 'X-WebYar-Timestamp' );
		$nonce      = (string) $request->get_header( 'X-WebYar-Nonce' );
		$signature  = (string) $request->get_header( 'X-WebYar-Signature' );

		if ( '' === $protocol || '' === $sent_id || '' === $timestamp || '' === $nonce || '' === $signature ) {
			return new \WP_Error( 'missing_signature_headers', 'Missing signature headers', array( 'status' => 400 ) );
		}
		if ( $protocol !== Version::protocol_version() ) {
			return new \WP_Error( 'protocol_mismatch', 'Protocol version mismatch', array( 'status' => 400 ) );
		}
		if ( ! hash_equals( $installation_id, $sent_id ) ) {
			return new \WP_Error( 'unknown_installation', 'Unknown installation', array( 'status' => 401 ) );
		}

		$body = $request->get_body();
		if ( strlen( $body ) > self::MAX_BODY_BYTES ) {
			return new \WP_Error( 'body_too_large', 'Request body too large', array( 'status' => 413 ) );
		}
		$content_type = (string) $request->get_header( 'Content-Type' );
		if ( '' !== $body && false === stripos( $content_type, 'application/json' ) ) {
			return new \WP_Error( 'invalid_content_type', 'Content-Type must be application/json', array( 'status' => 400 ) );
		}

		$ts = (int) $timestamp;
		if ( abs( time() - $ts ) > self::CLOCK_SKEW_SECONDS ) {
			return new \WP_Error( 'clock_skew', 'Timestamp outside allowed window', array( 'status' => 401 ) );
		}

		$body_hash      = hash( 'sha256', $body );
		$string_to_sign = RequestSigner::string_to_sign( $protocol, $request->get_method(), self::canonical_path( $request ), $installation_id, $timestamp, $nonce, $body_hash );
		$expected       = RequestSigner::sign( $installation_secret, $string_to_sign );

		if ( ! hash_equals( $expected, $signature ) ) {
			return new \WP_Error( 'bad_signature', 'Invalid signature', array( 'status' => 401 ) );
		}

		if ( self::seen_nonce( $nonce ) ) {
			return new \WP_Error( 'replay', 'Nonce already used', array( 'status' => 401 ) );
		}
		self::remember_nonce( $nonce );

		return true;
	}

	private static function canonical_path( \WP_REST_Request $request ): string {
		// get_route() returns the path WITHOUT the /wp-json prefix — the
		// signer on both sides must agree on exactly this form.
		return '/wp-json' . $request->get_route();
	}

	private static function seen_nonce( string $nonce ): bool {
		return false !== get_transient( 'webyar_wc_nonce_' . md5( $nonce ) );
	}

	private static function remember_nonce( string $nonce ): void {
		// 2x the clock-skew window — a nonce outside that window can never
		// validate again anyway (its timestamp would fail the skew check).
		set_transient( 'webyar_wc_nonce_' . md5( $nonce ), 1, self::CLOCK_SKEW_SECONDS * 2 );
	}
}
