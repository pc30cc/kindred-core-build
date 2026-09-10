<?php
/**
 * Minimal PHPUnit bootstrap for the pure-logic unit tests only
 * (Auth/RequestSigner, Auth/CredentialStore). These stubs are NOT a
 * WordPress test environment — they exist only so this narrow, dependency-
 * free logic can be verified without a full WP/WooCommerce install.
 *
 * ProductReader/OrderReader/Rest controllers depend on real WC_Product/
 * WC_Order/WP_REST_Request classes and are NOT covered here — they need
 * the actual WooCommerce PHPUnit test framework (wp-env + woocommerce/
 * tests), which is outside what this sandbox can provision. See the
 * engineering report's Known Limitations.
 */

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}

if ( ! defined( 'AUTH_KEY' ) ) {
	define( 'AUTH_KEY', 'test-auth-key-0123456789abcdef' );
}
if ( ! defined( 'SECURE_AUTH_KEY' ) ) {
	define( 'SECURE_AUTH_KEY', 'test-secure-auth-key-0123456789' );
}
if ( ! defined( 'LOGGED_IN_KEY' ) ) {
	define( 'LOGGED_IN_KEY', 'test-logged-in-key-0123456789ab' );
}

$GLOBALS['__webyar_test_options'] = array();

if ( ! function_exists( 'update_option' ) ) {
	function update_option( string $name, $value, $autoload = true ) {
		$GLOBALS['__webyar_test_options'][ $name ] = $value;
		return true;
	}
}
if ( ! function_exists( 'get_option' ) ) {
	function get_option( string $name, $default = false ) {
		return $GLOBALS['__webyar_test_options'][ $name ] ?? $default;
	}
}
if ( ! function_exists( 'delete_option' ) ) {
	function delete_option( string $name ) {
		unset( $GLOBALS['__webyar_test_options'][ $name ] );
		return true;
	}
}
if ( ! function_exists( 'wp_json_encode' ) ) {
	function wp_json_encode( $data ) {
		return json_encode( $data ); // phpcs:ignore
	}
}

require_once __DIR__ . '/../src/Support/Version.php';
require_once __DIR__ . '/../src/Auth/RequestSigner.php';
require_once __DIR__ . '/../src/Auth/CredentialStore.php';
