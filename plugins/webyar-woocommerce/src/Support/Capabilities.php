<?php
namespace WebYar\WooCommerce\Support;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Declared connector capabilities and the WordPress capability required to
 * manage the connection (spec §78 — admin authorization uses canonical
 * WordPress/WooCommerce capabilities, never menu visibility alone).
 */
final class Capabilities {

	public const MANAGE_CAPABILITY = 'manage_woocommerce';

	/** @return string[] */
	public static function declared(): array {
		return array(
			'store.read',
			'products.read',
			'catalog.export',
			'availability.read',
			'reviews.read',
			'orders.read',
			'tracking.read',
			'customer_context',
			'events.push',
			'widget.bootstrap',
		);
	}

	public static function current_user_can_manage(): bool {
		return current_user_can( self::MANAGE_CAPABILITY );
	}
}
