<?php
namespace WebYar\WooCommerce\Admin;

use WebYar\WooCommerce\Auth\PairingService;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Technical detail for the day something breaks — safe metadata only, never
 * the installation secret.
 *
 * Collapsed by default: a shop owner opening this screen wants to know the
 * store is connected, not which protocol revision it negotiated. It opens
 * itself only when there are failed deliveries, i.e. exactly when the
 * detail is the reason the admin came here.
 */
final class DiagnosticsPage {

	public static function render( array $credential, array $settings = array() ): void {
		$dead_letters = get_option( 'webyar_wc_dead_letters', array() );
		if ( ! is_array( $dead_letters ) ) {
			$dead_letters = array();
		}
		$has_failures = ! empty( $dead_letters );
		?>
		<details class="webyar-more"<?php echo $has_failures ? ' open' : ''; ?>>
			<summary>
				<?php
				if ( $has_failures ) {
					printf(
						/* translators: %d: number of failed event deliveries */
						esc_html__( 'جزئیات فنی — %d رویداد ناموفق', 'webyar-woocommerce' ),
						count( $dead_letters )
					);
				} else {
					esc_html_e( 'جزئیات فنی', 'webyar-woocommerce' );
				}
				?>
			</summary>
			<div class="webyar-more-body">
				<dl class="webyar-rows">
					<div>
						<dt class="webyar-k"><?php esc_html_e( 'آدرس API', 'webyar-woocommerce' ); ?></dt>
						<dd class="webyar-v">
							<code><?php echo esc_html( PairingService::api_base_url() ); ?></code>
							<?php if ( empty( $settings['api_url'] ) ) : ?>
								<span class="webyar-hint">(<?php esc_html_e( 'همان داشبورد', 'webyar-woocommerce' ); ?>)</span>
							<?php endif; ?>
						</dd>
					</div>
					<div>
						<dt class="webyar-k"><?php esc_html_e( 'نسخه‌ی افزونه', 'webyar-woocommerce' ); ?></dt>
						<dd class="webyar-v"><code><?php echo esc_html( WEBYAR_WC_VERSION ); ?></code></dd>
					</div>
					<div>
						<dt class="webyar-k"><?php esc_html_e( 'نسخه‌ی پروتکل', 'webyar-woocommerce' ); ?></dt>
						<dd class="webyar-v"><code><?php echo esc_html( $credential['protocol_version'] ?? '—' ); ?></code></dd>
					</div>
					<div>
						<dt class="webyar-k"><?php esc_html_e( 'زمان اتصال', 'webyar-woocommerce' ); ?></dt>
						<dd class="webyar-v"><?php echo esc_html( ! empty( $credential['created_at'] ) ? gmdate( 'Y-m-d H:i', (int) $credential['created_at'] ) . ' UTC' : '—' ); ?></dd>
					</div>
					<div>
						<dt class="webyar-k"><?php esc_html_e( 'رویدادهای ناموفق (۵۰ مورد اخیر)', 'webyar-woocommerce' ); ?></dt>
						<dd class="webyar-v"><?php echo esc_html( (string) count( $dead_letters ) ); ?></dd>
					</div>
				</dl>

				<?php if ( $has_failures ) : ?>
					<table class="webyar-table">
						<thead>
							<tr>
								<th><?php esc_html_e( 'نوع', 'webyar-woocommerce' ); ?></th>
								<th><?php esc_html_e( 'دلیل', 'webyar-woocommerce' ); ?></th>
								<th><?php esc_html_e( 'زمان', 'webyar-woocommerce' ); ?></th>
							</tr>
						</thead>
						<tbody>
							<?php foreach ( array_reverse( $dead_letters ) as $entry ) : ?>
								<tr>
									<td><?php echo esc_html( $entry['type'] ?? '—' ); ?></td>
									<td><?php echo esc_html( $entry['reason'] ?? '—' ); ?></td>
									<td><?php echo esc_html( $entry['at'] ?? '—' ); ?></td>
								</tr>
							<?php endforeach; ?>
						</tbody>
					</table>
				<?php endif; ?>
			</div>
		</details>
		<?php
	}
}
