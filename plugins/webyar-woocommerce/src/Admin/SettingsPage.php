<?php
namespace WebYar\WooCommerce\Admin;

use WebYar\WooCommerce\Auth\CredentialStore;
use WebYar\WooCommerce\Auth\PairingService;
use WebYar\WooCommerce\Events\EventDelivery;
use WebYar\WooCommerce\Support\Capabilities;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The ENTIRE WordPress-side admin UI (spec §34/§84). No AI prompt/model
 * settings, no analytics dashboard, no Knowledge Base editor — those live
 * in Web Yar. This is a small, professional settings screen only.
 *
 * What a shop owner needs from this screen is short: is my store connected,
 * does the assistant appear on my site, and how do I stop it. Everything
 * else — protocol version, installation identifiers, delivery failures — is
 * for the one day something breaks, so it sits behind a disclosure instead
 * of competing with the three things that matter.
 *
 * WordPress selects the translation for the current admin language.
 * English is the source locale, and Persian is shipped in languages/.
 */
final class SettingsPage {

	private const PAGE_SLUG = 'webyar-woocommerce';

	/**
	 * Vazirmatn — the de-facto standard Persian UI face. Loaded from Google
	 * Fonts, and ONLY on this plugin's own screen: a font request on every
	 * admin page would be an unasked-for third-party call on screens that
	 * have nothing to do with this plugin.
	 *
	 * Filterable so an air-gapped or privacy-restricted site can point it at
	 * a self-hosted copy or return '' to skip the request entirely — the
	 * stylesheet falls back to the system UI stack either way, so the screen
	 * is never left unstyled.
	 */
	private const FONT_URL = 'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap';

	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_assets' ) );
	}

	public function add_menu(): void {
		add_menu_page(
			__( 'WebYar', 'webyar-woocommerce' ),
			__( 'WebYar', 'webyar-woocommerce' ),
			Capabilities::MANAGE_CAPABILITY,
			self::PAGE_SLUG,
			array( $this, 'render' ),
			'dashicons-format-chat',
			58
		);
	}

	/** Styles load on this plugin's screen only — never site-wide. */
	public function enqueue_assets( string $hook_suffix ): void {
		if ( 'toplevel_page_' . self::PAGE_SLUG !== $hook_suffix ) {
			return;
		}

		$font_url = is_rtl() ? (string) apply_filters( 'webyar_wc_admin_font_url', self::FONT_URL ) : '';
		if ( '' !== $font_url ) {
			// phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion -- Google Fonts URLs are already versioned by their query string; appending ?ver= breaks the request.
			wp_enqueue_style( 'webyar-wc-admin-font', $font_url, array(), null );
		}

		wp_enqueue_style(
			'webyar-wc-admin',
			WEBYAR_WC_URL . 'assets/admin.css',
			'' !== $font_url ? array( 'webyar-wc-admin-font' ) : array(),
			WEBYAR_WC_VERSION
		);
	}

	public function render(): void {
		if ( ! Capabilities::current_user_can_manage() ) {
			wp_die( esc_html__( 'You cannot access this page.', 'webyar-woocommerce' ) );
		}

		$credential = CredentialStore::get();
		$settings   = get_option( 'webyar_wc_settings', array( 'auto_widget' => true ) );
		if ( ! is_array( $settings ) ) {
			$settings = array();
		}

		$notice_type    = isset( $_GET['webyar_notice'] ) ? sanitize_key( $_GET['webyar_notice'] ) : null; // phpcs:ignore
		$notice_message = isset( $_GET['webyar_message'] ) ? sanitize_text_field( wp_unslash( $_GET['webyar_message'] ) ) : null; // phpcs:ignore
		?>
		<div class="wrap webyar-admin" dir="<?php echo is_rtl() ? 'rtl' : 'ltr'; ?>">
			<div class="webyar-head">
				<div class="webyar-mark" aria-hidden="true"><?php echo is_rtl() ? 'و' : 'W'; ?></div>
				<div>
					<h1><?php esc_html_e( 'WebYar', 'webyar-woocommerce' ); ?></h1>
					<p><?php esc_html_e( 'Your store assistant', 'webyar-woocommerce' ); ?></p>
				</div>
			</div>

			<?php if ( $notice_type && $notice_message ) : ?>
				<div class="webyar-notice <?php echo 'error' === $notice_type ? 'is-error' : 'is-success'; ?>">
					<?php echo esc_html( $notice_message ); ?>
				</div>
			<?php endif; ?>

			<?php
			if ( null === $credential && ! Capabilities::current_user_can_connect() ) {
				// Shop managers see the status, but which Web Yar the store
				// trusts is an administrator's decision (see Capabilities).
				?>
				<div class="webyar-card">
					<h2><?php esc_html_e( 'Connect your store', 'webyar-woocommerce' ); ?></h2>
					<p class="webyar-sub"><?php esc_html_e( 'The store is not connected to WebYar. Ask a site administrator to connect it.', 'webyar-woocommerce' ); ?></p>
				</div>
				<?php
			} elseif ( null === $credential ) {
				$this->render_connect_form( $settings );
			} else {
				$this->render_connected( $credential, $settings );
			}
			?>
		</div>
		<?php
	}

	/** Not connected yet — one field, one button, everything else out of the way. */
	private function render_connect_form( array $settings ): void {
		?>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'webyar_wc_connect' ); ?>
			<input type="hidden" name="action" value="webyar_wc_connect" />

			<div class="webyar-card">
				<h2><?php esc_html_e( 'Connect your store', 'webyar-woocommerce' ); ?></h2>
				<p class="webyar-sub">
					<?php esc_html_e( 'Connect your store to WebYar to answer customers using your products, prices, stock, and orders.', 'webyar-woocommerce' ); ?>
				</p>

				<div class="webyar-field">
					<label for="webyar_wc_app_url"><?php esc_html_e( 'WebYar URL', 'webyar-woocommerce' ); ?></label>
					<input
						type="url" id="webyar_wc_app_url" name="app_url" dir="ltr" required pattern="https://.+"
						placeholder="https://app.webyar.ai"
						value="<?php echo esc_attr( $settings['app_url'] ?? '' ); ?>"
					/>
					<p class="webyar-help">
						<?php esc_html_e( 'The URL you use to sign in to WebYar.', 'webyar-woocommerce' ); ?>
					</p>
				</div>

				<button type="submit" class="webyar-btn webyar-btn-primary">
					<?php esc_html_e( 'Connect to WebYar', 'webyar-woocommerce' ); ?>
				</button>
			</div>

			<details class="webyar-more"<?php echo ! empty( $settings['api_url'] ) ? ' open' : ''; ?>>
				<summary><?php esc_html_e( 'Advanced settings', 'webyar-woocommerce' ); ?></summary>
				<div class="webyar-more-body">
					<div class="webyar-field">
						<label for="webyar_wc_api_url"><?php esc_html_e( 'API URL', 'webyar-woocommerce' ); ?></label>
						<input
							type="url" id="webyar_wc_api_url" name="api_url" dir="ltr" pattern="https://.+"
							placeholder="https://api.webyar.ai"
							value="<?php echo esc_attr( $settings['api_url'] ?? '' ); ?>"
						/>
						<p class="webyar-help">
							<?php esc_html_e( 'Enter this only if the WebYar API has a separate URL. Otherwise leave it empty.', 'webyar-woocommerce' ); ?>
						</p>
					</div>
				</div>
			</details>
		</form>
		<?php
	}

	/** Connected — status, the one switch that matters, then the actions. */
	private function render_connected( array $credential, array $settings ): void {
		// A stored credential is not the same as a WORKING one: if Web Yar
		// rotated or revoked the secret, every signed call fails while a
		// naive "connected" badge would still look healthy.
		$auth_error = get_option( EventDelivery::AUTH_ERROR_OPTION, null );
		$rejected   = is_array( $auth_error );
		?>
		<div class="webyar-card">
			<div class="webyar-status <?php echo $rejected ? 'is-bad' : ''; ?>">
				<span class="webyar-dot" aria-hidden="true"></span>
				<?php
				echo $rejected
					? esc_html__( 'Connection credentials rejected', 'webyar-woocommerce' )
					: esc_html__( 'Store connected', 'webyar-woocommerce' );
				?>
			</div>

			<?php if ( $rejected ) : ?>
				<p class="webyar-sub" style="margin-top:10px">
					<?php
					printf(
						/* translators: 1: HTTP status Web Yar replied with, 2: UTC time of the rejection */
						esc_html__( 'WebYar rejected the last signed request with code %1$d at %2$s. Disconnect and reconnect your store.', 'webyar-woocommerce' ),
						(int) ( $auth_error['status'] ?? 0 ),
						esc_html( (string) ( $auth_error['at'] ?? '' ) )
					);
					?>
				</p>
			<?php endif; ?>

			<dl class="webyar-rows">
				<div>
					<dt class="webyar-k"><?php esc_html_e( 'Store', 'webyar-woocommerce' ); ?></dt>
					<dd class="webyar-v"><?php echo esc_html( wp_parse_url( home_url(), PHP_URL_HOST ) ); ?></dd>
				</div>
				<div>
					<dt class="webyar-k"><?php esc_html_e( 'WebYar dashboard', 'webyar-woocommerce' ); ?></dt>
					<dd class="webyar-v">
						<a href="<?php echo esc_url( PairingService::app_base_url() ); ?>" target="_blank" rel="noopener noreferrer">
							<?php echo esc_html( PairingService::app_base_url() ); ?>
						</a>
					</dd>
				</div>
			</dl>

			<div class="webyar-actions">
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<?php wp_nonce_field( 'webyar_wc_test_connection' ); ?>
					<input type="hidden" name="action" value="webyar_wc_test_connection" />
					<button type="submit" class="webyar-btn"><?php esc_html_e( 'Test connection', 'webyar-woocommerce' ); ?></button>
				</form>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<?php wp_nonce_field( 'webyar_wc_sync_now' ); ?>
					<input type="hidden" name="action" value="webyar_wc_sync_now" />
					<button type="submit" class="webyar-btn"><?php esc_html_e( 'Sync products', 'webyar-woocommerce' ); ?></button>
				</form>
				<?php if ( Capabilities::current_user_can_connect() ) : ?>
				<span class="webyar-spacer"></span>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm('<?php echo esc_js( __( 'Disconnect this store from WebYar?', 'webyar-woocommerce' ) ); ?>');">
					<?php wp_nonce_field( 'webyar_wc_disconnect' ); ?>
					<input type="hidden" name="action" value="webyar_wc_disconnect" />
					<button type="submit" class="webyar-btn webyar-btn-danger"><?php esc_html_e( 'Disconnect', 'webyar-woocommerce' ); ?></button>
				</form>
				<?php endif; ?>
			</div>
		</div>

		<div class="webyar-card">
			<h2><?php esc_html_e( 'Chat widget', 'webyar-woocommerce' ); ?></h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<?php wp_nonce_field( 'webyar_wc_save_settings' ); ?>
				<input type="hidden" name="action" value="webyar_wc_save_settings" />
				<label class="webyar-toggle">
					<input type="checkbox" name="auto_widget" value="1" <?php checked( ! empty( $settings['auto_widget'] ) ); ?> />
					<span>
						<?php esc_html_e( 'Show the chat widget in the store', 'webyar-woocommerce' ); ?>
						<span class="webyar-help"><?php esc_html_e( 'Configure the widget in the WebYar dashboard.', 'webyar-woocommerce' ); ?></span>
					</span>
				</label>
				<div class="webyar-actions">
					<button type="submit" class="webyar-btn"><?php esc_html_e( 'Save', 'webyar-woocommerce' ); ?></button>
				</div>
			</form>
		</div>

		<?php DiagnosticsPage::render( $credential, $settings ); ?>

		<p class="webyar-foot">
			<?php esc_html_e( 'Manage products, prices, stock, orders, permissions, and sync in WebYar under Integrations > Store.', 'webyar-woocommerce' ); ?>
		</p>
		<?php
	}
}
