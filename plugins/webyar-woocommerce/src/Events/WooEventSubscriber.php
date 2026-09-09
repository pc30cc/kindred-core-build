<?php
namespace WebYar\WooCommerce\Events;

use WebYar\WooCommerce\Commerce\ProductReader;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Woo hook → construct minimal event → enqueue job → request ends
 * (spec §15). Every handler here does ZERO network I/O — only
 * EventQueue::enqueue(), which itself is a single Action Scheduler insert.
 * Checkout/save/stock-update hooks are never slowed down by Web Yar.
 */
final class WooEventSubscriber {

	public function register(): void {
		add_action( 'woocommerce_new_product', array( $this, 'on_product_created' ), 20 );
		add_action( 'woocommerce_update_product', array( $this, 'on_product_updated' ), 20 );
		add_action( 'wp_trash_post', array( $this, 'on_product_maybe_deleted' ) );
		add_action( 'before_delete_post', array( $this, 'on_product_maybe_deleted' ) );

		add_action( 'woocommerce_save_product_variation', array( $this, 'on_variation_saved' ), 20, 1 );
		add_action( 'woocommerce_variation_before_set_stock', array( $this, 'on_variation_stock_changing' ), 10, 1 );

		add_action( 'woocommerce_product_set_stock', array( $this, 'on_stock_changed' ) );
		add_action( 'woocommerce_variation_set_stock', array( $this, 'on_variation_stock_changed' ) );

		add_action( 'woocommerce_new_order', array( $this, 'on_order_created' ) );
		add_action( 'woocommerce_update_order', array( $this, 'on_order_updated' ) );
		add_action( 'woocommerce_order_status_changed', array( $this, 'on_order_status_changed' ), 10, 3 );
	}

	public function on_product_created( int $product_id ): void {
		$this->enqueue_product_event( 'product.created', $product_id );
	}

	public function on_product_updated( int $product_id ): void {
		$this->enqueue_product_event( 'product.updated', $product_id );
	}

	public function on_product_maybe_deleted( int $post_id ): void {
		if ( 'product' !== get_post_type( $post_id ) ) {
			return;
		}
		EventQueue::enqueue( 'product.deleted', (string) $post_id, gmdate( 'c' ), array( 'externalId' => (string) $post_id ) );
	}

	public function on_variation_saved( int $variation_id ): void {
		$variation = wc_get_product( $variation_id );
		if ( ! $variation instanceof \WC_Product_Variation ) {
			return;
		}
		$payload                       = ProductReader::variant_to_canonical( $variation );
		$payload['parentExternalId']   = (string) $variation->get_parent_id();
		EventQueue::enqueue( 'variation.updated', (string) $variation_id, $payload['updatedAt'], $payload );
	}

	public function on_variation_stock_changing( \WC_Product $variation ): void {
		// Placeholder hook retained for symmetry with on_stock_changed's
		// signature; the AFTER hooks below (woocommerce_variation_set_stock)
		// are what actually carry the new value.
	}

	public function on_stock_changed( \WC_Product $product ): void {
		if ( $product->is_type( 'variation' ) ) {
			return; // handled by on_variation_stock_changed
		}
		$payload = ProductReader::to_canonical( $product );
		EventQueue::enqueue( 'stock.changed', (string) $product->get_id(), $payload['updatedAt'], $payload );
	}

	public function on_variation_stock_changed( \WC_Product_Variation $variation ): void {
		$payload                     = ProductReader::variant_to_canonical( $variation );
		$payload['parentExternalId'] = (string) $variation->get_parent_id();
		$payload['variantExternalId'] = (string) $variation->get_id();
		EventQueue::enqueue( 'stock.changed', (string) $variation->get_id(), $payload['updatedAt'], $payload );
	}

	public function on_order_created( int $order_id ): void {
		$this->enqueue_order_event( 'order.created', $order_id );
	}

	public function on_order_updated( int $order_id ): void {
		$this->enqueue_order_event( 'order.updated', $order_id );
	}

	public function on_order_status_changed( int $order_id, string $from, string $to ): void {
		EventQueue::enqueue(
			'order.status_changed',
			(string) $order_id,
			gmdate( 'c' ),
			array( 'externalId' => (string) $order_id, 'from' => $from, 'to' => $to )
		);
	}

	private function enqueue_product_event( string $type, int $product_id ): void {
		$product = wc_get_product( $product_id );
		if ( ! $product instanceof \WC_Product ) {
			return;
		}
		$payload = ProductReader::to_canonical( $product );
		EventQueue::enqueue( $type, (string) $product_id, $payload['updatedAt'], $payload );
	}

	/**
	 * Order events carry ONLY minimal metadata — never full PII (spec §16,
	 * §31). Web Yar fetches full order detail live, post-authorization,
	 * through /wp-json/webyar/v1/orders/lookup when it actually needs it.
	 */
	private function enqueue_order_event( string $type, int $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof \WC_Order ) {
			return;
		}
		EventQueue::enqueue(
			$type,
			(string) $order_id,
			$order->get_date_modified() ? $order->get_date_modified()->date( 'c' ) : gmdate( 'c' ),
			array( 'externalId' => (string) $order_id, 'status' => $order->get_status() )
		);
	}
}
