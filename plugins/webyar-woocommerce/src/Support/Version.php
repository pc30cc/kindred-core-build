<?php
namespace WebYar\WooCommerce\Support;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Version/environment facts used by the health handshake
 * (docs/commerce/CONNECTOR_PROTOCOL.md §Capability handshake).
 */
final class Version {

	public static function connector_version(): string {
		return defined( 'WEBYAR_WC_VERSION' ) ? WEBYAR_WC_VERSION : '0.0.0';
	}

	public static function protocol_version(): string {
		return defined( 'WEBYAR_WC_PROTOCOL_VERSION' ) ? WEBYAR_WC_PROTOCOL_VERSION : 'webyar-commerce/1';
	}

	public static function woocommerce_version(): ?string {
		return defined( 'WC_VERSION' ) ? WC_VERSION : null;
	}

	public static function wordpress_version(): ?string {
		global $wp_version;
		return $wp_version ?? null;
	}

	public static function hpos_enabled(): bool {
		if ( ! class_exists( \Automattic\WooCommerce\Utilities\OrderUtil::class ) ) {
			return false;
		}
		return \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
	}
}
