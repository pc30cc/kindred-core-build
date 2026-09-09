<?php
namespace WebYar\WooCommerce\Commerce;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Normalizes WooCommerce products into the canonical CommerceProduct shape
 * (shared/commerce/types.ts on the Web Yar side). Uses ONLY official CRUD
 * APIs (wc_get_product, WC_Product, WC_Product_Variation) — never direct
 * wp_posts/wp_postmeta queries (spec §4 — HPOS compatibility by
 * construction).
 */
final class ProductReader {

	private const MAX_VARIANTS      = 50;
	private const SHORT_DESC_LENGTH = 500;

	public static function to_canonical( \WC_Product $product ): array {
		$currency = get_woocommerce_currency();

		$data = array(
			'externalId'        => (string) $product->get_id(),
			'type'              => self::map_type( $product ),
			'sku'               => $product->get_sku() ?: null,
			'title'             => wp_strip_all_tags( $product->get_name() ),
			'shortDescription'  => self::bounded_text( $product->get_short_description() ?: $product->get_description() ),
			'canonicalUrl'      => get_permalink( $product->get_id() ) ?: null,
			'imageUrl'          => self::image_url( $product ),
			'currency'          => $currency,
			'regularPrice'      => self::money( $product->get_regular_price(), $currency ),
			'salePrice'         => $product->is_on_sale() ? self::money( $product->get_sale_price(), $currency ) : null,
			'effectivePrice'    => self::money( $product->get_price(), $currency ),
			'stockState'        => self::stock_state( $product ),
			'stockQuantity'     => $product->managing_stock() ? $product->get_stock_quantity() : null,
			'categories'        => self::taxonomy_terms( $product->get_id(), 'product_cat' ),
			'tags'              => self::taxonomy_terms( $product->get_id(), 'product_tag' ),
			'attributes'        => self::attributes( $product ),
			'variants'          => array(),
			'isVirtual'         => $product->is_virtual(),
			'isDownloadable'    => $product->is_downloadable(),
			'updatedAt'         => self::updated_at( $product ),
		);

		if ( $product->is_type( 'variable' ) && $product instanceof \WC_Product_Variable ) {
			$variation_ids = $product->get_children();
			foreach ( array_slice( $variation_ids, 0, self::MAX_VARIANTS ) as $variation_id ) {
				$variation = wc_get_product( $variation_id );
				if ( $variation instanceof \WC_Product_Variation ) {
					$data['variants'][] = self::variant_to_canonical( $variation, $currency );
				}
			}
		}

		/**
		 * Extension point — third parties may enrich (never replace secrets
		 * into) the outgoing product payload.
		 *
		 * @param array       $data
		 * @param \WC_Product $product
		 */
		return apply_filters( 'webyar_commerce_product_payload', $data, $product );
	}

	public static function variant_to_canonical( \WC_Product_Variation $variation, ?string $currency = null ): array {
		$currency = $currency ?: get_woocommerce_currency();
		$attributes = array();
		foreach ( $variation->get_variation_attributes( false ) as $attr_name => $value ) {
			$clean = preg_replace( '/^attribute_/', '', $attr_name );
			$attributes[ wc_attribute_label( $clean ) ] = wc_attribute_label( $value ) ?: $value;
		}

		// Variant stock is NEVER assumed equal to the parent product's stock
		// (spec §13) — WC_Product_Variation carries its own stock state.
		return array(
			'externalId'     => (string) $variation->get_id(),
			'sku'            => $variation->get_sku() ?: null,
			'attributes'     => $attributes,
			'regularPrice'   => self::money( $variation->get_regular_price(), $currency ),
			'salePrice'      => $variation->is_on_sale() ? self::money( $variation->get_sale_price(), $currency ) : null,
			'effectivePrice' => self::money( $variation->get_price(), $currency ),
			'stockState'     => self::stock_state( $variation ),
			'stockQuantity'  => $variation->managing_stock() ? $variation->get_stock_quantity() : null,
			'imageUrl'       => self::image_url( $variation ),
			'updatedAt'      => self::updated_at( $variation ),
		);
	}

	private static function map_type( \WC_Product $product ): string {
		if ( $product->is_type( 'variable' ) ) {
			return 'variable';
		}
		if ( $product->is_type( 'grouped' ) ) {
			return 'grouped';
		}
		if ( $product->is_type( 'external' ) ) {
			return 'external';
		}
		return 'simple';
	}

	private static function stock_state( \WC_Product $product ): string {
		if ( $product->is_on_backorder() ) {
			return 'backorder';
		}
		if ( $product->is_in_stock() ) {
			return 'in_stock';
		}
		if ( false === $product->is_in_stock() ) {
			return 'out_of_stock';
		}
		return 'unknown';
	}

	private static function money( $amount, string $currency ): ?array {
		if ( '' === $amount || null === $amount ) {
			return null;
		}
		// WooCommerce returns a decimal-string price; the store's own
		// minor-unit convention is passed through as-is — never re-based to
		// USD cents (spec §68/§69).
		return array(
			'amountMinor' => (string) $amount,
			'currency'    => $currency,
		);
	}

	private static function image_url( \WC_Product $product ): ?string {
		$image_id = $product->get_image_id();
		if ( ! $image_id ) {
			return null;
		}
		$url = wp_get_attachment_image_url( $image_id, 'medium' );
		return $url ?: null;
	}

	private static function bounded_text( string $html ): ?string {
		$text = trim( wp_strip_all_tags( $html ) );
		if ( '' === $text ) {
			return null;
		}
		return mb_substr( $text, 0, self::SHORT_DESC_LENGTH );
	}

	private static function taxonomy_terms( int $product_id, string $taxonomy ): array {
		$terms = get_the_terms( $product_id, $taxonomy );
		if ( ! is_array( $terms ) ) {
			return array();
		}
		return array_map(
			static fn( $term ) => array(
				'id'   => (string) $term->term_id,
				'name' => $term->name,
				'slug' => $term->slug,
			),
			array_slice( $terms, 0, 20 )
		);
	}

	private static function attributes( \WC_Product $product ): array {
		$result = array();
		foreach ( $product->get_attributes() as $attribute ) {
			if ( ! $attribute instanceof \WC_Product_Attribute ) {
				continue;
			}
			$values = $attribute->is_taxonomy()
				? wp_list_pluck( $attribute->get_terms() ?: array(), 'name' )
				: $attribute->get_options();
			$result[] = array(
				'name'              => wc_attribute_label( $attribute->get_name() ),
				'values'            => array_slice( array_map( 'strval', $values ), 0, 30 ),
				'usedForVariations' => $attribute->get_variation(),
			);
		}
		return array_slice( $result, 0, 20 );
	}

	private static function updated_at( \WC_Product $product ): string {
		$date = $product->get_date_modified();
		return $date ? $date->getTimestamp() === 0 ? gmdate( 'c' ) : gmdate( 'c', $date->getTimestamp() ) : gmdate( 'c' );
	}
}
