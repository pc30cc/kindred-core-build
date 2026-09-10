<?php
namespace WebYar\WooCommerce\Commerce;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Normalizes WooCommerce orders using ONLY wc_get_order()/WC_Order/
 * WC_Order_Query — HPOS-safe by construction (spec §4). Returns masked
 * contact info by default; full values are never sent unless Web Yar has
 * already authorized the specific request (verified customer/guest).
 */
final class OrderReader {

	public static function find( string $external_id ): ?\WC_Order {
		$order = wc_get_order( (int) $external_id );
		return $order instanceof \WC_Order ? $order : null;
	}

	public static function to_canonical( \WC_Order $order ): array {
		$currency    = $order->get_currency();
		$line_items  = array();
		foreach ( $order->get_items() as $item ) {
			if ( ! $item instanceof \WC_Order_Item_Product ) {
				continue;
			}
			$line_items[] = array(
				'product_id' => $item->get_product_id() ? (string) $item->get_product_id() : null,
				'title'      => wp_strip_all_tags( $item->get_name() ),
				'quantity'   => (int) $item->get_quantity(),
				'total'      => (string) $item->get_total(),
			);
		}

		return array(
			'status'       => self::map_status( $order->get_status() ),
			'currency'     => $currency,
			'total'        => (string) $order->get_total(),
			'created_at'   => $order->get_date_created() ? $order->get_date_created()->date( 'c' ) : null,
			'updated_at'   => $order->get_date_modified() ? $order->get_date_modified()->date( 'c' ) : null,
			'line_items'   => array_slice( $line_items, 0, 30 ),
			'masked_email' => self::mask_email( $order->get_billing_email() ),
			'masked_phone' => self::mask_phone( $order->get_billing_phone() ),
		);
	}

	/** Order status query scoped to a specific customer — HPOS-safe via WC_Order_Query. */
	public static function orders_for_customer( string $external_customer_id, int $limit = 5 ): array {
		$orders = wc_get_orders(
			array(
				'customer_id' => (int) $external_customer_id,
				'limit'       => min( max( $limit, 1 ), 10 ),
				'orderby'     => 'date',
				'order'       => 'DESC',
				'return'      => 'objects',
			)
		);
		return array_map(
			static function ( \WC_Order $order ) {
				return array(
					'external_id' => (string) $order->get_id(),
					'status'      => self::map_status( $order->get_status() ),
					'currency'    => $order->get_currency(),
					'total'       => (string) $order->get_total(),
					'created_at'  => $order->get_date_created() ? $order->get_date_created()->date( 'c' ) : null,
				);
			},
			$orders
		);
	}

	/** Boolean-only contact match — never returns unmasked values (spec §29). */
	public static function contact_matches( \WC_Order $order, ?string $email, ?string $phone ): bool {
		if ( $email ) {
			return hash_equals( strtolower( trim( $order->get_billing_email() ) ), strtolower( trim( $email ) ) );
		}
		if ( $phone ) {
			$normalize = static fn( string $p ) => preg_replace( '/[^0-9]/', '', $p );
			return hash_equals( $normalize( $order->get_billing_phone() ), $normalize( $phone ) );
		}
		return false;
	}

	private static function map_status( string $wc_status ): string {
		$map = array(
			'pending'    => 'pending',
			'processing' => 'processing',
			'on-hold'    => 'on_hold',
			'completed'  => 'completed',
			'cancelled'  => 'cancelled',
			'refunded'   => 'refunded',
			'failed'     => 'failed',
		);
		return $map[ $wc_status ] ?? 'unknown';
	}

	private static function mask_email( string $email ): ?string {
		if ( '' === $email || false === strpos( $email, '@' ) ) {
			return null;
		}
		list( $local, $domain ) = explode( '@', $email, 2 );
		$visible = mb_substr( $local, 0, 2 );
		return $visible . str_repeat( '*', max( 1, mb_strlen( $local ) - 2 ) ) . '@' . $domain;
	}

	private static function mask_phone( string $phone ): ?string {
		$digits = preg_replace( '/[^0-9]/', '', $phone );
		if ( strlen( $digits ) < 4 ) {
			return null;
		}
		return str_repeat( '*', strlen( $digits ) - 4 ) . substr( $digits, -4 );
	}
}
