<?php
namespace WebYar\WooCommerce\Admin;

use WebYar\WooCommerce\Auth\CredentialStore;
use WebYar\WooCommerce\Auth\PairingService;
use WebYar\WooCommerce\Auth\RequestSigner;
use WebYar\WooCommerce\Support\Capabilities;
use WebYar\WooCommerce\Events\EventDelivery;
use WebYar\WooCommerce\Support\Logger;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * admin-post.php handlers for the Settings page actions. WordPress nonces
 * are CSRF protection for these form submissions ONLY — never treated as
 * server authentication for the machine (REST) surface (spec §8/§78).
 */
final class ConnectionController {

	public function register(): void {
		add_action( 'admin_post_webyar_wc_connect', array( $this, 'connect' ) );
		add_action( 'admin_post_webyar_wc_pairing_callback', array( $this, 'pairing_callback' ) );
		add_action( 'admin_post_webyar_wc_disconnect', array( $this, 'disconnect' ) );
		add_action( 'admin_post_webyar_wc_test_connection', array( $this, 'test_connection' ) );
		add_action( 'admin_post_webyar_wc_sync_now', array( $this, 'sync_now' ) );
		add_action( 'admin_post_webyar_wc_save_settings', array( $this, 'save_settings' ) );
	}

	/** Day-to-day actions: test, sync, widget toggle. */
	private function require_manage_capability(): void {
		if ( ! Capabilities::current_user_can_manage() ) {
			wp_die( esc_html__( 'You cannot manage the WebYar connection.', 'webyar-woocommerce' ), 403 );
		}
	}

	/**
	 * Anything that decides which Web Yar the store trusts (URLs, connect,
	 * disconnect). Administrators only — see Capabilities.
	 */
	private function require_connect_capability(): void {
		if ( ! Capabilities::current_user_can_connect() ) {
			wp_die( esc_html__( 'Only a site administrator can connect or disconnect WebYar.', 'webyar-woocommerce' ), 403 );
		}
	}

	public function connect(): void {
		// Authorisation and CSRF first: nothing from the form is read, let
		// alone saved, for anyone else.
		$this->require_connect_capability();
		check_admin_referer( 'webyar_wc_connect' );

		// The Web Yar URL is entered on the SAME form as the Connect button
		// (there is no single fixed Web Yar domain — this is a self-hostable
		// platform) — save it here, before starting pairing, so one click
		// both configures and connects. https only: the storefront loads the
		// widget script from it and pairing sends secrets to it.
		$app_url = PairingService::normalize_base_url( isset( $_POST['app_url'] ) ? (string) wp_unslash( $_POST['app_url'] ) : '' ); // phpcs:ignore
		if ( '' === $app_url ) {
			$this->redirect_with_notice( 'error', __( 'Enter a valid https WebYar URL before connecting (for example, https://app.webyar.ai).', 'webyar-woocommerce' ) );
			return;
		}
		// Optional: a separate origin for the machine API. Empty means "same
		// as the dashboard URL", which is the documented same-origin layout.
		$raw_api_url = isset( $_POST['api_url'] ) ? trim( (string) wp_unslash( $_POST['api_url'] ) ) : ''; // phpcs:ignore
		$api_url     = '' === $raw_api_url ? '' : PairingService::normalize_base_url( $raw_api_url );
		if ( '' !== $raw_api_url && '' === $api_url ) {
			$this->redirect_with_notice( 'error', __( 'Enter a valid https API URL or leave the field empty.', 'webyar-woocommerce' ) );
			return;
		}

		$settings = get_option( 'webyar_wc_settings', array() );
		if ( ! is_array( $settings ) ) {
			$settings = array();
		}
		$settings['app_url'] = $app_url;
		$settings['api_url'] = $api_url;
		update_option( 'webyar_wc_settings', $settings, false );
		\WebYar\WooCommerce\Support\Updater::forget(); // a new origin: check its release afresh

		try {
			$url = PairingService::start();
		} catch ( \Throwable $e ) {
			Logger::error( 'connect failed', array( 'message' => $e->getMessage() ) );
			// The exception message here never contains a secret (see
			// PairingService::start()) — surfacing it is what turns "the
			// button doesn't work" into an actionable error for the admin.
			$this->redirect_with_notice( 'error', $e->getMessage() );
			return;
		}
		wp_redirect( $url ); // phpcs:ignore
		exit;
	}

	/** Web Yar redirects the admin's browser BACK here with ?code=...&state=... after authorization. */
	public function pairing_callback(): void {
		$this->require_connect_capability();
		$code  = isset( $_GET['code'] ) ? sanitize_text_field( wp_unslash( $_GET['code'] ) ) : ''; // phpcs:ignore
		$state = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : ''; // phpcs:ignore

		if ( '' === $code || '' === $state ) {
			$this->redirect_with_notice( 'error', __( 'Invalid connection callback.', 'webyar-woocommerce' ) );
			return;
		}

		try {
			$result = PairingService::complete( $code, $state );
			CredentialStore::save(
				array(
					'installation_id'     => $result['installationId'],
					'workspace_id'        => $result['workspaceId'],
					'connection_id'       => $result['connectionId'],
					'store_id'            => $result['storeId'],
					'protocol_version'    => $result['protocolVersion'],
					'installation_secret' => $result['installationSecret'],
					'capabilities'        => Capabilities::declared(),
					'approved_origin'     => home_url(),
					'created_at'          => time(),
					'rotated_at'          => null,
				)
			);
			EventDelivery::clear_auth_error(); // fresh credential — any earlier rejection is stale
			$this->redirect_with_notice( 'success', __( 'Connected to WebYar.', 'webyar-woocommerce' ) );
		} catch ( \Throwable $e ) {
			Logger::error( 'pairing exchange failed', array( 'message' => $e->getMessage() ) );
			$this->redirect_with_notice( 'error', $e->getMessage() );
		}
	}

	public function disconnect(): void {
		$this->require_connect_capability();
		check_admin_referer( 'webyar_wc_disconnect' );

		$credential = CredentialStore::get();
		if ( $credential ) {
			$this->notify_disconnect( $credential );
		}
		// Local state is cleared regardless of whether Web Yar could be
		// reached (spec §54/§55 — local cleanup must not depend on network).
		CredentialStore::clear();
		EventDelivery::clear_auth_error();
		\WebYar\WooCommerce\Events\EventQueue::cancel_all();

		$this->redirect_with_notice( 'success', __( 'Disconnected from WebYar.', 'webyar-woocommerce' ) );
	}

	private function notify_disconnect( array $credential ): void {
		$path = '/api/commerce/connection/disconnect';
		// Best-effort — local secret deletion proceeds unconditionally right
		// after this call regardless of the outcome. Signed like every other
		// machine call, because an unsigned one is simply refused.
		wp_remote_post(
			trailingslashit( PairingService::api_base_url() ) . ltrim( $path, '/' ),
			array(
				'timeout'  => 5,
				'blocking' => false,
				'headers'  => RequestSigner::build_headers( $credential['installation_secret'], $credential['installation_id'], 'POST', $path, '' ),
			)
		);
	}

	public function test_connection(): void {
		$this->require_manage_capability();
		check_admin_referer( 'webyar_wc_test_connection' );
		// The actual health probe runs server-side on Web Yar (it calls
		// THIS plugin's /health route) — this button just asks Web Yar to
		// run it now.
		$this->relay_connection_action( 'test', __( 'Connection test requested.', 'webyar-woocommerce' ) );
	}

	public function sync_now(): void {
		$this->require_manage_capability();
		check_admin_referer( 'webyar_wc_sync_now' );
		$this->relay_connection_action( 'sync', __( 'Product sync requested.', 'webyar-woocommerce' ) );
	}

	/**
	 * Asks Web Yar to run a connection-management action, and reports what
	 * ACTUALLY happened.
	 *
	 * These endpoints are guarded by a logged-in workspace member's session,
	 * while this call is server-to-server from WordPress with no session to
	 * offer — so it currently comes back 401. Announcing "sent" regardless,
	 * as this used to, left the admin believing a sync had started when
	 * nothing had; a button that cannot work must at least say so.
	 */
	private function relay_connection_action( string $action, string $success_message ): void {
		$credential = CredentialStore::get();
		if ( null === $credential ) {
			$this->redirect_with_notice( 'error', __( 'The store is not connected to WebYar.', 'webyar-woocommerce' ) );
			return;
		}

		// Signed, store-authenticated route. The dashboard equivalents under
		// /api/workspaces/... require a logged-in member's session, which a
		// server-to-server call from WordPress cannot present — they answered
		// 401 every time. Here the installation secret IS the credential, and
		// Web Yar resolves the connection from it.
		$path    = '/api/commerce/connection/' . $action;
		$headers = RequestSigner::build_headers( $credential['installation_secret'], $credential['installation_id'], 'POST', $path, '' );
		$response = wp_remote_post(
			trailingslashit( PairingService::api_base_url() ) . ltrim( $path, '/' ),
			array( 'timeout' => 15, 'headers' => $headers )
		);

		if ( is_wp_error( $response ) ) {
			Logger::error( 'connection action failed', array( 'action' => $action, 'error' => $response->get_error_message() ) );
			$this->redirect_with_notice(
				'error',
				sprintf(
					/* translators: %s: underlying network error message */
					__( 'Could not reach WebYar: %s', 'webyar-woocommerce' ),
					$response->get_error_message()
				)
			);
			return;
		}

		$status = wp_remote_retrieve_response_code( $response );
		if ( $status >= 200 && $status < 300 ) {
			$this->redirect_with_notice( 'success', $success_message );
			return;
		}

		Logger::error( 'connection action rejected', array( 'action' => $action, 'status' => $status ) );
		if ( 401 === $status || 403 === $status ) {
			// The signature was rejected or the connection was revoked — the
			// same condition the event queue surfaces, so mark it the same way.
			update_option( \WebYar\WooCommerce\Events\EventDelivery::AUTH_ERROR_OPTION, array( 'status' => $status, 'at' => gmdate( 'c' ) ), false );
			$this->redirect_with_notice(
				'error',
				__( 'WebYar rejected this store’s credentials. Disconnect and reconnect the store.', 'webyar-woocommerce' )
			);
			return;
		}
		if ( 404 === $status ) {
			$this->redirect_with_notice(
				'error',
				__( 'Your WebYar server does not support this action. Update WebYar.', 'webyar-woocommerce' )
			);
			return;
		}
		$this->redirect_with_notice(
			'error',
			sprintf(
				/* translators: %d: HTTP status code Web Yar replied with */
				__( 'WebYar rejected this request (code %d).', 'webyar-woocommerce' ),
				$status
			)
		);
	}

	public function save_settings(): void {
		$this->require_manage_capability();
		check_admin_referer( 'webyar_wc_save_settings' );

		// Merge, never replace — this form only carries `auto_widget`, and
		// a bare overwrite here would silently erase the saved `app_url`
		// (and any future setting) every time the widget toggle is saved.
		$settings = get_option( 'webyar_wc_settings', array() );
		if ( ! is_array( $settings ) ) {
			$settings = array();
		}
		$settings['auto_widget'] = ! empty( $_POST['auto_widget'] ); // phpcs:ignore
		update_option( 'webyar_wc_settings', $settings, false );
		$this->redirect_with_notice( 'success', __( 'Settings saved.', 'webyar-woocommerce' ) );
	}

	private function redirect_with_notice( string $type, string $message ): void {
		$url = add_query_arg(
			array( 'page' => 'webyar-woocommerce', 'webyar_notice' => $type, 'webyar_message' => rawurlencode( $message ) ),
			admin_url( 'admin.php' )
		);
		wp_redirect( $url ); // phpcs:ignore
		exit;
	}
}
