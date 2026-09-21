<?php
/**
 * Plugin Name:       اتصال‌دهنده‌ی وب‌یار برای ووکامرس
 * Plugin URI:        https://webyar.ai
 * Description:       پل ارتباطی سبک و امن میان فروشگاه ووکامرس شما و دستیار هوش مصنوعی وب‌یار. بدون موتور هوش مصنوعی، بدون ساخت پرامپت، بدون نمایه‌سازی محصولات — فقط داده‌ی نوع‌دار و امضاشده برای محصولات، موجودی، سفارش‌ها و رهگیری مرسوله. تمام هوش مصنوعی روی سرورهای وب‌یار اجرا می‌شود.
 * Version:           1.2.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * WC requires at least: 8.0
 * WC tested up to:   9.4
 * Author:            Web Yar
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       webyar-woocommerce
 * Domain Path:       /languages
 *
 * This plugin is a BRIDGE, not an AI runtime. It never bundles an LLM SDK,
 * never constructs prompts, never builds embeddings/vector search, never
 * runs background AI processing, and never maintains a second large
 * product search index — see docs/commerce/WOOCOMMERCE.md in the Web Yar
 * repository for the full architecture and trust-boundary documentation.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

define( 'WEBYAR_WC_VERSION', '1.2.0' );
define( 'WEBYAR_WC_PROTOCOL_VERSION', 'webyar-commerce/1' );
define( 'WEBYAR_WC_FILE', __FILE__ );
define( 'WEBYAR_WC_DIR', plugin_dir_path( __FILE__ ) );
define( 'WEBYAR_WC_URL', plugin_dir_url( __FILE__ ) );

// Minimal PSR-4-ish autoloader — no Composer dependency for a handful of
// classes (spec §85 — avoid dependency bloat).
spl_autoload_register(
	function ( $class ) {
		$prefix = 'WebYar\\WooCommerce\\';
		if ( strpos( $class, $prefix ) !== 0 ) {
			return;
		}
		$relative = substr( $class, strlen( $prefix ) );
		$path     = WEBYAR_WC_DIR . 'src/' . str_replace( '\\', '/', $relative ) . '.php';
		if ( file_exists( $path ) ) {
			require $path;
		}
	}
);

/**
 * Environment gate. MUST run before touching any WooCommerce class or
 * registering any hook that assumes one exists — an unmet requirement
 * NEVER fatals wp-admin or the storefront (spec §4).
 */
function webyar_wc_environment_ok(): bool {
	if ( version_compare( PHP_VERSION, '7.4', '<' ) ) {
		return false;
	}
	global $wp_version;
	if ( $wp_version && version_compare( $wp_version, '6.0', '<' ) ) {
		return false;
	}
	if ( ! class_exists( 'WooCommerce' ) ) {
		return false;
	}
	if ( defined( 'WC_VERSION' ) && version_compare( WC_VERSION, '8.0', '<' ) ) {
		return false;
	}
	return true;
}

function webyar_wc_environment_notice(): void {
	if ( webyar_wc_environment_ok() ) {
		return;
	}
	echo '<div class="notice notice-error"><p>' .
		esc_html__(
			'افزونه‌ی اتصال‌دهنده‌ی وب‌یار برای ووکامرس نیاز به PHP نسخه‌ی ۷.۴ به بالا، وردپرس ۶.۰ به بالا و ووکامرس ۸.۰ به بالا (فعال) دارد. تا زمانی که این پیش‌نیازها فراهم نشوند، افزونه غیرفعال می‌ماند — فروشگاه شما تحت تأثیر قرار نمی‌گیرد.',
			'webyar-woocommerce'
		) .
		'</p></div>';
}
add_action( 'admin_notices', 'webyar_wc_environment_notice' );

add_action(
	'before_woocommerce_init',
	function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
				'custom_order_tables',
				WEBYAR_WC_FILE,
				true
			);
		}
	}
);

add_action(
	'plugins_loaded',
	function () {
		if ( ! webyar_wc_environment_ok() ) {
			return;
		}
		load_plugin_textdomain( 'webyar-woocommerce', false, dirname( plugin_basename( WEBYAR_WC_FILE ) ) . '/languages' );
		\WebYar\WooCommerce\Plugin::instance()->boot();
	},
	20 // after WooCommerce (10) and Action Scheduler.
);

register_activation_hook(
	WEBYAR_WC_FILE,
	function () {
		if ( is_multisite() && ! defined( 'WEBYAR_WC_MULTISITE_SUPPORTED' ) ) {
			// Network activation is not supported in this release (spec §56)
			// — each blog must install/activate/pair independently so no
			// installation credential is ever shared across sites.
			if ( function_exists( 'is_network_admin' ) && is_network_admin() ) {
				deactivate_plugins( plugin_basename( WEBYAR_WC_FILE ) );
				wp_die(
					esc_html__(
						'افزونه‌ی اتصال‌دهنده‌ی وب‌یار برای ووکامرس از فعال‌سازی شبکه‌ای پشتیبانی نمی‌کند. لطفاً آن را به‌صورت جداگانه در هر سایت فعال کنید.',
						'webyar-woocommerce'
					)
				);
			}
		}
	}
);

register_deactivation_hook(
	WEBYAR_WC_FILE,
	function () {
		if ( class_exists( \WebYar\WooCommerce\Events\EventQueue::class ) ) {
			\WebYar\WooCommerce\Events\EventQueue::cancel_all();
		}
	}
);
