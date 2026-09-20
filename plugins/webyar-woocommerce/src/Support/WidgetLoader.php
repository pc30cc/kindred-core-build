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
 * second chat UI. This plugin only supplies what the loader already expects
 * from any embed: the workspace id and the API origin.
 *
 * The contract is the one `src/lib/widgetEmbed.ts` generates for the snippet
 * shown in Settings → Integrations, and it is NOT negotiable from this side:
 * the loader reads `window.__gs_id` / `data-workspace-id` and
 * `window.__gs_api_base` / `data-api-base`, and nothing else. An earlier
 * version of this file invented a `window.WebYarConfig` object instead. The
 * script tag appeared in the page and `loader.js` downloaded fine, so the
 * install looked correct from the outside — but the loader read its workspace
 * id as null and its API base as the empty string, and every bootstrap was
 * skipped. The widget simply never appeared.
 *
 * The API origin matters on its own: the loader defaults it to '' and a
 * deployment can serve the dashboard and the API from different hosts
 * (app.webyar.ai vs api.webyar.ai), so it has to be stated, not guessed.
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

		$loader_url = apply_filters( 'webyar_commerce_widget_loader_url', trailingslashit( PairingService::app_base_url() ) . 'widget/loader.js' );
		$asset_base = untrailingslashit( PairingService::app_base_url() );
		$api_base   = untrailingslashit( PairingService::api_base_url() );

		// Signed, short-lived, and null for guests — never a raw customer id.
		// Carried as a data attribute so it travels with the script tag the
		// loader already resolves, rather than in a global of our own.
		//
		// NOT YET CONSUMED. `POST /api/widget/commerce/identity` exists and
		// binds this assertion to the visitor, and its own doc comment says the
		// widget runtime calls it "after it reads the plugin-injected assertion
		// out of the page bootstrap config" — but no build of loader.js or
		// runtime.js references the assertion, this attribute, or that endpoint.
		// Both ends of the identity bridge are built; the middle is missing.
		// Until the runtime reads it, a signed-in WooCommerce customer is an
		// anonymous visitor to the widget, so every order question can only
		// answer `identity_required`. Emitted here so the plugin side is ready
		// and the gap is one change away, not three.
		$assertion = CustomerContext::issue_assertion();
		?>
		<script>
		(function(){
			// The loader owns its own singleton guard; honour the same flags so
			// a merchant who ALSO pasted the snippet from Settings → Integrations
			// ends up with one widget, not two.
			if (window.__gs_loaded || window.__gs_loader_injected) { return; }
			if (document.getElementById('gs-widget-loader')) { return; }
			window.__gs_loader_injected = true;
			window.__gs = window.__gs || [];
			window.__gs_id = <?php echo wp_json_encode( $credential['workspace_id'] ); ?>;
			window.__gs_api_base = <?php echo wp_json_encode( $api_base ); ?>;
			var s = document.createElement('script');
			s.id = 'gs-widget-loader';
			s.src = <?php echo wp_json_encode( $loader_url ); ?>;
			s.setAttribute('data-workspace-id', <?php echo wp_json_encode( $credential['workspace_id'] ); ?>);
			s.setAttribute('data-api-base', <?php echo wp_json_encode( $api_base ); ?>);
			s.setAttribute('data-asset-base', <?php echo wp_json_encode( $asset_base ); ?>);
			<?php if ( $assertion && ! empty( $credential['connection_id'] ) ) : ?>
			s.setAttribute('data-commerce-assertion', <?php echo wp_json_encode( $assertion ); ?>);
			s.setAttribute('data-commerce-connection', <?php echo wp_json_encode( $credential['connection_id'] ); ?>);
			<?php endif; ?>
			s.async = true;
			document.head.appendChild(s);
		})();
		</script>
		<?php
	}
}
