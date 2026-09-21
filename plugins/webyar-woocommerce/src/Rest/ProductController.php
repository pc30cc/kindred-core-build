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

	/** Reviews are context for an answer, not a feed — a handful is enough. */
	private const MAX_REVIEWS = 10;

	/** Private wc_get_products() query var consumed by apply_price_range(). */
	private const PRICE_RANGE_QUERY_VAR = 'webyar_price_range';

	/**
	 * Registered once from Plugin::boot() — teaches wc_get_products() the
	 * price-range query var used by search().
	 */
	public static function register_query_filters(): void {
		add_filter( 'woocommerce_product_data_store_cpt_get_products_query', array( __CLASS__, 'apply_price_range' ), 10, 2 );
	}

	/**
	 * Translates PRICE_RANGE_QUERY_VAR into the `_price` meta comparison
	 * WP_Query actually runs. Appends to any meta_query WooCommerce (or
	 * another plugin) already built rather than replacing it.
	 *
	 * @param array<string,mixed> $wp_query_args
	 * @param array<string,mixed> $query_vars
	 * @return array<string,mixed>
	 */
	public static function apply_price_range( array $wp_query_args, array $query_vars ): array {
		$range = $query_vars[ self::PRICE_RANGE_QUERY_VAR ] ?? null;
		if ( ! is_array( $range ) || ! $range ) {
			return $wp_query_args;
		}
		if ( ! isset( $wp_query_args['meta_query'] ) || ! is_array( $wp_query_args['meta_query'] ) ) {
			$wp_query_args['meta_query'] = array(); // phpcs:ignore
		}
		if ( isset( $range['min'] ) ) {
			$wp_query_args['meta_query'][] = array( 'key' => '_price', 'value' => (float) $range['min'], 'compare' => '>=', 'type' => 'NUMERIC' );
		}
		if ( isset( $range['max'] ) ) {
			$wp_query_args['meta_query'][] = array( 'key' => '_price', 'value' => (float) $range['max'], 'compare' => '<=', 'type' => 'NUMERIC' );
		}
		return $wp_query_args;
	}

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
		// WC_Product_Query has no `meta_query` query var, so handing one to
		// wc_get_products() is silently dropped and the price filter never
		// narrows anything. Pass a private query var instead and translate
		// it in apply_price_range() below, which is WooCommerce's canonical
		// extension point for exactly this.
		$min_price = $request->get_param( 'min_price' );
		$max_price = $request->get_param( 'max_price' );
		$range     = array();
		if ( null !== $min_price && '' !== $min_price ) {
			$range['min'] = (float) $min_price;
		}
		if ( null !== $max_price && '' !== $max_price ) {
			$range['max'] = (float) $max_price;
		}
		if ( $range ) {
			$args[ self::PRICE_RANGE_QUERY_VAR ] = $range;
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

	public static function reviews_schema(): array {
		return array(
			'product_id' => array( 'type' => 'string', 'required' => true ),
			'limit'      => array( 'type' => 'integer', 'required' => false ),
		);
	}

	/**
	 * Approved customer reviews for one product, newest first.
	 *
	 * Asked «نظرات در مورد این محصول چیه», the assistant could only answer
	 * that it had no access to review data — and it was telling the truth:
	 * nothing in this plugin ever sent a rating or a review, so a shop with
	 * dozens of them looked like a shop with none.
	 *
	 * Only APPROVED reviews leave the store, and only the display name the
	 * reviewer already appears under on the public product page — never the
	 * commenter's email, IP or user id. This is the same data any visitor
	 * can read by scrolling, not a new disclosure.
	 */
	public function reviews( \WP_REST_Request $request ): \WP_REST_Response {
		$product_id = (int) $request->get_param( 'product_id' );
		$limit      = min( max( (int) $request->get_param( 'limit' ) ?: 5, 1 ), self::MAX_REVIEWS );

		$product = wc_get_product( $product_id );
		if ( ! $product instanceof \WC_Product ) {
			return new \WP_REST_Response( array( 'found' => false ), 404 );
		}

		$comments = get_comments( array(
			'post_id' => $product_id,
			'type'    => 'review',
			'status'  => 'approve',
			'number'  => $limit,
			'orderby' => 'comment_date_gmt',
			'order'   => 'DESC',
		) );

		$reviews = array();
		foreach ( $comments as $c ) {
			$rating = get_comment_meta( $c->comment_ID, 'rating', true );
			$reviews[] = array(
				'author'   => $c->comment_author,
				'rating'   => '' === $rating ? null : (int) $rating,
				'verified' => (bool) get_comment_meta( $c->comment_ID, 'verified', true ),
				'date'     => gmdate( 'c', strtotime( $c->comment_date_gmt ) ),
				// Bounded: a review is evidence for an answer, not an article.
				'text'     => wp_trim_words( wp_strip_all_tags( $c->comment_content ), 60, '…' ),
			);
		}

		return new \WP_REST_Response(
			array(
				'found'          => true,
				'product_id'     => (string) $product_id,
				'average_rating' => (string) $product->get_average_rating(),
				'review_count'   => (int) $product->get_review_count(),
				'reviews'        => $reviews,
			),
			200
		);
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
