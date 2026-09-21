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

		// Who the shopper IS, not just which id they have.
		//
		// Being signed in to the shop is the store's own verification — it
		// already knows this person — so the details travel with the proof
		// and Web Yar files the conversation under the real customer instead
		// of under an anonymous visitor. They are INSIDE the signed payload:
		// the browser can read them (it is the customer's own data, already
		// on every page of their account) but cannot change them without the
		// installation secret.
		$user    = wp_get_current_user();
		$phone   = get_user_meta( (int) $customer_id, 'billing_phone', true );
		$now     = time();
		$payload = array(
			'installation_id'      => $credential['installation_id'],
			'external_customer_id' => $customer_id,
			'email'                => is_object( $user ) ? (string) $user->user_email : '',
			'name'                 => is_object( $user ) ? (string) ( $user->display_name ?: $user->user_login ) : '',
			'phone'                => is_string( $phone ) ? $phone : '',
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
