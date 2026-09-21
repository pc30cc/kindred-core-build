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

// WordPress time constants the Updater's cache TTLs are written in.
if ( ! defined( 'MINUTE_IN_SECONDS' ) ) {
	define( 'MINUTE_IN_SECONDS', 60 );
}
if ( ! defined( 'HOUR_IN_SECONDS' ) ) {
	define( 'HOUR_IN_SECONDS', 3600 );
}

// WordPress helpers the Updater's URL logic leans on. Deliberately the real
// behaviour, not no-ops: the whole point of UpdaterTest is what these return
// for a hostile value, so a stub that shrugs would test nothing.
if ( ! function_exists( 'wp_parse_url' ) ) {
	function wp_parse_url( string $url, int $component = -1 ) {
		return parse_url( $url, $component );
	}
}
if ( ! function_exists( 'untrailingslashit' ) ) {
	function untrailingslashit( string $value ): string {
		return rtrim( $value, '/\\' );
	}
}
if ( ! function_exists( 'trailingslashit' ) ) {
	function trailingslashit( string $value ): string {
		return untrailingslashit( $value ) . '/';
	}
}
if ( ! function_exists( 'esc_url_raw' ) ) {
	function esc_url_raw( string $url ): string {
		return $url;
	}
}
if ( ! function_exists( 'add_filter' ) ) {
	function add_filter( $hook, $callback, $priority = 10, $args = 1 ) { return true; }
}
if ( ! function_exists( 'add_action' ) ) {
	function add_action( $hook, $callback, $priority = 10, $args = 1 ) { return true; }
}

if ( ! defined( 'WEBYAR_WC_VERSION' ) ) {
	define( 'WEBYAR_WC_VERSION', '1.1.0' );
}
if ( ! defined( 'WEBYAR_WC_FILE' ) ) {
	define( 'WEBYAR_WC_FILE', __DIR__ . '/../webyar-woocommerce.php' );
}
if ( ! defined( 'WEBYAR_WC_URL' ) ) {
	define( 'WEBYAR_WC_URL', 'https://shop.example.com/wp-content/plugins/webyar-woocommerce/' );
}
if ( ! function_exists( 'plugin_basename' ) ) {
	function plugin_basename( string $file ): string {
		return 'webyar-woocommerce/webyar-woocommerce.php';
	}
}
if ( ! function_exists( 'wp_kses_post' ) ) {
	function wp_kses_post( string $value ): string {
		return strip_tags( $value, '<p><a><strong><em><ul><li><br><code>' );
	}
}
if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ): bool {
		return $thing instanceof WP_Error;
	}
}
if ( ! class_exists( 'WP_Error' ) ) {
	class WP_Error {
		public $code;
		public function __construct( $code = '' ) { $this->code = $code; }
		public function get_error_code() { return $this->code; }
	}
}
/** The manifest fetch, scripted by each test through $GLOBALS. */
if ( ! function_exists( 'wp_remote_get' ) ) {
	function wp_remote_get( string $url, array $args = array() ) {
		$GLOBALS['__webyar_test_fetched'][] = $url;
		$next = $GLOBALS['__webyar_test_http'] ?? null;
		return $next ?? new WP_Error( 'no_response_scripted' );
	}
}
if ( ! function_exists( 'wp_remote_retrieve_response_code' ) ) {
	function wp_remote_retrieve_response_code( $response ) {
		return is_array( $response ) ? ( $response['response']['code'] ?? 0 ) : 0;
	}
}
if ( ! function_exists( 'wp_remote_retrieve_body' ) ) {
	function wp_remote_retrieve_body( $response ) {
		return is_array( $response ) ? ( $response['body'] ?? '' ) : '';
	}
}
$GLOBALS['__webyar_test_transients'] = array();
if ( ! function_exists( 'get_site_transient' ) ) {
	function get_site_transient( string $key ) {
		return $GLOBALS['__webyar_test_transients'][ $key ] ?? false;
	}
}
if ( ! function_exists( 'set_site_transient' ) ) {
	function set_site_transient( string $key, $value, $ttl = 0 ): bool {
		$GLOBALS['__webyar_test_transients'][ $key ] = $value;
		return true;
	}
}
if ( ! function_exists( 'delete_site_transient' ) ) {
	function delete_site_transient( string $key ): bool {
		unset( $GLOBALS['__webyar_test_transients'][ $key ] );
		return true;
	}
}
if ( ! function_exists( 'apply_filters' ) ) {
	function apply_filters( string $hook, $value ) { return $value; }
}

// Style registration, recorded rather than performed — what the plugins
// screen test asserts is which CSS was handed to WordPress.
$GLOBALS['__webyar_test_styles'] = array();
if ( ! function_exists( 'wp_register_style' ) ) {
	function wp_register_style( string $handle, $src, array $deps = array(), $ver = false ): bool {
		$GLOBALS['__webyar_test_styles'][ $handle ] = array( 'src' => $src, 'inline' => array() );
		return true;
	}
}
if ( ! function_exists( 'wp_enqueue_style' ) ) {
	function wp_enqueue_style( string $handle ): void {
		$GLOBALS['__webyar_test_styles'][ $handle ]['enqueued'] = true;
	}
}
if ( ! function_exists( 'wp_add_inline_style' ) ) {
	function wp_add_inline_style( string $handle, string $css ): bool {
		$GLOBALS['__webyar_test_styles'][ $handle ]['inline'][] = $css;
		return true;
	}
}
if ( ! function_exists( '__' ) ) {
	function __( string $text, string $domain = '' ): string { return $text; }
}

require_once __DIR__ . '/../src/Support/Version.php';
require_once __DIR__ . '/../src/Auth/RequestSigner.php';
require_once __DIR__ . '/../src/Auth/CredentialStore.php';
require_once __DIR__ . '/../src/Auth/PairingService.php';
require_once __DIR__ . '/../src/Support/Updater.php';
require_once __DIR__ . '/../src/Admin/PluginsScreen.php';
