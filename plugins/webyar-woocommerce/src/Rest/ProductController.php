<?php
namespace WebYar\WooCommerce\Rest;

use WebYar\WooCommerce\Commerce\ProductReader;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Product search/resolve/availability. Structured filters are plain
 * WooCommerce product-query args — price/stock are NEVER inferred
 * semantically (spec §23).
 */
final class ProductController {

	private const MAX_LIMIT = 20;

	public static function search_schema(): array {
		return array(
			'text'          => array( 'type' => 'string', 'required' => false ),
			'min_price'     => array( 'type' => array( 'string', 'null' ), 'required' => false ),
			'max_price'     => array( 'type' => array( 'string', 'null' ), 'required' => false ),
			'in_stock_only' => array( 'type' => 'boolean', 'required' => false ),
			'category_slug' => array( 'type' => array( 'string', 'null' ), 'required' => false ),
			'attributes'    => array( 'type' => array( 'object', 'null' ), 'required' => false ),
			'limit'         => array( 'type' => 'integer', 'required' => false ),
			'cursor'        => array( 'type' => array( 'string', 'null' ), 'required' => false ),
		);
	}

	public static function resolve_schema(): array {
		return array( 'ids' => array( 'type' => 'array', 'required' => true ) );
	}

	public static function availability_schema(): array {
		return array(
			'product_id' => array( 'type' => 'string', 'required' => true ),
			'variant_id' => array( 'type' => array( 'string', 'null' ), 'required' => false ),
		);
	}

	public function search( \WP_REST_Request $request ): \WP_REST_Response {
		$limit = min( max( (int) $request->get_param( 'limit' ) ?: 8, 1 ), self::MAX_LIMIT );

		$args = array(
			'status'   => 'publish',
			'limit'    => $limit,
			'paginate' => false,
		);
		if ( $text = $request->get_param( 'text' ) ) {
			$args['s'] = sanitize_text_field( $text );
		}
		$min_price = $request->get_param( 'min_price' );
		$max_price = $request->get_param( 'max_price' );
		if ( null !== $min_price || null !== $max_price ) {
			$args['meta_query'] = array(); // phpcs:ignore
			if ( null !== $min_price ) {
				$args['meta_query'][] = array( 'key' => '_price', 'value' => (float) $min_price, 'compare' => '>=', 'type' => 'NUMERIC' );
			}
			if ( null !== $max_price ) {
				$args['meta_query'][] = array( 'key' => '_price', 'value' => (float) $max_price, 'compare' => '<=', 'type' => 'NUMERIC' );
			}
		}
		if ( $category = $request->get_param( 'category_slug' ) ) {
			$args['category'] = array( sanitize_title( $category ) );
		}
		if ( $request->get_param( 'in_stock_only' ) ) {
			$args['stock_status'] = 'instock';
		}

		$attributes = $request->get_param( 'attributes' );
		if ( is_array( $attributes ) ) {
			foreach ( $attributes as $name => $value ) {
				$taxonomy = wc_attribute_taxonomy_name( sanitize_title( $name ) );
				if ( taxonomy_exists( $taxonomy ) ) {
					$args['tax_query'][] = array( // phpcs:ignore
						'taxonomy' => $taxonomy,
						'field'    => 'name',
						'terms'    => sanitize_text_field( $value ),
					);
				}
			}
		}

		$products = wc_get_products( $args );
		$payload  = array_map( array( ProductReader::class, 'to_canonical' ), $products );

		return new \WP_REST_Response(
			array(
				'catalog_ready' => true,
				'products'      => $payload,
				'next_cursor'   => null, // Phase 1: single-page bounded search results
				'total_matched' => count( $payload ),
			),
			200
		);
	}

	public function resolve( \WP_REST_Request $request ): \WP_REST_Response {
		$ids = array_slice( (array) $request->get_param( 'ids' ), 0, self::MAX_LIMIT );
		$products = array();
		foreach ( $ids as $id ) {
			$product = wc_get_product( (int) $id );
			if ( $product instanceof \WC_Product ) {
				$products[] = ProductReader::to_canonical( $product );
			}
		}
		return new \WP_REST_Response( array( 'products' => $products ), 200 );
	}

	public function availability( \WP_REST_Request $request ): \WP_REST_Response {
		$product_id = (int) $request->get_param( 'product_id' );
		$variant_id = $request->get_param( 'variant_id' );

		$target = $variant_id ? wc_get_product( (int) $variant_id ) : wc_get_product( $product_id );
		if ( ! $target instanceof \WC_Product ) {
			return new \WP_REST_Response( array( 'found' => false ), 404 );
		}

		return new \WP_REST_Response(
			array(
				'found'           => true,
				'stock_state'     => $target->is_on_backorder() ? 'backorder' : ( $target->is_in_stock() ? 'in_stock' : 'out_of_stock' ),
				'stock_quantity'  => $target->managing_stock() ? $target->get_stock_quantity() : null,
				'effective_price' => (string) $target->get_price(),
				'currency'        => get_woocommerce_currency(),
			),
			200
		);
	}
}
