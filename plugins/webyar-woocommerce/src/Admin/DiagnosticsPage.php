<?php
namespace WebYar\WooCommerce\Admin;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Renders the diagnostics section of the settings screen — safe metadata only. */
final class DiagnosticsPage {

	public static function render( array $credential ): void {
		$dead_letters = get_option( 'webyar_wc_dead_letters', array() );
		?>
		<h2><?php esc_html_e( 'Diagnostics', 'webyar-woocommerce' ); ?></h2>
		<table class="widefat striped" style="max-width:640px">
			<tbody>
				<tr>
					<td><?php esc_html_e( 'Protocol version', 'webyar-woocommerce' ); ?></td>
					<td><code><?php echo esc_html( $credential['protocol_version'] ?? '—' ); ?></code></td>
				</tr>
				<tr>
					<td><?php esc_html_e( 'Store ID', 'webyar-woocommerce' ); ?></td>
					<td><code><?php echo esc_html( $credential['store_id'] ?? '—' ); ?></code></td>
				</tr>
				<tr>
					<td><?php esc_html_e( 'Connected since', 'webyar-woocommerce' ); ?></td>
					<td><?php echo esc_html( ! empty( $credential['created_at'] ) ? gmdate( 'Y-m-d H:i', (int) $credential['created_at'] ) . ' UTC' : '—' ); ?></td>
				</tr>
				<tr>
					<td><?php esc_html_e( 'Failed events (last 50)', 'webyar-woocommerce' ); ?></td>
					<td><?php echo esc_html( (string) count( $dead_letters ) ); ?></td>
				</tr>
			</tbody>
		</table>
		<?php if ( ! empty( $dead_letters ) ) : ?>
			<details style="margin-top:8px">
				<summary><?php esc_html_e( 'Show failed events', 'webyar-woocommerce' ); ?></summary>
				<table class="widefat striped" style="max-width:640px">
					<thead>
						<tr>
							<th><?php esc_html_e( 'Type', 'webyar-woocommerce' ); ?></th>
							<th><?php esc_html_e( 'Reason', 'webyar-woocommerce' ); ?></th>
							<th><?php esc_html_e( 'At', 'webyar-woocommerce' ); ?></th>
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
			</details>
		<?php endif; ?>
		<?php
	}
}
