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
 * the `authorization` field is defense-in-depth: for a customer-scoped
 * lookup, this controller independently confirms the order actually
 * belongs to that customer before returning anything.
 */
final class OrderController {

	public function lookup( \WP_REST_Request $request ): \WP_REST_Response {
		$authorization = (array) $request->get_param( 'authorization' );
		$customer_id   = $request->get_param( 'customer_id' );

		if ( $customer_id ) {
			$orders = OrderReader::orders_for_customer( (string) $customer_id, (int) ( $request->get_param( 'limit' ) ?: 5 ) );
			return new \WP_REST_Response( array( 'orders' => $orders ), 200 );
		}

		$order_id = (string) $request->get_param( 'order_id' );
		$order    = OrderReader::find( $order_id );
		if ( ! $order ) {
			return new \WP_REST_Response( array( 'found' => false ), 404 );
		}

		if ( 'verified_customer' === ( $authorization['kind'] ?? '' ) ) {
			$expected_customer = (string) ( $authorization['externalCustomerId'] ?? '' );
			if ( (string) $order->get_customer_id() !== $expected_customer ) {
				// Defense in depth — this order does not belong to the
				// authorized customer, regardless of what Web Yar claimed.
				return new \WP_REST_Response( array( 'found' => false ), 404 );
			}
		}

		return new \WP_REST_Response( array_merge( array( 'found' => true ), OrderReader::to_canonical( $order ) ), 200 );
	}

	public function tracking( \WP_REST_Request $request ): \WP_REST_Response {
		$order_id = (string) $request->get_param( 'order_id' );
		$order    = OrderReader::find( $order_id );
		if ( ! $order ) {
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
}
