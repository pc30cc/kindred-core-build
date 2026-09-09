<?php
namespace WebYar\WooCommerce\Identity;

use WebYar\WooCommerce\Auth\CredentialStore;
use WebYar\WooCommerce\Commerce\CustomerReader;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Signs a short-lived, single-audience customer-context assertion for a
 * WooCommerce-logged-in visitor (spec §27, docs/commerce/SECURITY.md
 * §Customer identity bridge). The browser is never trusted with a raw
 * customer_id — only this signed, expiring assertion, verified server-side
 * by Web Yar (server/services/commerce/identityBridge.ts) using the SAME
 * installation secret, looked up on its own side.
 */
final class CustomerContext {

	private const TTL_SECONDS = 120;

	private static function base64url( string $raw ): string {
		return rtrim( strtr( base64_encode( $raw ), '+/', '-_' ), '=' ); // phpcs:ignore
	}

	/** Returns null when the visitor is not a logged-in WooCommerce customer, or the plugin is not connected. */
	public static function issue_assertion(): ?string {
		$customer_id = CustomerReader::current_customer_id();
		if ( null === $customer_id ) {
			return null;
		}
		$credential = CredentialStore::get();
		if ( null === $credential ) {
			return null;
		}

		$now     = time();
		$payload = array(
			'installation_id'      => $credential['installation_id'],
			'external_customer_id' => $customer_id,
			'issued_at'            => $now,
			'expires_at'           => $now + self::TTL_SECONDS,
			'nonce'                => bin2hex( random_bytes( 12 ) ),
			'audience'             => 'webyar-widget',
		);

		/**
		 * Extension point for claims — third parties may ADD fields, never
		 * remove the ones above or bypass signing (spec §57).
		 *
		 * @param array $payload
		 */
		$payload = apply_filters( 'webyar_customer_context_claims', $payload );

		$payload_b64 = self::base64url( wp_json_encode( $payload ) );
		$signature   = hash_hmac( 'sha256', $payload_b64, $credential['installation_secret'] );

		return $payload_b64 . '.' . $signature;
	}
}
