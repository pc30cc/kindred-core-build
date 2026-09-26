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
 * WHAT MAY BE INSTALLED is the security question, and the answer is: only
 * an archive whose sha256 is listed in a manifest SIGNED by the Web Yar
 * release key. The download host is not trusted — it is a URL any shop
 * manager once could change, and a web server that can be compromised:
 *
 *   - `/downloads/webyar-woocommerce.json.sig` must be a detached Ed25519
 *     signature (base64) over the manifest's exact bytes that verifies
 *     against UPDATE_PUBLIC_KEY, built into this plugin (the same release
 *     key as the OpenCart and WHMCS connectors; the private key lives only
 *     on the release host). Otherwise no update is offered;
 *   - when WordPress downloads the package (`upgrader_pre_download`) the
 *     manifest is fetched and verified AGAIN and the archive must match its
 *     signed sha256 and size, or the update is refused;
 *   - both fetches are https-only via wp_safe_remote_get(), and the package
 *     path must stay on the configured Web Yar origin.
 *
 * Refusals are logged and shown to administrators (see status()).
 *
 * Nothing runs at all until the store has an app URL configured, and the
 * result is cached so a busy admin does not refetch on every page load.
 */
final class Updater {

	private const MANIFEST_PATH  = '/downloads/webyar-woocommerce.json';
	private const SIGNATURE_PATH = '/downloads/webyar-woocommerce.json.sig';
	private const CACHE_KEY      = 'webyar_wc_update_manifest';
	private const CACHE_TTL      = 6 * HOUR_IN_SECONDS;
	/** Re-check sooner after a failure than after a success, but never hammer. */
	private const FAILURE_TTL    = 30 * MINUTE_IN_SECONDS;
	private const MAX_MANIFEST_BYTES = 65536;
	public const MAX_PACKAGE_BYTES   = 16777216;
	/** Last check/download outcome, for the settings page and the admin notice. */
	public const STATUS_OPTION = 'webyar_wc_update_status';
	/** Outcomes that mean "someone served something the release key did not sign". */
	private const ALARMING = array( 'signature_invalid', 'checksum_mismatch', 'package_mismatch' );

	/**
	 * Ed25519 public key release manifests are signed with — the SAME key as
	 * plugins/webyar-opencart/core/Protocol.php and the WHMCS addon, so there
	 * is one release key to guard. A staging site can define
	 * WEBYAR_UPDATE_PUBLIC_KEY in wp-config.php (editing wp-config.php is
	 * already full control of the site, so this opens nothing new).
	 */
	public const UPDATE_PUBLIC_KEY = 'vbNNY6jM7bZvxmvV39oRSZ4XSZ7EMks/eEyyVcrwPKQ=';

	public function register(): void {
		add_filter( 'pre_set_site_transient_update_plugins', array( $this, 'inject_update' ) );
		add_filter( 'plugins_api', array( $this, 'plugin_details' ), 10, 3 );
		add_filter( 'upgrader_pre_download', array( $this, 'verify_download' ), 10, 4 );
		add_action( 'upgrader_process_complete', array( $this, 'flush_cache' ), 10, 2 );
		add_action( 'admin_notices', array( $this, 'admin_notice' ) );
		add_action( 'network_admin_notices', array( $this, 'admin_notice' ) );
	}

	public static function public_key(): string {
		return defined( 'WEBYAR_UPDATE_PUBLIC_KEY' ) ? (string) constant( 'WEBYAR_UPDATE_PUBLIC_KEY' ) : self::UPDATE_PUBLIC_KEY;
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
	 * WordPress is about to download a package. If it is this plugin's, the
	 * download happens HERE: the manifest is fetched and its signature
	 * checked afresh (nothing cached is trusted for an install), and the
	 * archive is handed to WordPress only when it matches the signed sha256
	 * and size. Anything else is refused with a WP_Error, which WordPress
	 * reports and which leaves the installed plugin untouched.
	 *
	 * @param mixed $reply      false, or what an earlier filter decided
	 * @param mixed $package    the package URL WordPress was given
	 * @param mixed $upgrader
	 * @param mixed $hook_extra ['plugin' => basename, …] for plugin updates
	 * @return mixed
	 */
	public function verify_download( $reply, $package, $upgrader = null, $hook_extra = array() ) {
		if ( false !== $reply || ! self::is_own_package( $package, $hook_extra ) ) {
			return $reply;
		}

		$base  = PairingService::app_base_url();
		$error = 'insecure_url';
		$manifest = self::is_https_url( $base ) ? $this->fetch_verified( $base, $error ) : null;
		if ( null === $manifest ) {
			return $this->refuse( $error );
		}
		if ( ! is_string( $package ) || $package !== $manifest['package'] ) {
			return $this->refuse( 'package_mismatch' );
		}

		if ( ! function_exists( 'download_url' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
		$file = download_url( $package, 300 );
		if ( is_wp_error( $file ) ) {
			return $file;
		}
		$size = (int) filesize( $file );
		if ( $size !== $manifest['size'] || ! hash_equals( $manifest['sha256'], (string) hash_file( 'sha256', $file ) ) ) {
			wp_delete_file( $file );
			return $this->refuse( 'checksum_mismatch' );
		}

		self::record( 'verified' );
		return $file;
	}

	/** @param mixed $package @param mixed $hook_extra */
	private static function is_own_package( $package, $hook_extra ): bool {
		if ( is_array( $hook_extra ) && isset( $hook_extra['plugin'] ) ) {
			return self::basename() === $hook_extra['plugin'];
		}
		// No hook_extra (an unusual caller): recognise the package by its path.
		$path = is_string( $package ) ? (string) wp_parse_url( $package, PHP_URL_PATH ) : '';
		return '' !== $path && '/downloads/webyar-woocommerce.zip' === substr( $path, -strlen( '/downloads/webyar-woocommerce.zip' ) );
	}

	/** @return \WP_Error */
	private function refuse( string $code ) {
		self::record( $code );
		Logger::error( 'plugin update refused', array( 'reason' => $code ) );
		return new \WP_Error(
			'webyar_update_refused',
			sprintf(
				/* translators: %s: short machine-readable reason */
				__( 'WebYar: the update was not installed because it could not be verified (%s).', 'webyar-woocommerce' ),
				$code
			)
		);
	}

	/**
	 * @return array{version:string,package:string,sha256:string,size:int,requires:string,requires_php:string,tested:string,homepage:string,description:string,changelog:string,changelog_fa:string,last_updated:string}|null
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

		$error    = 'insecure_url';
		$manifest = self::is_https_url( $base ) ? $this->fetch_verified( $base, $error ) : null;
		if ( null === $manifest ) {
			self::record( $error );
			if ( in_array( $error, self::ALARMING, true ) ) {
				Logger::error( 'plugin update manifest refused', array( 'reason' => $error ) );
			}
			set_site_transient( self::CACHE_KEY, 'error', self::FAILURE_TTL );
			return null;
		}

		self::record( 'ok' );
		set_site_transient( self::CACHE_KEY, $manifest, self::CACHE_TTL );
		return $manifest;
	}

	/**
	 * The manifest from $base, parsed, only when its signature verifies;
	 * otherwise null with $error set to why.
	 *
	 * @return array<string,mixed>|null
	 */
	private function fetch_verified( string $base, ?string &$error ): ?array {
		if ( ! function_exists( 'sodium_crypto_sign_verify_detached' ) ) {
			// WordPress 5.2+ bundles sodium_compat, so this means a broken install.
			$error = 'unsupported';
			return null;
		}
		$base     = trailingslashit( $base );
		$response = wp_safe_remote_get(
			$base . ltrim( self::MANIFEST_PATH, '/' ),
			array( 'timeout' => 10, 'limit_response_size' => self::MAX_MANIFEST_BYTES, 'headers' => array( 'Accept' => 'application/json' ) )
		);
		if ( is_wp_error( $response ) || (int) wp_remote_retrieve_response_code( $response ) !== 200 ) {
			$error = 'unreachable';
			return null;
		}
		$signature = wp_safe_remote_get( $base . ltrim( self::SIGNATURE_PATH, '/' ), array( 'timeout' => 10, 'limit_response_size' => 1024 ) );
		if ( is_wp_error( $signature ) || (int) wp_remote_retrieve_response_code( $signature ) !== 200 ) {
			$error = 'unsigned';
			return null;
		}

		$body  = (string) wp_remote_retrieve_body( $response );
		$error = self::verify_signature( $body, (string) wp_remote_retrieve_body( $signature ), self::public_key() );
		if ( null !== $error ) {
			return null;
		}
		$manifest = $this->parse( $body, untrailingslashit( $base ) );
		if ( null === $manifest ) {
			$error = 'manifest_invalid';
		}
		return $manifest;
	}

	/**
	 * Null when $signature_b64 is a valid Ed25519 signature over exactly
	 * $body by $public_key_b64; otherwise the reason.
	 */
	public static function verify_signature( string $body, string $signature_b64, string $public_key_b64 ): ?string {
		$signature  = base64_decode( trim( $signature_b64 ), true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		$public_key = base64_decode( $public_key_b64, true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		if ( false === $signature || 64 !== strlen( $signature ) ) {
			return 'unsigned';
		}
		if ( false === $public_key || 32 !== strlen( $public_key ) ) {
			return 'bad_key';
		}
		try {
			return sodium_crypto_sign_verify_detached( $signature, $body, $public_key ) ? null : 'signature_invalid';
		} catch ( \Throwable $e ) {
			return 'signature_invalid';
		}
	}

	private static function is_https_url( string $url ): bool {
		$parts = wp_parse_url( $url );
		return is_array( $parts ) && 'https' === strtolower( (string) ( $parts['scheme'] ?? '' ) ) && '' !== (string) ( $parts['host'] ?? '' );
	}

	private static function record( string $code ): void {
		update_option( self::STATUS_OPTION, array( 'code' => $code, 'at' => time() ), false );
	}

	/** @return array{code:string,at:int}|null the last update check or download outcome */
	public static function status(): ?array {
		$status = get_option( self::STATUS_OPTION, null );
		return is_array( $status ) && isset( $status['code'] ) ? array( 'code' => (string) $status['code'], 'at' => (int) ( $status['at'] ?? 0 ) ) : null;
	}

	/** Human wording for status() codes, for the settings page. */
	public static function status_label( string $code ): string {
		switch ( $code ) {
			case 'ok':
			case 'verified':
				return __( 'Release signature verified', 'webyar-woocommerce' );
			case 'unsigned':
				return __( 'The published release is not signed yet; no update is offered', 'webyar-woocommerce' );
			case 'signature_invalid':
			case 'bad_key':
			case 'checksum_mismatch':
			case 'package_mismatch':
				return __( 'An update was refused because its signature or checksum did not verify', 'webyar-woocommerce' );
			case 'insecure_url':
				return __( 'Updates need an https WebYar URL', 'webyar-woocommerce' );
			case 'unsupported':
				return __( 'Updates need the PHP sodium functions', 'webyar-woocommerce' );
			default:
				return __( 'Could not check for updates; will retry', 'webyar-woocommerce' );
		}
	}

	/** A refused (possibly tampered) update is worth telling whoever can update plugins. */
	public function admin_notice(): void {
		$status = self::status();
		if ( null === $status || ! in_array( $status['code'], self::ALARMING, true ) || ! current_user_can( 'update_plugins' ) ) {
			return;
		}
		printf(
			'<div class="notice notice-error"><p>%s</p></div>',
			esc_html(
				sprintf(
					/* translators: %s: short machine-readable reason */
					__( 'WebYar for WooCommerce refused an update that did not match the WebYar release signature (%s). The installed version was kept. If this repeats, check the WebYar URL in the plugin settings and contact WebYar.', 'webyar-woocommerce' ),
					$status['code']
				)
			)
		);
	}

	/**
	 * @return array<string,mixed>|null
	 */
	private function parse( string $body, string $base ): ?array {
		$data = json_decode( $body, true );
		if ( ! is_array( $data ) || 'webyar-woocommerce' !== ( $data['slug'] ?? '' ) || empty( $data['version'] ) || empty( $data['package'] ) ) {
			return null;
		}

		$version = (string) $data['version'];
		// A version string is compared with version_compare() and printed into
		// the admin — keep it to what a version can actually be.
		if ( ! preg_match( '/^[0-9]+(\.[0-9]+){0,3}(-[A-Za-z0-9.]+)?$/', $version ) ) {
			return null;
		}

		$sha256 = strtolower( (string) ( $data['sha256'] ?? '' ) );
		$size   = $data['size'] ?? null;
		if ( ! preg_match( '/^[a-f0-9]{64}$/', $sha256 ) || ! is_int( $size ) || $size <= 0 || $size > self::MAX_PACKAGE_BYTES ) {
			return null;
		}

		$package = $this->same_origin_package( (string) $data['package'], $base );
		if ( null === $package ) {
			return null;
		}

		return array(
			'version'      => $version,
			'package'      => $package,
			'sha256'       => $sha256,
			'size'         => $size,
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
	 * Defence in depth behind the signature: WordPress will fetch whatever
	 * URL it is handed, so the host is taken from local configuration and
	 * the manifest only gets to say which path on it. What is INSTALLED is
	 * decided by the signed sha256 in verify_download(), not by this check.
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
		// https only — also for localhost: wp_safe_remote_get() refuses local
		// hosts anyway, and a plain-http package is swappable in transit.
		$base_scheme = strtolower( (string) ( $base_parts['scheme'] ?? '' ) );
		if ( 'https' !== $scheme || 'https' !== $base_scheme ) {
			return null;
		}
		$port      = (int) ( $package_parts['port'] ?? 443 );
		$base_port = (int) ( $base_parts['port'] ?? 443 );
		if ( $port !== $base_port ) {
			return null;
		}
		return esc_url_raw( $package );
	}
}
