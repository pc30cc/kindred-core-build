<?php
namespace WebYar\WooCommerce\Rest;

use WebYar\WooCommerce\Commerce\ProductReader;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Paginated, bounded catalog export for initial/incremental sync
 * (docs/commerce/CONNECTOR_PROTOCOL.md §Sync). Never a full unbounded dump.
 */
final class CatalogController {

	private const MAX_PER_PAGE = 100;
	private const DEFAULT_PER_PAGE = 50;

	public function export( \WP_REST_Request $request ): \WP_REST_Response {
		$page          = max( 1, (int) $request->get_param( 'page' ) ?: 1 );
		$per_page      = min( max( (int) $request->get_param( 'per_page' ) ?: self::DEFAULT_PER_PAGE, 1 ), self::MAX_PER_PAGE );
		$modified_after = $request->get_param( 'modified_after' );

		$args = array(
			'status'   => 'publish',
			'limit'    => $per_page,
			'page'     => $page,
			'orderby'  => 'ID',
			'order'    => 'ASC',
			'paginate' => true,
			'return'   => 'ids',
		);
		if ( $modified_after ) {
			$args['date_modified'] = '>' . strtotime( (string) $modified_after );
		}

		$result   = wc_get_products( $args );
		$ids      = is_object( $result ) ? $result->products : $result;
		$products = array();
		foreach ( $ids as $id ) {
			$product = wc_get_product( $id );
			if ( $product instanceof \WC_Product ) {
				$products[] = ProductReader::to_canonical( $product );
			}
		}

		$total_pages = is_object( $result ) ? (int) $result->max_num_pages : ( count( $ids ) === $per_page ? $page + 1 : $page );

		return new \WP_REST_Response(
			array(
				'products' => $products,
				'page'     => $page,
				'per_page' => $per_page,
				'has_more' => $page < $total_pages,
			),
			200
		);
	}
}
