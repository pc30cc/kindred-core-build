<?php
namespace WebYar\WooCommerce\Rest;

use WebYar\WooCommerce\Commerce\StoreInfo;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class HealthController {
	public function handle( \WP_REST_Request $request ): \WP_REST_Response {
		return new \WP_REST_Response( StoreInfo::health_payload(), 200 );
	}
}
