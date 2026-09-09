<?php
namespace WebYar\WooCommerce\Admin;

use WebYar\WooCommerce\Auth\CredentialStore;
use WebYar\WooCommerce\Auth\PairingService;
use WebYar\WooCommerce\Auth\RequestSigner;
use WebYar\WooCommerce\Support\Capabilities;
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

	private function require_manage_capability(): void {
		if ( ! Capabilities::current_user_can_manage() ) {
			wp_die( esc_html__( 'You do not have permission to manage the Web Yar connection.', 'webyar-woocommerce' ), 403 );
		}
	}

	public function connect(): void {
		$this->require_manage_capability();
		check_admin_referer( 'webyar_wc_connect' );

		try {
			$url = PairingService::start();
		} catch ( \Throwable $e ) {
			Logger::error( 'connect failed', array( 'message' => $e->getMessage() ) );
			$this->redirect_with_notice( 'error', __( 'Could not start the connection. Please try again.', 'webyar-woocommerce' ) );
			return;
		}
		wp_redirect( $url ); // phpcs:ignore
		exit;
	}

	/** Web Yar redirects the admin's browser BACK here with ?code=...&state=... after authorization. */
	public function pairing_callback(): void {
		$this->require_manage_capability();
		$code  = isset( $_GET['code'] ) ? sanitize_text_field( wp_unslash( $_GET['code'] ) ) : ''; // phpcs:ignore
		$state = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : ''; // phpcs:ignore

		if ( '' === $code || '' === $state ) {
			$this->redirect_with_notice( 'error', __( 'Invalid pairing callback.', 'webyar-woocommerce' ) );
			return;
		}

		try {
			$result = PairingService::complete( $code, $state );
			CredentialStore::save(
				array(
					'installation_id'     => $result['installationId'],
					'workspace_id'        => $result['workspaceId'],
					'store_id'            => $result['storeId'],
					'protocol_version'    => $result['protocolVersion'],
					'installation_secret' => $result['installationSecret'],
					'capabilities'        => Capabilities::declared(),
					'approved_origin'     => home_url(),
					'created_at'          => time(),
					'rotated_at'          => null,
				)
			);
			$this->redirect_with_notice( 'success', __( 'Connected to Web Yar.', 'webyar-woocommerce' ) );
		} catch ( \Throwable $e ) {
			Logger::error( 'pairing exchange failed', array( 'message' => $e->getMessage() ) );
			$this->redirect_with_notice( 'error', __( 'Could not complete the connection to Web Yar.', 'webyar-woocommerce' ) );
		}
	}

	public function disconnect(): void {
		$this->require_manage_capability();
		check_admin_referer( 'webyar_wc_disconnect' );

		$credential = CredentialStore::get();
		if ( $credential ) {
			$this->notify_disconnect( $credential );
		}
		// Local state is cleared regardless of whether Web Yar could be
		// reached (spec §54/§55 — local cleanup must not depend on network).
		CredentialStore::clear();
		\WebYar\WooCommerce\Events\EventQueue::cancel_all();

		$this->redirect_with_notice( 'success', __( 'Disconnected from Web Yar.', 'webyar-woocommerce' ) );
	}

	private function notify_disconnect( array $credential ): void {
		$path = '/api/workspaces/' . rawurlencode( $credential['workspace_id'] ) . '/commerce/connections/' . rawurlencode( $credential['installation_id'] ) . '/disconnect';
		// Best-effort — local secret deletion proceeds unconditionally right
		// after this call regardless of the outcome.
		wp_remote_post(
			trailingslashit( PairingService::app_base_url() ) . ltrim( $path, '/' ),
			array( 'timeout' => 5, 'blocking' => false )
		);
	}

	public function test_connection(): void {
		$this->require_manage_capability();
		check_admin_referer( 'webyar_wc_test_connection' );
		// The actual health probe runs server-side on Web Yar (it calls
		// THIS plugin's /health route) — this button just asks Web Yar to
		// run it now.
		$credential = CredentialStore::get();
		if ( $credential ) {
			wp_remote_post(
				trailingslashit( PairingService::app_base_url() ) . 'api/workspaces/' . rawurlencode( $credential['workspace_id'] ) . '/commerce/connections/' . rawurlencode( $credential['installation_id'] ) . '/test',
				array( 'timeout' => 10 )
			);
		}
		$this->redirect_with_notice( 'success', __( 'Connection test requested.', 'webyar-woocommerce' ) );
	}

	public function sync_now(): void {
		$this->require_manage_capability();
		check_admin_referer( 'webyar_wc_sync_now' );
		$credential = CredentialStore::get();
		if ( $credential ) {
			wp_remote_post(
				trailingslashit( PairingService::app_base_url() ) . 'api/workspaces/' . rawurlencode( $credential['workspace_id'] ) . '/commerce/connections/' . rawurlencode( $credential['installation_id'] ) . '/sync',
				array( 'timeout' => 10 )
			);
		}
		$this->redirect_with_notice( 'success', __( 'Sync requested.', 'webyar-woocommerce' ) );
	}

	public function save_settings(): void {
		$this->require_manage_capability();
		check_admin_referer( 'webyar_wc_save_settings' );

		update_option(
			'webyar_wc_settings',
			array(
				'auto_widget' => ! empty( $_POST['auto_widget'] ), // phpcs:ignore
			)
		);
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
