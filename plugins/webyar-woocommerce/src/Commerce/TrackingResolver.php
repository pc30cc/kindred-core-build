<?php
namespace WebYar\WooCommerce\Commerce;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Tracking abstraction (spec §32). WooCommerce has no built-in shipment
 * tracking; conventions vary by plugin. This resolver checks the most
 * common convention (WooCommerce Shipment Tracking's own
 * `_wc_shipment_tracking_items` order meta) and then exposes a filter so
 * ANY Iranian shipping/tracking plugin can integrate without touching Web
 * Yar core or forking this plugin.
 */
final class TrackingResolver {

	public static function resolve( \WC_Order $order ): array {
		$tracking = array(
			'carrier'        => null,
			'trackingNumber' => null,
			'trackingUrl'    => null,
			'status'         => null,
			'updatedAt'      => null,
		);

		$items = $order->get_meta( '_wc_shipment_tracking_items' );
		if ( is_array( $items ) && ! empty( $items ) ) {
			$first = $items[0];
			$tracking['carrier']        = $first['tracking_provider'] ?? $first['custom_tracking_provider'] ?? null;
			$tracking['trackingNumber'] = $first['tracking_number'] ?? null;
			$tracking['trackingUrl']    = $first['custom_tracking_link'] ?? null;
			$tracking['status']         = $order->get_status();
			$date_shipped               = $first['date_shipped'] ?? null;
			$tracking['updatedAt']      = $date_shipped ? gmdate( 'c', (int) $date_shipped ) : null;
		}

		/**
		 * Extension point for shipping/tracking plugins (spec §32).
		 *
		 * @param array     $tracking
		 * @param \WC_Order $order
		 */
		return apply_filters( 'webyar_commerce_tracking_payload', $tracking, $order );
	}
}
