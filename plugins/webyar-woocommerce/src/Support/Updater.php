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
	 * that reports only when an update EXISTS never gets that toggle.
	 *
	 * So the up-to-date case is filled in unconditionally — including when
	 * the manifest could not be read, because a store whose Web Yar install
	 * is briefly unreachable, or not configured yet, should still be able to
	 * say "keep this updated". The toggle records an intention; it is not a
	 * claim that a newer build was found. Nothing is installed from a
	 * `no_update` entry, so the fallback carries no download URL at all.
	 *
	 * @param mixed $transient
	 * @return mixed
	 */
	public function inject_update( $transient ) {
		if ( ! is_object( $transient ) ) {
			return $transient;
		}
		$key      = self::basename();
		$manifest = $this->manifest();

		if ( null !== $manifest && version_compare( $manifest['version'], WEBYAR_WC_VERSION, '>' ) ) {
			$transient->response[ $key ] = $this->item( $manifest['version'], $manifest['package'], $manifest );
			unset( $transient->no_update[ $key ] );
			return $transient;
		}

		// Same shape, minus the promise of something newer.
		$transient->no_update[ $key ] = $this->item( WEBYAR_WC_VERSION, '', $manifest );
		unset( $transient->response[ $key ] );

		return $transient;
	}

	/**
	 * @param array<string,string>|null $manifest
	 * @return object
	 */
	private function item( string $version, string $package, ?array $manifest ) {
		return (object) array(
			'id'            => 'webyar.ai/' . self::basename(),
			'slug'          => 'webyar-woocommerce',
			'plugin'        => self::basename(),
			'new_version'   => $version,
			'url'           => $manifest['homepage'] ?? 'https://webyar.ai',
			'package'       => $package,
			'requires'      => $manifest['requires'] ?? '6.0',
			'requires_php'  => $manifest['requires_php'] ?? '7.4',
			'tested'        => $manifest['tested'] ?? '',
			'icons'         => self::icons(),
			'banners'       => array(),
			'banners_rtl'   => array(),
			'compatibility' => new \stdClass(),
		);
	}

	/**
	 * The logo WordPress draws beside an update, taken from the copy that is
	 * already installed rather than from the manifest. An icon URL supplied
	 * over the network would be remote content rendered inside wp-admin on
	 * the say-so of a fetched file; the plugin ships its own, so there is
	 * nothing to fetch and nothing to trust.
	 *
	 * One file answers all three sizes on purpose. WordPress draws this
	 * plugin at 28px in the installed list and about 64px on the updates
	 * screen — 128px covers both at 2x — and it never appears in the
	 * wp.org plugin browser, which is the only place a 256px copy would
	 * have been used. A second image would be bytes every store downloads
	 * and nothing ever renders.
	 *
	 * @return array<string,string>
	 */
	public static function icons(): array {
		$icon = WEBYAR_WC_URL . 'assets/icon-128x128.png';
		return array(
			'1x'      => $icon,
			'2x'      => $icon,
			'default' => $icon,
		);
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
			'name'          => __( 'WebYar for WooCommerce', 'webyar-woocommerce' ),
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
				'description' => wp_kses_post( __( $manifest['description'], 'webyar-woocommerce' ) ),
				'changelog'   => nl2br( htmlspecialchars( 0 === strpos( get_user_locale(), 'fa' ) && '' !== ( $manifest['changelog_fa'] ?? '' ) ? $manifest['changelog_fa'] : $manifest['changelog'], ENT_QUOTES, 'UTF-8' ) ),
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
			'changelog_fa' => wp_kses_post( (string) ( $data['changelog_fa'] ?? '' ) ),
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

		$package_parts = wp_parse_url( $package );
		$base_parts    = wp_parse_url( $base );
		if ( ! is_array( $package_parts ) || ! is_array( $base_parts ) ) {
			return null;
		}
		$host   = strtolower( (string) ( $package_parts['host'] ?? '' ) );
		$scheme = strtolower( (string) ( $package_parts['scheme'] ?? '' ) );
		if ( '' === $host || $host !== strtolower( (string) ( $base_parts['host'] ?? '' ) ) ) {
			return null;
		}
		// An HTTPS URL on the same hostname but another port is a different
		// origin. Reject credentials, fragments and a scheme change as well.
		if ( isset( $package_parts['user'] ) || isset( $package_parts['pass'] ) || isset( $package_parts['fragment'] ) ) {
			return null;
		}
		$base_scheme = strtolower( (string) ( $base_parts['scheme'] ?? '' ) );
		if ( $scheme !== $base_scheme || ( 'https' !== $scheme && ! ( 'http' === $scheme && 'localhost' === $host ) ) ) {
			return null;
		}
		$port      = (int) ( $package_parts['port'] ?? ( 'https' === $scheme ? 443 : 80 ) );
		$base_port = (int) ( $base_parts['port'] ?? ( 'https' === $base_scheme ? 443 : 80 ) );
		if ( $port !== $base_port ) {
			return null;
		}
		return esc_url_raw( $package );
	}
}
