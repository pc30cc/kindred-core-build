<?php
namespace WebYar\WooCommerce\Rest;

use WebYar\WooCommerce\Commerce\OrderReader;
use WebYar\WooCommerce\Commerce\TrackingResolver;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Order/tracking/contact-verification. Web Yar has already authorized the
 * request (verified customer via customer-context bridge, or verified
 * guest via the Generic Verification Core) BEFORE calling this endpoint —
 * the `authorization` field is defense-in-depth: this controller
 * independently confirms that the authorization names THIS order (guest)
 * or that the order belongs to the authorized customer, on every path that
 * returns order data (single lookup, customer list, tracking). A request
 * without a matching authorization gets the same answer as a missing order.
 */
final class OrderController {

	public function lookup( \WP_REST_Request $request ): \WP_REST_Response {
		$authorization = (array) $request->get_param( 'authorization' );
		$customer_id   = $request->get_param( 'customer_id' );

		if ( $customer_id ) {
			if ( ! self::authorizes_customer( $authorization, (string) $customer_id ) ) {
				return new \WP_REST_Response( array( 'orders' => array() ), 403 );
			}
			$orders = OrderReader::orders_for_customer( (string) $customer_id, (int) ( $request->get_param( 'limit' ) ?: 5 ) );
			return new \WP_REST_Response( array( 'orders' => $orders ), 200 );
		}

		$order_id = (string) $request->get_param( 'order_id' );
		$order    = OrderReader::find( $order_id );
		if ( ! $order || ! self::authorizes( $authorization, (string) $order->get_customer_id(), $order_id ) ) {
			return new \WP_REST_Response( array( 'found' => false ), 404 );
		}

		return new \WP_REST_Response( array_merge( array( 'found' => true ), OrderReader::to_canonical( $order ) ), 200 );
	}

	public function tracking( \WP_REST_Request $request ): \WP_REST_Response {
		$authorization = (array) $request->get_param( 'authorization' );
		$order_id      = (string) $request->get_param( 'order_id' );
		$order         = OrderReader::find( $order_id );
		if ( ! $order || ! self::authorizes( $authorization, (string) $order->get_customer_id(), $order_id ) ) {
			return new \WP_REST_Response( array( 'found' => false ), 404 );
		}
		$tracking = TrackingResolver::resolve( $order );
		return new \WP_REST_Response( array_merge( array( 'found' => true ), $tracking ), 200 );
	}

	/** Boolean-only match — never returns unmasked contact details (spec §29). */
	public function verify_contact( \WP_REST_Request $request ): \WP_REST_Response {
		$order = OrderReader::find( (string) $request->get_param( 'order_id' ) );
		if ( ! $order ) {
			return new \WP_REST_Response( array( 'matched' => false ), 200 );
		}
		$matched = OrderReader::contact_matches( $order, $request->get_param( 'email' ), $request->get_param( 'phone' ) );
		return new \WP_REST_Response( array( 'matched' => $matched ), 200 );
	}

	/**
	 * May this authorization see this one order?
	 *
	 * - verified_customer: the order's customer is the authorized customer
	 *   (a guest order, customer id 0, never matches), and when the
	 *   authorization names an order it is the requested one;
	 * - verified_guest: the authorization names exactly the requested order
	 *   and carries the proof Web Yar issued after contact verification;
	 * - anything else, including a missing authorization: no.
	 */
	public static function authorizes( array $authorization, string $order_customer_id, string $requested_order_id ): bool {
		$kind          = (string) ( $authorization['kind'] ?? '' );
		$named_order   = (string) ( $authorization['externalOrderId'] ?? '' );
		$requested     = trim( $requested_order_id );

		if ( 'verified_customer' === $kind ) {
			if ( ! self::authorizes_customer( $authorization, $order_customer_id ) ) {
				return false;
			}
			return '' === $named_order || hash_equals( $named_order, $requested );
		}

		if ( 'verified_guest' === $kind ) {
			$proof = (string) ( $authorization['verificationProofToken'] ?? '' );
			return '' !== $proof && '' !== $named_order && '' !== $requested && hash_equals( $named_order, $requested );
		}

		return false;
	}

	/** A customer-scoped read: the authorization is for exactly this (real, non-guest) customer. */
	public static function authorizes_customer( array $authorization, string $customer_id ): bool {
		if ( 'verified_customer' !== (string) ( $authorization['kind'] ?? '' ) ) {
			return false;
		}
		$expected = (string) ( $authorization['externalCustomerId'] ?? '' );
		$actual   = trim( $customer_id );
		// WooCommerce stores guest orders under customer id 0, and
		// orders_for_customer() casts to int — so only a positive integer id
		// can name a customer; anything else would widen to guest orders.
		if ( ! self::is_customer_id( $expected ) || ! self::is_customer_id( $actual ) ) {
			return false;
		}
		return hash_equals( $expected, $actual );
	}

	private static function is_customer_id( string $value ): bool {
		return 1 === preg_match( '/^[1-9][0-9]{0,19}$/', $value );
	}
}
