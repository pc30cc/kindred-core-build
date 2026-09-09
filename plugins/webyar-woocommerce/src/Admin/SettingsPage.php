<?php
namespace WebYar\WooCommerce\Admin;

use WebYar\WooCommerce\Auth\CredentialStore;
use WebYar\WooCommerce\Support\Capabilities;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The ENTIRE WordPress-side admin UI (spec §34/§84). No AI prompt/model
 * settings, no analytics dashboard, no Knowledge Base editor — those live
 * in Web Yar. This is a small, professional settings screen only.
 */
final class SettingsPage {

	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
	}

	public function add_menu(): void {
		add_menu_page(
			__( 'Web Yar', 'webyar-woocommerce' ),
			__( 'Web Yar', 'webyar-woocommerce' ),
			Capabilities::MANAGE_CAPABILITY,
			'webyar-woocommerce',
			array( $this, 'render' ),
			'dashicons-cart',
			58
		);
	}

	public function render(): void {
		if ( ! Capabilities::current_user_can_manage() ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'webyar-woocommerce' ) );
		}

		$credential = CredentialStore::get();
		$settings   = get_option( 'webyar_wc_settings', array( 'auto_widget' => true ) );

		$notice_type    = isset( $_GET['webyar_notice'] ) ? sanitize_key( $_GET['webyar_notice'] ) : null; // phpcs:ignore
		$notice_message = isset( $_GET['webyar_message'] ) ? sanitize_text_field( wp_unslash( $_GET['webyar_message'] ) ) : null; // phpcs:ignore
		?>
		<div class="wrap" dir="<?php echo is_rtl() ? 'rtl' : 'ltr'; ?>">
			<h1><?php esc_html_e( 'Web Yar', 'webyar-woocommerce' ); ?></h1>

			<?php if ( $notice_type && $notice_message ) : ?>
				<div class="notice notice-<?php echo 'error' === $notice_type ? 'error' : 'success'; ?> is-dismissible">
					<p><?php echo esc_html( $notice_message ); ?></p>
				</div>
			<?php endif; ?>

			<?php if ( null === $credential ) : ?>
				<p><?php esc_html_e( 'Connect this store to Web Yar so its AI Assistant can answer product, price, and order questions from real store data.', 'webyar-woocommerce' ); ?></p>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<?php wp_nonce_field( 'webyar_wc_connect' ); ?>
					<input type="hidden" name="action" value="webyar_wc_connect" />
					<button type="submit" class="button button-primary button-hero"><?php esc_html_e( 'Connect to Web Yar', 'webyar-woocommerce' ); ?></button>
				</form>
			<?php else : ?>
				<h2><?php esc_html_e( 'Connection', 'webyar-woocommerce' ); ?></h2>
				<table class="widefat striped" style="max-width:640px">
					<tbody>
						<tr>
							<td><?php esc_html_e( 'Store', 'webyar-woocommerce' ); ?></td>
							<td><?php echo esc_html( wp_parse_url( home_url(), PHP_URL_HOST ) ); ?></td>
						</tr>
						<tr>
							<td><?php esc_html_e( 'Status', 'webyar-woocommerce' ); ?></td>
							<td><strong style="color:#2271b1"><?php esc_html_e( 'Connected', 'webyar-woocommerce' ); ?></strong></td>
						</tr>
					</tbody>
				</table>

				<h2><?php esc_html_e( 'Widget', 'webyar-woocommerce' ); ?></h2>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<?php wp_nonce_field( 'webyar_wc_save_settings' ); ?>
					<input type="hidden" name="action" value="webyar_wc_save_settings" />
					<label>
						<input type="checkbox" name="auto_widget" value="1" <?php checked( ! empty( $settings['auto_widget'] ) ); ?> />
						<?php esc_html_e( 'Automatically load the Web Yar chat widget on the storefront', 'webyar-woocommerce' ); ?>
					</label>
					<p><button type="submit" class="button"><?php esc_html_e( 'Save', 'webyar-woocommerce' ); ?></button></p>
				</form>

				<p>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline">
						<?php wp_nonce_field( 'webyar_wc_test_connection' ); ?>
						<input type="hidden" name="action" value="webyar_wc_test_connection" />
						<button type="submit" class="button"><?php esc_html_e( 'Test connection', 'webyar-woocommerce' ); ?></button>
					</form>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline">
						<?php wp_nonce_field( 'webyar_wc_sync_now' ); ?>
						<input type="hidden" name="action" value="webyar_wc_sync_now" />
						<button type="submit" class="button"><?php esc_html_e( 'Sync now', 'webyar-woocommerce' ); ?></button>
					</form>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline" onsubmit="return confirm('<?php echo esc_js( __( 'Disconnect this store from Web Yar?', 'webyar-woocommerce' ) ); ?>');">
						<?php wp_nonce_field( 'webyar_wc_disconnect' ); ?>
						<input type="hidden" name="action" value="webyar_wc_disconnect" />
						<button type="submit" class="button button-link-delete"><?php esc_html_e( 'Disconnect', 'webyar-woocommerce' ); ?></button>
					</form>
				</p>

				<?php DiagnosticsPage::render( $credential ); ?>

				<p style="margin-top:16px;color:#666">
					<?php esc_html_e( 'Product catalog, pricing, stock, orders, permissions, and synchronization status are managed from your Web Yar dashboard under Integrations → Commerce.', 'webyar-woocommerce' ); ?>
				</p>
			<?php endif; ?>
		</div>
		<?php
	}
}
