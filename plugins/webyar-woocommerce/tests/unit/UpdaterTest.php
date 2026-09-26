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

	public function test_another_port_or_userinfo_is_refused(): void {
		$this->assertNull( $this->resolve( 'https://app.example.com:8443/p.zip', 'https://app.example.com' ) );
		$this->assertNull( $this->resolve( 'https://user@app.example.com/p.zip', 'https://app.example.com' ) );
		$this->assertNull( $this->resolve( 'https://app.example.com/p.zip#fragment', 'https://app.example.com' ) );
		$this->assertSame( 'https://app.example.com:8443/p.zip', $this->resolve( '/p.zip', 'https://app.example.com:8443' ) );
	}

	public function test_plain_http_is_refused(): void {
		// Otherwise anyone on the network path can swap the archive.
		$this->assertNull(
			$this->resolve( 'http://app.example.com/downloads/webyar-woocommerce.zip', 'https://app.example.com' )
		);
	}

	public function test_http_is_refused_even_for_localhost(): void {
		$this->assertNull( $this->resolve( 'http://localhost/downloads/webyar-woocommerce.zip', 'http://localhost' ) );
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
			'sha256'       => hash( 'sha256', self::PACKAGE ),
			'size'         => strlen( self::PACKAGE ),
		), $over ) );
	}

	private const PACKAGE  = 'PK-signed-package-bytes';
	private const MANIFEST = 'https://app.example.com/downloads/webyar-woocommerce.json';

	/**
	 * Serves $body as the manifest and $signature (default: a valid release
	 * signature over $body; null: 404) as its .sig.
	 */
	private function serve( string $body, $signature = true ): void {
		$GLOBALS['__webyar_test_options']['webyar_wc_settings'] = array( 'app_url' => 'https://app.example.com' );
		$GLOBALS['__webyar_test_transients'] = array();
		$GLOBALS['__webyar_test_fetched']    = array();
		$GLOBALS['__webyar_test_http']       = null;
		$GLOBALS['__webyar_test_http_by_url'] = array(
			self::MANIFEST          => array( 'response' => array( 'code' => 200 ), 'body' => $body ),
			self::MANIFEST . '.sig' => null === $signature
				? array( 'response' => array( 'code' => 404 ), 'body' => '' )
				: array( 'response' => array( 'code' => 200 ), 'body' => true === $signature ? webyar_test_sign( $body ) : $signature ),
		);
	}

	/** @param array<string,mixed> $over @return object */
	private function check( array $over = array(), $http = null ) {
		$this->serve( $this->manifest_body( $over ) );
		if ( null !== $http ) {
			$GLOBALS['__webyar_test_http_by_url'][ self::MANIFEST ] = $http;
		}
		$transient = (object) array( 'response' => array(), 'no_update' => array() );
		return ( new Updater() )->inject_update( $transient );
	}

	private function offered( $signature ): bool {
		$this->serve( $this->manifest_body(), $signature );
		$out = ( new Updater() )->inject_update( (object) array( 'response' => array(), 'no_update' => array() ) );
		return isset( $out->response[ $this->key() ] );
	}

	public function test_an_unsigned_manifest_offers_nothing(): void {
		$this->assertFalse( $this->offered( null ) );
		$this->assertSame( 'unsigned', Updater::status()['code'] );
	}

	public function test_a_manifest_signed_by_another_key_offers_nothing(): void {
		$other = sodium_crypto_sign_secretkey( sodium_crypto_sign_keypair() );
		$this->assertFalse( $this->offered( webyar_test_sign( $this->manifest_body(), $other ) ) );
		$this->assertSame( 'signature_invalid', Updater::status()['code'] );
	}

	public function test_a_tampered_manifest_offers_nothing(): void {
		// The host swaps in its own checksum; the signature covers every byte.
		$this->serve( $this->manifest_body( array( 'sha256' => str_repeat( 'b', 64 ) ) ), webyar_test_sign( $this->manifest_body() ) );
		$out = ( new Updater() )->inject_update( (object) array( 'response' => array(), 'no_update' => array() ) );
		$this->assertArrayNotHasKey( $this->key(), $out->response );
		$this->assertSame( 'signature_invalid', Updater::status()['code'] );
	}

	public function test_a_signed_manifest_without_a_checksum_offers_nothing(): void {
		$body = (string) wp_json_encode( array( 'slug' => 'webyar-woocommerce', 'version' => '1.2.0', 'package' => '/downloads/webyar-woocommerce.zip' ) );
		$this->serve( $body );
		$out = ( new Updater() )->inject_update( (object) array( 'response' => array(), 'no_update' => array() ) );
		$this->assertArrayNotHasKey( $this->key(), $out->response );
		$this->assertSame( 'manifest_invalid', Updater::status()['code'] );
	}

	public function test_a_plain_http_web_yar_url_is_never_fetched(): void {
		$GLOBALS['__webyar_test_options']['webyar_wc_settings'] = array( 'app_url' => 'http://app.example.com' );
		$GLOBALS['__webyar_test_transients'] = array();
		$GLOBALS['__webyar_test_fetched']    = array();
		( new Updater() )->inject_update( (object) array( 'response' => array(), 'no_update' => array() ) );
		$this->assertSame( array(), $GLOBALS['__webyar_test_fetched'] );
		$this->assertSame( 'insecure_url', Updater::status()['code'] );
	}

	// ── What WordPress is allowed to install ────────────────────────────

	private function download( string $package_bytes, array $over = array(), string $url = 'https://app.example.com/downloads/webyar-woocommerce.zip' ) {
		$this->serve( $this->manifest_body( $over ) );
		$GLOBALS['__webyar_test_package']    = $package_bytes;
		$GLOBALS['__webyar_test_downloaded'] = array();
		return ( new Updater() )->verify_download( false, $url, null, array( 'plugin' => $this->key() ) );
	}

	public function test_a_package_matching_the_signed_checksum_is_handed_to_wordpress(): void {
		$file = $this->download( self::PACKAGE );
		$this->assertIsString( $file );
		$this->assertSame( self::PACKAGE, file_get_contents( $file ) );
		unlink( $file );
	}

	public function test_a_swapped_package_is_refused_and_deleted(): void {
		$result = $this->download( 'PK-attacker-bytes-of-same-len' );
		$this->assertInstanceOf( WP_Error::class, $result );
		$this->assertSame( 'checksum_mismatch', Updater::status()['code'] );
	}

	public function test_a_package_url_other_than_the_signed_one_is_refused_before_download(): void {
		$result = $this->download( self::PACKAGE, array(), 'https://app.example.com/downloads/other.zip' );
		$this->assertInstanceOf( WP_Error::class, $result );
		$this->assertSame( array(), $GLOBALS['__webyar_test_downloaded'] );
	}

	public function test_an_unsigned_release_is_never_downloaded(): void {
		$this->serve( $this->manifest_body(), null );
		$GLOBALS['__webyar_test_downloaded'] = array();
		$result = ( new Updater() )->verify_download( false, 'https://app.example.com/downloads/webyar-woocommerce.zip', null, array( 'plugin' => $this->key() ) );
		$this->assertInstanceOf( WP_Error::class, $result );
		$this->assertSame( array(), $GLOBALS['__webyar_test_downloaded'] );
	}

	public function test_other_plugins_downloads_are_left_alone(): void {
		$GLOBALS['__webyar_test_fetched'] = array();
		$this->assertFalse( ( new Updater() )->verify_download( false, 'https://downloads.wordpress.org/plugin/x.zip', null, array( 'plugin' => 'x/x.php' ) ) );
		$this->assertSame( array(), $GLOBALS['__webyar_test_fetched'] );
	}

	public function test_the_built_in_release_key_is_an_ed25519_public_key(): void {
		$this->assertSame( 32, strlen( (string) base64_decode( Updater::UPDATE_PUBLIC_KEY, true ) ) );
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
		$this->assertArrayHasKey( $this->key(), $out->no_update );
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

	public function test_plugin_details_changelog_follows_the_admin_locale(): void {
		$this->check( array( 'changelog' => "English update notes\nSecond line", 'changelog_fa' => "یادداشت‌های فارسی\nخط بعدی" ) );
		$updater = new Updater();
		$GLOBALS['__webyar_test_locale'] = 'en_US';
		$this->assertSame( "English update notes<br />\nSecond line", $updater->plugin_details( null, 'plugin_information', (object) array( 'slug' => 'webyar-woocommerce' ) )->sections['changelog'] );
		$GLOBALS['__webyar_test_locale'] = 'fa_IR';
		$this->assertSame( "یادداشت‌های فارسی<br />\nخط بعدی", $updater->plugin_details( null, 'plugin_information', (object) array( 'slug' => 'webyar-woocommerce' ) )->sections['changelog'] );
		$GLOBALS['__webyar_test_locale'] = 'en_US';
	}

	public function test_repeated_checks_ask_the_server_once(): void {
		// wp-admin fires this filter on many page loads.
		$this->serve( $this->manifest_body() );
		$updater = new Updater();
		for ( $i = 0; $i < 3; $i++ ) {
			$updater->inject_update( (object) array( 'response' => array(), 'no_update' => array() ) );
		}
		// One manifest + one signature fetch, however often WordPress asks.
		$this->assertSame( array( self::MANIFEST, self::MANIFEST . '.sig' ), $GLOBALS['__webyar_test_fetched'] );
	}
}
