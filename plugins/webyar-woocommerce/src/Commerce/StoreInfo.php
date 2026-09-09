<?php
namespace WebYar\WooCommerce\Commerce;

use WebYar\WooCommerce\Support\Version;
use WebYar\WooCommerce\Support\Capabilities;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Backs the capability handshake (GET /wp-json/webyar/v1/health). */
final class StoreInfo {

	public static function health_payload(): array {
		return array(
			'protocol_version'    => Version::protocol_version(),
			'connector_version'   => Version::connector_version(),
			'woocommerce_version' => Version::woocommerce_version(),
			'wordpress_version'   => Version::wordpress_version(),
			'hpos_enabled'        => Version::hpos_enabled(),
			'capabilities'        => apply_filters( 'webyar_commerce_capabilities', Capabilities::declared() ),
			'store_name'          => get_bloginfo( 'name' ),
			'store_url'           => home_url( '/' ),
			'currency'            => get_woocommerce_currency(),
			// Catalog readiness is Web Yar's own sync state, not the
			// plugin's — the plugin always answers "ready" for ITS side;
			// the connection row on Web Yar tracks whether the initial
			// sync finished. Kept true here for the plugin's own health
			// self-report only.
			'catalog_ready'       => true,
			'product_count'       => (int) wp_count_posts( 'product' )->publish,
		);
	}
}
