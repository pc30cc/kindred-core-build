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
 *
 * All strings are Persian by default — Web Yar's audience is Persian-
 * speaking Iranian merchants, so this screen must read correctly regardless
 * of the WordPress site's own locale setting. Strings still go through
 * __()/esc_html_e() (text domain webyar-woocommerce) so a site that DOES
 * need a different language can still override them with a standard
 * WordPress translation file.
 */
final class SettingsPage {

	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
	}

	public function add_menu(): void {
		add_menu_page(
			__( 'وب‌یار', 'webyar-woocommerce' ),
			__( 'وب‌یار', 'webyar-woocommerce' ),
			Capabilities::MANAGE_CAPABILITY,
			'webyar-woocommerce',
			array( $this, 'render' ),
			'dashicons-cart',
			58
		);
	}

	public function render(): void {
		if ( ! Capabilities::current_user_can_manage() ) {
			wp_die( esc_html__( 'شما اجازه‌ی دسترسی به این صفحه را ندارید.', 'webyar-woocommerce' ) );
		}

		$credential = CredentialStore::get();
		$settings   = get_option( 'webyar_wc_settings', array( 'auto_widget' => true ) );

		$notice_type    = isset( $_GET['webyar_notice'] ) ? sanitize_key( $_GET['webyar_notice'] ) : null; // phpcs:ignore
		$notice_message = isset( $_GET['webyar_message'] ) ? sanitize_text_field( wp_unslash( $_GET['webyar_message'] ) ) : null; // phpcs:ignore
		?>
		<div class="wrap" dir="rtl" style="text-align:right">
			<h1><?php esc_html_e( 'وب‌یار', 'webyar-woocommerce' ); ?></h1>

			<?php if ( $notice_type && $notice_message ) : ?>
				<div class="notice notice-<?php echo 'error' === $notice_type ? 'error' : 'success'; ?> is-dismissible">
					<p><?php echo esc_html( $notice_message ); ?></p>
				</div>
			<?php endif; ?>

			<?php if ( null === $credential ) : ?>
				<p><?php esc_html_e( 'فروشگاه خود را به وب‌یار متصل کنید تا دستیار هوش مصنوعی بتواند از داده‌های واقعی فروشگاه به سؤالات مربوط به محصول، قیمت و سفارش پاسخ دهد.', 'webyar-woocommerce' ); ?></p>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<?php wp_nonce_field( 'webyar_wc_connect' ); ?>
					<input type="hidden" name="action" value="webyar_wc_connect" />
					<table class="form-table" role="presentation">
						<tr>
							<th scope="row"><label for="webyar_wc_app_url"><?php esc_html_e( 'آدرس وب‌یار', 'webyar-woocommerce' ); ?></label></th>
							<td>
								<input
									type="url" id="webyar_wc_app_url" name="app_url" class="regular-text" dir="ltr" required
									placeholder="https://app.webyar.ai"
									value="<?php echo esc_attr( $settings['app_url'] ?? '' ); ?>"
								/>
								<p class="description"><?php esc_html_e( 'آدرس داشبورد وب‌یار شما (سرور مشترک واحدی وجود ندارد — همان آدرسی را وارد کنید که با آن وارد حساب کاربری خود می‌شوید، مثلاً https://app.webyar.ai).', 'webyar-woocommerce' ); ?></p>
							</td>
						</tr>
					</table>
					<button type="submit" class="button button-primary button-hero"><?php esc_html_e( 'اتصال به وب‌یار', 'webyar-woocommerce' ); ?></button>
				</form>
			<?php else : ?>
				<h2><?php esc_html_e( 'اتصال', 'webyar-woocommerce' ); ?></h2>
				<table class="widefat striped" style="max-width:640px">
					<tbody>
						<tr>
							<td><?php esc_html_e( 'فروشگاه', 'webyar-woocommerce' ); ?></td>
							<td dir="ltr" style="text-align:left"><?php echo esc_html( wp_parse_url( home_url(), PHP_URL_HOST ) ); ?></td>
						</tr>
						<tr>
							<td><?php esc_html_e( 'وضعیت', 'webyar-woocommerce' ); ?></td>
							<td>
								<?php
								// A stored credential is not the same as a WORKING one: if
								// Web Yar rotated or revoked the secret, every signed call
								// fails while this row would still read "connected".
								$auth_error = get_option( \WebYar\WooCommerce\Events\EventDelivery::AUTH_ERROR_OPTION, null );
								if ( is_array( $auth_error ) ) :
									?>
									<strong style="color:#d63638"><?php esc_html_e( 'اعتبارنامه پذیرفته نمی‌شود', 'webyar-woocommerce' ); ?></strong>
									<p class="description">
										<?php
										printf(
											/* translators: 1: HTTP status Web Yar replied with, 2: UTC time of the rejection */
											esc_html__( 'وب‌یار آخرین درخواست امضاشده را با کد %1$d رد کرد (%2$s). معمولاً یعنی کلید اتصال در وب‌یار چرخانده یا باطل شده — یک بار «قطع اتصال» و دوباره «اتصال به وب‌یار» را بزنید.', 'webyar-woocommerce' ),
											(int) ( $auth_error['status'] ?? 0 ),
											esc_html( (string) ( $auth_error['at'] ?? '' ) )
										);
										?>
									</p>
								<?php else : ?>
									<strong style="color:#2271b1"><?php esc_html_e( 'متصل', 'webyar-woocommerce' ); ?></strong>
								<?php endif; ?>
							</td>
						</tr>
					</tbody>
				</table>

				<h2><?php esc_html_e( 'ویجت', 'webyar-woocommerce' ); ?></h2>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<?php wp_nonce_field( 'webyar_wc_save_settings' ); ?>
					<input type="hidden" name="action" value="webyar_wc_save_settings" />
					<label>
						<input type="checkbox" name="auto_widget" value="1" <?php checked( ! empty( $settings['auto_widget'] ) ); ?> />
						<?php esc_html_e( 'بارگذاری خودکار ویجت گفتگوی وب‌یار در فروشگاه', 'webyar-woocommerce' ); ?>
					</label>
					<p><button type="submit" class="button"><?php esc_html_e( 'ذخیره', 'webyar-woocommerce' ); ?></button></p>
				</form>

				<p>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline">
						<?php wp_nonce_field( 'webyar_wc_test_connection' ); ?>
						<input type="hidden" name="action" value="webyar_wc_test_connection" />
						<button type="submit" class="button"><?php esc_html_e( 'تست اتصال', 'webyar-woocommerce' ); ?></button>
					</form>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline">
						<?php wp_nonce_field( 'webyar_wc_sync_now' ); ?>
						<input type="hidden" name="action" value="webyar_wc_sync_now" />
						<button type="submit" class="button"><?php esc_html_e( 'همگام‌سازی اکنون', 'webyar-woocommerce' ); ?></button>
					</form>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline" onsubmit="return confirm('<?php echo esc_js( __( 'اتصال این فروشگاه به وب‌یار قطع شود؟', 'webyar-woocommerce' ) ); ?>');">
						<?php wp_nonce_field( 'webyar_wc_disconnect' ); ?>
						<input type="hidden" name="action" value="webyar_wc_disconnect" />
						<button type="submit" class="button button-link-delete"><?php esc_html_e( 'قطع اتصال', 'webyar-woocommerce' ); ?></button>
					</form>
				</p>

				<?php DiagnosticsPage::render( $credential ); ?>

				<p style="margin-top:16px;color:#666">
					<?php esc_html_e( 'کاتالوگ محصولات، قیمت‌گذاری، موجودی، سفارش‌ها، سطوح دسترسی و وضعیت همگام‌سازی از داشبورد وب‌یار، در بخش یکپارچه‌سازی‌ها ← فروشگاه، مدیریت می‌شوند.', 'webyar-woocommerce' ); ?>
				</p>
			<?php endif; ?>
		</div>
		<?php
	}
}
