<?php
namespace WebYar\WooCommerce\Support;

use WebYar\WooCommerce\Auth\CredentialStore;
use WebYar\WooCommerce\Auth\PairingService;
use WebYar\WooCommerce\Identity\CustomerContext;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Injects the EXISTING canonical Web Yar widget loader (spec §33) — never a
 * second chat UI. Uses the same loader Web Yar's own "Integrations" embed
 * snippet uses; this plugin only supplies the workspace id and, when the
 * visitor is a logged-in WooCommerce customer, the signed customer-context
 * assertion. Skips injection if a Web Yar loader script is already present
 * to avoid a duplicate widget (e.g. it was also pasted into the theme).
 */
final class WidgetLoader {

	public function register(): void {
		add_action( 'wp_footer', array( $this, 'maybe_inject' ), 5 );
	}

	public function maybe_inject(): void {
		$settings = get_option( 'webyar_wc_settings', array( 'auto_widget' => true ) );
		if ( empty( $settings['auto_widget'] ) ) {
			return;
		}
		$credential = CredentialStore::get();
		if ( null === $credential ) {
			return;
		}

		$assertion = CustomerContext::issue_assertion(); // null for guests — never a raw customer_id

		$loader_url = apply_filters( 'webyar_commerce_widget_loader_url', trailingslashit( PairingService::app_base_url() ) . 'widget/loader.js' );
		?>
		<script>
		(function(){
			if (window.__webyarLoaderPresent) { return; } // another install already loaded it
			window.__webyarLoaderPresent = true;
			window.WebYarConfig = window.WebYarConfig || {};
			window.WebYarConfig.workspaceId = <?php echo wp_json_encode( $credential['workspace_id'] ); ?>;
			<?php if ( $assertion ) : ?>
			window.WebYarConfig.commerceCustomerContext = <?php echo wp_json_encode( $assertion ); ?>;
			<?php endif; ?>
			var s = document.createElement('script');
			s.src = <?php echo wp_json_encode( $loader_url ); ?>;
			s.async = true;
			document.body.appendChild(s);
		})();
		</script>
		<?php
	}
}
