<?php
/**
 * The Web Yar logo in the store's installed-plugins list.
 *
 * WordPress draws no icon on that screen, so the connector styles its own
 * row instead of re-rendering it — one rule, keyed to the `data-plugin`
 * attribute the list table already writes. Two things have to hold: the
 * rule loads on the plugins screen and nowhere else, and nothing
 * interpolated into it can escape the rule it sits in.
 */

use PHPUnit\Framework\TestCase;
use WebYar\WooCommerce\Admin\PluginsScreen;

final class PluginsScreenTest extends TestCase {

	/** @return array<string,mixed> */
	private function enqueue( string $hook_suffix ): array {
		$GLOBALS['__webyar_test_styles'] = array();
		( new PluginsScreen() )->enqueue( $hook_suffix );
		return $GLOBALS['__webyar_test_styles'];
	}

	private function inline( string $hook_suffix ): string {
		$css = '';
		foreach ( $this->enqueue( $hook_suffix ) as $style ) {
			$css .= implode( '', $style['inline'] );
		}
		return $css;
	}

	public function test_it_styles_the_row_wordpress_already_labelled(): void {
		$css = $this->inline( 'plugins.php' );
		$this->assertStringContainsString( 'tr[data-plugin="webyar-woocommerce/webyar-woocommerce.php"]', $css );
		$this->assertStringContainsString( '.plugin-title strong::before', $css );
	}

	public function test_it_draws_the_copy_shipped_with_the_plugin(): void {
		// No network request, and no URL anything fetched can influence.
		$this->assertStringContainsString(
			'url("' . WEBYAR_WC_URL . 'assets/icon-128x128.png")',
			$this->inline( 'plugins.php' )
		);
	}

	public function test_the_logo_follows_the_text_direction(): void {
		// A plain margin-right would put it on the wrong side of an RTL
		// admin — the side every store running this plugin actually sees.
		$css = $this->inline( 'plugins.php' );
		$this->assertStringContainsString( 'margin-inline-end', $css );
		$this->assertStringNotContainsString( 'margin-right', $css );
		$this->assertStringNotContainsString( 'margin-left', $css );
	}

	public function test_it_loads_on_the_plugins_screen_only(): void {
		$this->assertSame( array( 'webyar-wc-plugins-row' ), array_keys( $this->enqueue( 'plugins.php' ) ) );
		$this->assertSame( array( 'webyar-wc-plugins-row' ), array_keys( $this->enqueue( 'plugins.php-network' ) ) );

		foreach ( array( 'index.php', 'toplevel_page_webyar-woocommerce', 'post.php', '' ) as $elsewhere ) {
			$this->assertSame( array(), array_keys( $this->enqueue( $elsewhere ) ), $elsewhere );
		}
	}

	public function test_nothing_interpolated_can_escape_the_rule(): void {
		// Neither value is attacker-controlled today — both come from the
		// local install — but this is CSS built by concatenation, so a value
		// that could close the string or the rule would be a stylesheet
		// injection on an authenticated admin page.
		$css = PluginsScreen::css(
			'x"]{}body{display:none}[data-plugin="y',
			'https://evil.example.net/x.png");}body{display:none}a{background:url("'
		);
		$this->assertStringNotContainsString( 'body{display:none}', $css );
		$this->assertSame( 1, substr_count( $css, '{' ) );
		$this->assertSame( 1, substr_count( $css, '}' ) );
	}

	public function test_it_emits_nothing_rather_than_a_broken_rule(): void {
		$this->assertSame( '', PluginsScreen::css( '', 'https://example.com/icon.png' ) );
		$this->assertSame( '', PluginsScreen::css( 'webyar-woocommerce/webyar-woocommerce.php', '' ) );
		// A value that is only characters the filter drops is the same as empty.
		$this->assertSame( '', PluginsScreen::css( '"""', 'https://example.com/icon.png' ) );
	}
}
