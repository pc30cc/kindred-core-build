<?php
namespace WebYar\WooCommerce\Commerce;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Thin wrapper over WC_Customer for the currently logged-in storefront visitor. */
final class CustomerReader {

	/** Returns the current visitor's WooCommerce customer id, or null if not logged in. */
	public static function current_customer_id(): ?string {
		$user_id = get_current_user_id();
		if ( ! $user_id ) {
			return null;
		}
		return (string) $user_id;
	}
}
