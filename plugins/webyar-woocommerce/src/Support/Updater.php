<?php
namespace WebYar\WooCommerce\Support;

use WebYar\WooCommerce\Auth\PairingService;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Updates from the Web Yar install this store is paired with.
 *
 * The plugin is not on wordpress.org — it is downloaded from the dashboard
 * that issued the store's credentials — so WordPress has nowhere to look for
 * a newer version and the site silently keeps whatever build it was first
 * given. Every fix shipped since then simply never arrives.
 *
 * WHERE UPDATES COME FROM is the security question, and the answer is: the
 * SAME origin the admin typed into Settings → Web Yar, never a value the
 * manifest itself supplies. A manifest is data fetched over the network; if
 * it could name its own download host, tampering with it would turn this
 * into an arbitrary-code installer. So the package URL is required to be
 * https and to live on the configured host, and anything else is discarded.
 *
 * Nothing runs at all until the store has an app URL configured, and the
 * result is cached so a busy admin does not refetch on every page load.
 */
final class Updater {

	private const MANIFEST_PATH = '/downloads/webyar-woocommerce.json';
	private const CACHE_KEY     = 'webyar_wc_update_manifest';
	private const CACHE_TTL     = 6 * HOUR_IN_SECONDS;
	/** Re-check sooner after a failure than after a success, but never hammer. */
	private const FAILURE_TTL   = 30 * MINUTE_IN_SECONDS;

	public function register(): void {
		add_filter( 'pre_set_site_transient_update_plugins', array( $this, 'inject_update' ) );
		add_filter( 'plugins_api', array( $this, 'plugin_details' ), 10, 3 );
		add_action( 'upgrader_process_complete', array( $this, 'flush_cache' ), 10, 2 );
	}

	public static function basename(): string {
		return plugin_basename( WEBYAR_WC_FILE );
	}

	/**
	 * WordPress asks every plugin what it knows about updates, and then uses
	 * the answer twice: `response` drives the update notice, and `no_update`
	 * is what makes the "Enable auto-updates" link appear at all. A plugin
	 * that reports only when an update EXISTS never gets that toggle, so the
	 * up-to-date case is filled in deliberately rather than left empty.
	 *
	 * @param mixed $transient
	 * @return mixed
	 */
	public function inject_update( $transient ) {
		if ( ! is_object( $transient ) ) {
			return $transient;
		}
		$manifest = $this->manifest();
		if ( null === $manifest ) {
			return $transient;
		}

		$item = (object) array(
			'id'            => 'webyar.ai/' . self::basename(),
			'slug'          => 'webyar-woocommerce',
			'plugin'        => self::basename(),
			'new_version'   => $manifest['version'],
			'url'           => $manifest['homepage'],
			'package'       => $manifest['package'],
			'requires'      => $manifest['requires'],
			'requires_php'  => $manifest['requires_php'],
			'tested'        => $manifest['tested'],
			'icons'         => array(),
			'banners'       => array(),
			'banners_rtl'   => array(),
			'compatibility' => new \stdClass(),
		);

		if ( version_compare( $manifest['version'], WEBYAR_WC_VERSION, '>' ) ) {
			$transient->response[ self::basename() ] = $item;
			unset( $transient->no_update[ self::basename() ] );
		} else {
			// Same shape, minus the promise of something newer.
			$item->new_version = WEBYAR_WC_VERSION;
			$transient->no_update[ self::basename() ] = $item;
			unset( $transient->response[ self::basename() ] );
		}

		return $transient;
	}

	/**
	 * The "View details" modal. Without this WordPress shows an empty
	 * lightbox for a plugin it cannot find on wordpress.org.
	 *
	 * @param mixed  $result
	 * @param string $action
	 * @param object $args
	 * @return mixed
	 */
	public function plugin_details( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || empty( $args->slug ) || 'webyar-woocommerce' !== $args->slug ) {
			return $result;
		}
		$manifest = $this->manifest();
		if ( null === $manifest ) {
			return $result;
		}

		return (object) array(
			'name'          => __( 'اتصال‌دهنده‌ی وب‌یار برای ووکامرس', 'webyar-woocommerce' ),
			'slug'          => 'webyar-woocommerce',
			'version'       => $manifest['version'],
			'author'        => '<a href="https://webyar.ai">Web Yar</a>',
			'homepage'      => $manifest['homepage'],
			'requires'      => $manifest['requires'],
			'requires_php'  => $manifest['requires_php'],
			'tested'        => $manifest['tested'],
			'last_updated'  => $manifest['last_updated'],
			'download_link' => $manifest['package'],
			'sections'      => array(
				'description' => $manifest['description'],
				'changelog'   => $manifest['changelog'],
			),
		);
	}

	/**
	 * @param mixed $upgrader
	 * @param array $extra
	 */
	public function flush_cache( $upgrader, $extra ): void {
		if ( is_array( $extra ) && 'update' === ( $extra['action'] ?? '' ) && 'plugin' === ( $extra['type'] ?? '' ) ) {
			delete_site_transient( self::CACHE_KEY );
		}
	}

	/** Forget what we know, so the next check asks the server again. */
	public static function forget(): void {
		delete_site_transient( self::CACHE_KEY );
	}

	/**
	 * @return array{version:string,package:string,requires:string,requires_php:string,tested:string,homepage:string,description:string,changelog:string,last_updated:string}|null
	 */
	private function manifest(): ?array {
		$cached = get_site_transient( self::CACHE_KEY );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		if ( false !== $cached ) {
			return null; // a cached failure — do not retry until it expires
		}

		$base = PairingService::app_base_url();
		if ( '' === $base ) {
			return null; // not configured yet; nothing to check against
		}

		$response = wp_remote_get(
			trailingslashit( $base ) . ltrim( self::MANIFEST_PATH, '/' ),
			array( 'timeout' => 10, 'headers' => array( 'Accept' => 'application/json' ) )
		);
		$manifest = $this->parse( $response, $base );
		if ( null === $manifest ) {
			set_site_transient( self::CACHE_KEY, 'error', self::FAILURE_TTL );
			return null;
		}

		set_site_transient( self::CACHE_KEY, $manifest, self::CACHE_TTL );
		return $manifest;
	}

	/**
	 * @param mixed  $response
	 * @param string $base
	 * @return array<string,string>|null
	 */
	private function parse( $response, string $base ): ?array {
		if ( is_wp_error( $response ) || (int) wp_remote_retrieve_response_code( $response ) !== 200 ) {
			return null;
		}
		$data = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $data ) || empty( $data['version'] ) || empty( $data['package'] ) ) {
			return null;
		}

		$version = (string) $data['version'];
		// A version string is compared with version_compare() and printed into
		// the admin — keep it to what a version can actually be.
		if ( ! preg_match( '/^[0-9]+(\.[0-9]+){0,3}(-[A-Za-z0-9.]+)?$/', $version ) ) {
			return null;
		}

		$package = $this->same_origin_package( (string) $data['package'], $base );
		if ( null === $package ) {
			return null;
		}

		return array(
			'version'      => $version,
			'package'      => $package,
			'requires'     => isset( $data['requires'] ) ? (string) $data['requires'] : '6.0',
			'requires_php' => isset( $data['requires_php'] ) ? (string) $data['requires_php'] : '7.4',
			'tested'       => isset( $data['tested'] ) ? (string) $data['tested'] : '',
			'homepage'     => esc_url_raw( (string) ( $data['homepage'] ?? 'https://webyar.ai' ) ),
			'description'  => wp_kses_post( (string) ( $data['description'] ?? '' ) ),
			'changelog'    => wp_kses_post( (string) ( $data['changelog'] ?? '' ) ),
			'last_updated' => (string) ( $data['last_updated'] ?? '' ),
		);
	}

	/**
	 * The download must come from the Web Yar install the admin configured.
	 *
	 * This is the whole trust boundary of an updater: WordPress will fetch
	 * whatever URL it is handed, unzip it and run it. A manifest that could
	 * choose its own host would be a way to install anything on the store,
	 * so the host is taken from local configuration and the manifest only
	 * gets to say which path on it.
	 */
	private function same_origin_package( string $package, string $base ): ?string {
		$package = trim( $package );
		if ( '' === $package ) {
			return null;
		}
		// The manifest is generated by the same build that makes the zip, and
		// that build cannot know which host will serve it — Web Yar is
		// self-hostable. So the usual form is a path, resolved here against
		// the configured base. An absolute URL is still accepted, and still
		// has to pass the same-origin check below.
		if ( '/' === $package[0] ) {
			$package = untrailingslashit( $base ) . $package;
		}

		$package_host = wp_parse_url( $package, PHP_URL_HOST );
		$base_host    = wp_parse_url( $base, PHP_URL_HOST );
		$scheme       = wp_parse_url( $package, PHP_URL_SCHEME );

		// A value with no host never matches the configured one — including
		// when the configured URL is itself malformed, because the scheme
		// check below still demands https. (An explicit "both hosts present"
		// guard used to sit here; every input it could have refused was
		// already refused by these two, so it decided nothing.)
		if ( ! $package_host || strcasecmp( (string) $package_host, (string) $base_host ) !== 0 ) {
			return null;
		}
		// Plain http would let anyone on the path swap the archive.
		if ( 'https' !== strtolower( (string) $scheme ) && 'localhost' !== strtolower( $base_host ) ) {
			return null;
		}
		return esc_url_raw( $package );
	}
}
