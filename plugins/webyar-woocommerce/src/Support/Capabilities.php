<?php
namespace WebYar\WooCommerce\Support;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Declared connector capabilities and the WordPress capabilities required to
 * manage the connection (spec §78 — admin authorization uses canonical
 * WordPress/WooCommerce capabilities, never menu visibility alone).
 *
 * Two levels, because they guard different things:
 *   - MANAGE_CAPABILITY (manage_woocommerce, which shop managers have): the
 *     day-to-day screen — status, test connection, sync, widget on/off.
 *   - CONNECT_CAPABILITY (manage_options, administrators only): anything that
 *     decides WHICH Web Yar this store trusts — the Web Yar / API URLs,
 *     connect, the pairing callback, disconnect. The Web Yar URL is where the
 *     storefront loads a script from on every page and where plugin updates
 *     are fetched, so a role that cannot install plugins must not set it.
 */
final class Capabilities {

	public const MANAGE_CAPABILITY  = 'manage_woocommerce';
	public const CONNECT_CAPABILITY = 'manage_options';

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

	public static function current_user_can_connect(): bool {
		return current_user_can( self::CONNECT_CAPABILITY );
	}
}
