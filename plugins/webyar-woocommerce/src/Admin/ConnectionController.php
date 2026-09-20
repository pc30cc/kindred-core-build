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

	private function require_manage_capability(): void {
		if ( ! Capabilities::current_user_can_manage() ) {
			wp_die( esc_html__( 'شما اجازه‌ی مدیریت اتصال وب‌یار را ندارید.', 'webyar-woocommerce' ), 403 );
		}
	}

	public function connect(): void {
		$this->require_manage_capability();
		check_admin_referer( 'webyar_wc_connect' );

		// The Web Yar URL is entered on the SAME form as the Connect button
		// (there is no single fixed Web Yar domain — this is a self-hostable
		// platform) — save it here, before starting pairing, so one click
		// both configures and connects.
		$raw_app_url = isset( $_POST['app_url'] ) ? esc_url_raw( wp_unslash( $_POST['app_url'] ) ) : ''; // phpcs:ignore
		if ( '' === $raw_app_url || false === filter_var( $raw_app_url, FILTER_VALIDATE_URL ) ) {
			$this->redirect_with_notice( 'error', __( 'پیش از اتصال، یک آدرس معتبر وب‌یار وارد کنید (مثلاً https://app.webyar.ai).', 'webyar-woocommerce' ) );
			return;
		}
		$settings = get_option( 'webyar_wc_settings', array() );
		if ( ! is_array( $settings ) ) {
			$settings = array();
		}
		$settings['app_url'] = untrailingslashit( $raw_app_url );
		update_option( 'webyar_wc_settings', $settings, false );

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
		$this->require_manage_capability();
		$code  = isset( $_GET['code'] ) ? sanitize_text_field( wp_unslash( $_GET['code'] ) ) : ''; // phpcs:ignore
		$state = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : ''; // phpcs:ignore

		if ( '' === $code || '' === $state ) {
			$this->redirect_with_notice( 'error', __( 'بازگشت نامعتبر از فرآیند اتصال.', 'webyar-woocommerce' ) );
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
			EventDelivery::clear_auth_error(); // fresh credential — any earlier rejection is stale
			$this->redirect_with_notice( 'success', __( 'به وب‌یار متصل شدید.', 'webyar-woocommerce' ) );
		} catch ( \Throwable $e ) {
			Logger::error( 'pairing exchange failed', array( 'message' => $e->getMessage() ) );
			$this->redirect_with_notice( 'error', $e->getMessage() );
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
		EventDelivery::clear_auth_error();
		\WebYar\WooCommerce\Events\EventQueue::cancel_all();

		$this->redirect_with_notice( 'success', __( 'اتصال به وب‌یار قطع شد.', 'webyar-woocommerce' ) );
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
		$this->relay_connection_action( 'test', __( 'درخواست تست اتصال ارسال شد.', 'webyar-woocommerce' ) );
	}

	public function sync_now(): void {
		$this->require_manage_capability();
		check_admin_referer( 'webyar_wc_sync_now' );
		$this->relay_connection_action( 'sync', __( 'درخواست همگام‌سازی ارسال شد.', 'webyar-woocommerce' ) );
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
			$this->redirect_with_notice( 'error', __( 'فروشگاه به وب‌یار متصل نیست.', 'webyar-woocommerce' ) );
			return;
		}

		$response = wp_remote_post(
			trailingslashit( PairingService::app_base_url() ) . 'api/workspaces/' . rawurlencode( $credential['workspace_id'] ) . '/commerce/connections/' . rawurlencode( $credential['installation_id'] ) . '/' . $action,
			array( 'timeout' => 10 )
		);

		if ( is_wp_error( $response ) ) {
			Logger::error( 'connection action failed', array( 'action' => $action, 'error' => $response->get_error_message() ) );
			$this->redirect_with_notice(
				'error',
				sprintf(
					/* translators: %s: underlying network error message */
					__( 'ارتباط با وب‌یار برقرار نشد — %s', 'webyar-woocommerce' ),
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
			$this->redirect_with_notice(
				'error',
				__( 'وب‌یار این درخواست را نپذیرفت (نیازمند ورود کاربر است). این کار را از داشبورد وب‌یار، بخش یکپارچه‌سازی‌ها ← فروشگاه انجام دهید.', 'webyar-woocommerce' )
			);
			return;
		}
		$this->redirect_with_notice(
			'error',
			sprintf(
				/* translators: %d: HTTP status code Web Yar replied with */
				__( 'وب‌یار این درخواست را رد کرد (کد %d).', 'webyar-woocommerce' ),
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
		$this->redirect_with_notice( 'success', __( 'تنظیمات ذخیره شد.', 'webyar-woocommerce' ) );
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
