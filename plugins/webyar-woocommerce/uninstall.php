<?php
/**
 * Uninstall cleanup (spec §55). Removes ONLY plugin-owned state: options,
 * scheduled Action Scheduler jobs, transients (including the replay-guard
 * nonce cache), and the locally stored encrypted installation credential.
 *
 * NEVER touches WooCommerce's own product/order data.
 *
 * If Web Yar cannot be reached during uninstall, local secret deletion
 * still proceeds unconditionally — the server-side installation is left to
 * go stale via last_seen_at and expires per Web Yar's own retention policy.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

global $wpdb;

delete_option( 'webyar_wc_installation' );
delete_option( 'webyar_wc_settings' );
delete_option( 'webyar_wc_pairing_state' );
delete_option( 'webyar_wc_dead_letters' );
delete_option( 'webyar_wc_update_status' );

if ( function_exists( 'as_unschedule_all_actions' ) ) {
	// Hook only — see Events/EventQueue::cancel_all(). The
	// ( hook, array(), group ) form matches only actions with empty args and
	// would leave every queued delivery scheduled after the plugin's code is
	// gone.
	as_unschedule_all_actions( 'webyar_wc_deliver_event' );
}

// Replay-guard nonce transients — pattern-matched delete, this plugin's
// only transient family.
$wpdb->query(
	$wpdb->prepare(
		"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
		$wpdb->esc_like( '_transient_webyar_wc_nonce_' ) . '%',
		$wpdb->esc_like( '_transient_timeout_webyar_wc_nonce_' ) . '%'
	)
);
