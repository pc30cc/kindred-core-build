<?php
namespace WebYar\WooCommerce\Auth;

use WebYar\WooCommerce\Support\Logger;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * OAuth-style authorization-code + PKCE pairing (docs/commerce/SECURITY.md
 * §Pairing). No Consumer Key/Secret copy-paste UX, no static global Web Yar
 * secret embedded in this plugin.
 */
final class PairingService {

	private const STATE_OPTION = 'webyar_wc_pairing_state'; // transient-like, short TTL, autoload=no

	/**
	 * The Web Yar application this store pairs with. There is no single
	 * fixed Web Yar domain — this is a self-hostable platform — so the URL
	 * MUST come from the admin (Settings → Web Yar → "Web Yar URL"), saved
	 * in `webyar_wc_settings['app_url']`. A hard-coded default here would
	 * silently point every store at the wrong server and make "Connect to
	 * Web Yar" fail with no obvious reason, which is exactly the bug this
	 * replaces. The filter remains as an advanced/dev override only.
	 */
	public static function app_base_url(): string {
		$settings = get_option( 'webyar_wc_settings', array() );
		$configured = is_array( $settings ) ? trim( (string) ( $settings['app_url'] ?? '' ) ) : '';
		$url = apply_filters( 'webyar_commerce_app_base_url', $configured );
		return untrailingslashit( $url );
	}

	public static function app_base_url_configured(): bool {
		return self::app_base_url() !== '';
	}

	private static function base64url( string $raw ): string {
		return rtrim( strtr( base64_encode( $raw ), '+/', '-_' ), '=' ); // phpcs:ignore
	}

	/** Starts a NEW pairing attempt and returns the URL to open in the admin's browser. */
	public static function start(): string {
		if ( ! self::app_base_url_configured() ) {
			throw new \RuntimeException( 'Enter your Web Yar URL below before connecting.' );
		}

		$state          = self::base64url( random_bytes( 24 ) );
		$code_verifier  = self::base64url( random_bytes( 32 ) );
		$code_challenge = self::base64url( hash( 'sha256', $code_verifier, true ) );
		$redirect_uri   = self::redirect_uri();
		$store_origin   = self::store_origin();

		update_option(
			self::STATE_OPTION,
			array(
				'state'         => $state,
				'code_verifier' => $code_verifier,
				'created_at'    => time(),
			),
			false
		);

		$register = wp_remote_post(
			trailingslashit( self::app_base_url() ) . 'api/commerce/pairing/register',
			array(
				'timeout' => 10,
				'headers' => array( 'Content-Type' => 'application/json' ),
				'body'    => wp_json_encode(
					array(
						'state'         => $state,
						'codeChallenge' => $code_challenge,
						'redirectUri'   => $redirect_uri,
						'storeOrigin'   => $store_origin,
					)
				),
			)
		);

		if ( is_wp_error( $register ) ) {
			Logger::error( 'pairing register failed', array( 'error' => $register->get_error_message() ) );
			throw new \RuntimeException( 'Could not reach ' . self::app_base_url() . ' — ' . $register->get_error_message() );
		}
		$register_status = wp_remote_retrieve_response_code( $register );
		if ( $register_status >= 400 ) {
			$body = wp_remote_retrieve_body( $register );
			Logger::error( 'pairing register rejected', array( 'status' => $register_status ) );
			throw new \RuntimeException( sprintf(
				'Web Yar rejected the pairing request (HTTP %d) at %s. Check that the Web Yar URL is correct and that the site is reachable.',
				$register_status,
				self::app_base_url()
			) );
		}

		return trailingslashit( self::app_base_url() ) . 'commerce/authorize?' . http_build_query(
			array(
				'state'    => $state,
				'provider' => 'woocommerce',
			)
		);
	}

	/**
	 * Completes pairing after the admin's browser is redirected back with
	 * `code` + `state`. Called from Admin/ConnectionController.php.
	 *
	 * @return array{installationId:string,installationSecret:string,workspaceId:string,storeId:string,protocolVersion:string}
	 */
	public static function complete( string $code, string $state ): array {
		$pending = get_option( self::STATE_OPTION, null );
		if ( ! is_array( $pending ) || ( $pending['state'] ?? '' ) !== $state ) {
			throw new \RuntimeException( 'Pairing state mismatch — please try connecting again.' );
		}
		if ( time() - (int) ( $pending['created_at'] ?? 0 ) > 600 ) {
			delete_option( self::STATE_OPTION );
			throw new \RuntimeException( 'Pairing request expired — please try connecting again.' );
		}

		$response = wp_remote_post(
			trailingslashit( self::app_base_url() ) . 'api/commerce/pairing/exchange',
			array(
				'timeout' => 15,
				'headers' => array( 'Content-Type' => 'application/json' ),
				'body'    => wp_json_encode(
					array(
						'state'        => $state,
						'code'         => $code,
						'codeVerifier' => $pending['code_verifier'],
					)
				),
			)
		);

		delete_option( self::STATE_OPTION ); // single-use regardless of outcome

		if ( is_wp_error( $response ) ) {
			throw new \RuntimeException( 'Could not reach Web Yar to complete pairing — ' . $response->get_error_message() );
		}
		$code_status = wp_remote_retrieve_response_code( $response );
		$body        = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( $code_status >= 400 || ! is_array( $body ) || empty( $body['installationSecret'] ) ) {
			throw new \RuntimeException( 'Web Yar rejected the pairing exchange.' );
		}

		return array(
			'installationId'     => (string) $body['installationId'],
			'installationSecret' => (string) $body['installationSecret'],
			'workspaceId'        => (string) $body['workspaceId'],
			'storeId'            => (string) $body['storeId'],
			'protocolVersion'    => (string) $body['protocolVersion'],
		);
	}

	private static function redirect_uri(): string {
		return admin_url( 'admin-post.php?action=webyar_wc_pairing_callback' );
	}

	/** Exact scheme+host(+port) — never a caller-supplied value (spec §81 origin canonicalization). */
	private static function store_origin(): string {
		$parts = wp_parse_url( home_url() );
		$origin = ( $parts['scheme'] ?? 'https' ) . '://' . ( $parts['host'] ?? '' );
		if ( ! empty( $parts['port'] ) ) {
			$origin .= ':' . $parts['port'];
		}
		return $origin;
	}
}
