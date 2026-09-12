<?php
namespace WebYar\WooCommerce\Rest;

use WebYar\WooCommerce\Auth\CredentialStore;
use WebYar\WooCommerce\Auth\ReplayGuard;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers the plugin's ENTIRE REST surface — narrow, schema-defined
 * routes only. No generic proxy (spec §11: no `/webyar/proxy?path=...`).
 */
final class Router {

	private const NAMESPACE = 'webyar/v1';

	public function register(): void {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function register_routes(): void {
		register_rest_route(
			self::NAMESPACE,
			'/health',
			array(
				'methods'             => 'GET',
				'callback'            => array( new HealthController(), 'handle' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/products/search',
			array(
				'methods'             => 'POST',
				'callback'            => array( new ProductController(), 'search' ),
				'permission_callback' => array( $this, 'authenticate' ),
				'args'                => ProductController::search_schema(),
			)
		);
		register_rest_route(
			self::NAMESPACE,
			'/products/resolve',
			array(
				'methods'             => 'POST',
				'callback'            => array( new ProductController(), 'resolve' ),
				'permission_callback' => array( $this, 'authenticate' ),
				'args'                => ProductController::resolve_schema(),
			)
		);
		register_rest_route(
			self::NAMESPACE,
			'/products/availability',
			array(
				'methods'             => 'POST',
				'callback'            => array( new ProductController(), 'availability' ),
				'permission_callback' => array( $this, 'authenticate' ),
				'args'                => ProductController::availability_schema(),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/orders/lookup',
			array(
				'methods'             => 'POST',
				'callback'            => array( new OrderController(), 'lookup' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
		register_rest_route(
			self::NAMESPACE,
			'/orders/tracking',
			array(
				'methods'             => 'POST',
				'callback'            => array( new OrderController(), 'tracking' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
		register_rest_route(
			self::NAMESPACE,
			'/orders/verify-contact',
			array(
				'methods'             => 'POST',
				'callback'            => array( new OrderController(), 'verify_contact' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/catalog/export',
			array(
				'methods'             => 'GET',
				'callback'            => array( new CatalogController(), 'export' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
	}

	/**
	 * The ONLY permission_callback used across every route above — never
	 * `__return_true` (spec §11). Fails closed when the plugin has no live
	 * credential at all.
	 */
	public function authenticate( \WP_REST_Request $request ) {
		$credential = CredentialStore::get();
		if ( null === $credential ) {
			return new \WP_Error( 'commerce_not_connected', 'Not connected to Web Yar', array( 'status' => 401 ) );
		}
		return ReplayGuard::verify( $request, $credential['installation_secret'], $credential['installation_id'] );
	}
}
