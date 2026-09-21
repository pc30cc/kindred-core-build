<?php
namespace WebYar\WooCommerce\Admin;

use WebYar\WooCommerce\Support\Updater;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The Web Yar logo on Plugins → Installed Plugins.
 *
 * WordPress draws no icon on that screen — the list table prints the plugin
 * name and nothing else — so the row is STYLED rather than re-rendered. The
 * list table already labels every row with the plugin file it belongs to
 * (`<tr data-plugin="…">`), which is a stable, exact handle: no markup is
 * replaced, no row action is touched, and the screen keeps behaving exactly
 * as WordPress built it. If the rule ever stops matching, the row simply
 * looks the way it did before.
 *
 * The image is the copy installed in this plugin's own assets folder, so it
 * costs no network request and cannot be pointed anywhere by anything the
 * store fetches.
 *
 * Loaded ONLY on the plugins screen — a stylesheet on every admin page for
 * a decoration on one of them is not a trade worth making.
 */
final class PluginsScreen {

	private const HANDLE = 'webyar-wc-plugins-row';

	public function register(): void {
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue' ) );
	}

	/** @param mixed $hook_suffix */
	public function enqueue( $hook_suffix ): void {
		if ( ! self::is_plugins_screen( (string) $hook_suffix ) ) {
			return;
		}
		$css = self::css( plugin_basename( WEBYAR_WC_FILE ), self::icon_url() );
		if ( '' === $css ) {
			return;
		}
		// A handle with no file of its own — the documented way to attach
		// inline CSS that is computed rather than shipped.
		wp_register_style( self::HANDLE, false, array(), WEBYAR_WC_VERSION );
		wp_enqueue_style( self::HANDLE );
		wp_add_inline_style( self::HANDLE, $css );
	}

	/** Network admin appends "-network" to the same screen. */
	public static function is_plugins_screen( string $hook_suffix ): bool {
		return in_array( $hook_suffix, array( 'plugins.php', 'plugins.php-network' ), true );
	}

	/**
	 * Both values are produced locally, but they are still interpolated into
	 * a stylesheet, so they are filtered to what a plugin path and a URL can
	 * contain. Quotes, backslashes, braces, angle brackets and whitespace are
	 * DROPPED rather than escaped: there is no version of them that belongs
	 * here, and dropping cannot be undone by a later escaping round.
	 */
	public static function css( string $basename, string $icon_url ): string {
		$basename = self::css_safe( $basename );
		$icon_url = self::css_safe( esc_url_raw( $icon_url ) );
		if ( '' === $basename || '' === $icon_url ) {
			return '';
		}

		return sprintf(
			'.plugins tr[data-plugin="%1$s"] .plugin-title strong::before{' .
				'content:"";display:inline-block;width:28px;height:28px;' .
				'margin-inline-end:9px;vertical-align:middle;border-radius:6px;' .
				'background-image:url("%2$s");background-size:cover;background-position:center;' .
				'box-shadow:0 1px 2px rgba(0,0,0,.18);' .
			'}',
			$basename,
			$icon_url
		);
	}

	private static function css_safe( string $value ): string {
		return (string) preg_replace( '#[^A-Za-z0-9\-._~:/?\#\[\]@!$&*+,;=%]#', '', $value );
	}

	/** The same artwork WordPress is handed for the update screens. */
	public static function icon_url(): string {
		return Updater::icons()['1x'];
	}
}
