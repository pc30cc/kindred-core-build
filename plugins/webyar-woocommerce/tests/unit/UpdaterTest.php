<?php
/**
 * Where an update is allowed to come from.
 *
 * This is the whole trust boundary of a self-hosted updater: WordPress will
 * fetch whatever URL it is handed, unzip it and run it. The manifest is data
 * pulled over the network, so if it could name its own download host,
 * tampering with it would turn the updater into an arbitrary-code installer
 * for every store that has the plugin.
 *
 * The host therefore comes from what the admin configured locally, and the
 * manifest only gets to say which path on it.
 */

use PHPUnit\Framework\TestCase;
use WebYar\WooCommerce\Support\Updater;

final class UpdaterTest extends TestCase {

	/** @return mixed */
	private function resolve( string $package, string $base ) {
		$method = new ReflectionMethod( Updater::class, 'same_origin_package' );
		$method->setAccessible( true );
		return $method->invoke( new Updater(), $package, $base );
	}

	public function test_a_path_is_resolved_against_the_configured_web_yar_url(): void {
		// The build that writes the manifest cannot know which host will
		// serve it — Web Yar is self-hostable — so a path is the normal form.
		$this->assertSame(
			'https://app.example.com/downloads/webyar-woocommerce.zip',
			$this->resolve( '/downloads/webyar-woocommerce.zip', 'https://app.example.com' )
		);
	}

	public function test_an_absolute_url_on_the_same_host_is_kept(): void {
		$this->assertSame(
			'https://app.example.com/downloads/webyar-woocommerce.zip',
			$this->resolve( 'https://app.example.com/downloads/webyar-woocommerce.zip', 'https://app.example.com' )
		);
	}

	public function test_another_host_is_refused(): void {
		// The attack this exists to stop: a tampered manifest pointing the
		// store's own updater at an archive someone else controls.
		$this->assertNull(
			$this->resolve( 'https://evil.example.net/webyar-woocommerce.zip', 'https://app.example.com' )
		);
	}

	public function test_a_lookalike_subdomain_is_refused(): void {
		$this->assertNull(
			$this->resolve( 'https://app.example.com.evil.net/p.zip', 'https://app.example.com' )
		);
	}

	public function test_plain_http_is_refused(): void {
		// Otherwise anyone on the network path can swap the archive.
		$this->assertNull(
			$this->resolve( 'http://app.example.com/downloads/webyar-woocommerce.zip', 'https://app.example.com' )
		);
	}

	public function test_http_is_allowed_only_for_a_localhost_dev_install(): void {
		$this->assertSame(
			'http://localhost/downloads/webyar-woocommerce.zip',
			$this->resolve( 'http://localhost/downloads/webyar-woocommerce.zip', 'http://localhost' )
		);
	}

	public function test_a_hostless_or_empty_value_is_refused(): void {
		$this->assertNull( $this->resolve( '', 'https://app.example.com' ) );
		$this->assertNull( $this->resolve( 'webyar-woocommerce.zip', 'https://app.example.com' ) );
	}

	public function test_the_host_comparison_ignores_case(): void {
		$this->assertSame(
			'https://APP.example.com/p.zip',
			$this->resolve( 'https://APP.example.com/p.zip', 'https://app.example.com' )
		);
	}

	// ── What the store is told about a new build ────────────────────────

	/** @param array<string,mixed> $over */
	private function manifest_body( array $over = array() ): string {
		return (string) wp_json_encode( array_merge( array(
			'slug'         => 'webyar-woocommerce',
			'version'      => '1.2.0',
			'package'      => '/downloads/webyar-woocommerce.zip',
			'requires'     => '6.0',
			'requires_php' => '7.4',
			'tested'       => '9.4',
			'homepage'     => 'https://webyar.ai',
			'description'  => 'd',
			'changelog'    => 'c',
		), $over ) );
	}

	/** @param array<string,mixed> $over @return object */
	private function check( array $over = array(), $http = null ) {
		$GLOBALS['__webyar_test_options']['webyar_wc_settings'] = array( 'app_url' => 'https://app.example.com' );
		$GLOBALS['__webyar_test_transients'] = array();
		$GLOBALS['__webyar_test_fetched']    = array();
		$GLOBALS['__webyar_test_http']       = $http ?? array( 'response' => array( 'code' => 200 ), 'body' => $this->manifest_body( $over ) );
		$transient = (object) array( 'response' => array(), 'no_update' => array() );
		return ( new Updater() )->inject_update( $transient );
	}

	private function key(): string {
		return 'webyar-woocommerce/webyar-woocommerce.php';
	}

	public function test_a_newer_manifest_offers_the_update(): void {
		$out = $this->check();
		$this->assertSame( '1.2.0', $out->response[ $this->key() ]->new_version );
	}

	public function test_the_same_version_offers_nothing(): void {
		$out = $this->check( array( 'version' => '1.1.0' ) );
		$this->assertArrayNotHasKey( $this->key(), $out->response );
	}

	public function test_being_up_to_date_still_reports_in_so_the_auto_update_toggle_appears(): void {
		// WordPress only offers "Enable auto-updates" for a plugin it holds
		// update information about — `no_update` is that information.
		$out = $this->check( array( 'version' => '1.1.0' ) );
		$this->assertSame( '1.1.0', $out->no_update[ $this->key() ]->new_version );
	}

	public function test_a_manifest_pointing_at_another_host_is_ignored_entirely(): void {
		$out = $this->check( array( 'package' => 'https://evil.example.net/p.zip' ) );
		$this->assertArrayNotHasKey( $this->key(), $out->response );
		$this->assertArrayNotHasKey( $this->key(), $out->no_update );
	}

	public function test_a_version_string_that_is_not_a_version_is_ignored(): void {
		$out = $this->check( array( 'version' => '1.2.0; rm -rf' ) );
		$this->assertArrayNotHasKey( $this->key(), $out->response );
	}

	public function test_it_fails_closed_on_a_server_error(): void {
		$out = $this->check( array(), array( 'response' => array( 'code' => 500 ), 'body' => '' ) );
		$this->assertArrayNotHasKey( $this->key(), $out->response );
	}

	public function test_it_fails_closed_when_the_body_is_not_json(): void {
		$out = $this->check( array(), array( 'response' => array( 'code' => 200 ), 'body' => '<html>oops</html>' ) );
		$this->assertArrayNotHasKey( $this->key(), $out->response );
	}

	public function test_an_unconfigured_store_makes_no_request_at_all(): void {
		$GLOBALS['__webyar_test_options']['webyar_wc_settings'] = array();
		$GLOBALS['__webyar_test_transients'] = array();
		$GLOBALS['__webyar_test_fetched']    = array();
		$out = ( new Updater() )->inject_update( (object) array( 'response' => array(), 'no_update' => array() ) );
		$this->assertSame( array(), $GLOBALS['__webyar_test_fetched'] );
		// …and it still lists itself, so the toggle is there from day one.
		$this->assertSame( '1.1.0', $out->no_update[ $this->key() ]->new_version );
	}

	public function test_repeated_checks_ask_the_server_once(): void {
		// wp-admin fires this filter on many page loads.
		$GLOBALS['__webyar_test_options']['webyar_wc_settings'] = array( 'app_url' => 'https://app.example.com' );
		$GLOBALS['__webyar_test_transients'] = array();
		$GLOBALS['__webyar_test_fetched']    = array();
		$GLOBALS['__webyar_test_http']       = array( 'response' => array( 'code' => 200 ), 'body' => $this->manifest_body() );
		$updater = new Updater();
		for ( $i = 0; $i < 3; $i++ ) {
			$updater->inject_update( (object) array( 'response' => array(), 'no_update' => array() ) );
		}
		$this->assertCount( 1, $GLOBALS['__webyar_test_fetched'] );
		$this->assertSame( 'https://app.example.com/downloads/webyar-woocommerce.json', $GLOBALS['__webyar_test_fetched'][0] );
	}
}
