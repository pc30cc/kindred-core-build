<?php
namespace WebYar\WooCommerce;

use WebYar\WooCommerce\Admin\SettingsPage;
use WebYar\WooCommerce\Admin\ConnectionController;
use WebYar\WooCommerce\Events\WooEventSubscriber;
use WebYar\WooCommerce\Events\EventDelivery;
use WebYar\WooCommerce\Rest\ProductController;
use WebYar\WooCommerce\Rest\Router;
use WebYar\WooCommerce\Support\Updater;
use WebYar\WooCommerce\Support\WidgetLoader;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Composition root. Registers every hook the plugin owns. Runs ONLY after
 * webyar-woocommerce.php has confirmed the environment (PHP/WP/WooCommerce
 * versions) — this class assumes WooCommerce classes exist.
 */
final class Plugin {

	private static ?self $instance = null;

	public static function instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {}

	public function boot(): void {
		( new SettingsPage() )->register();
		( new ConnectionController() )->register();
		( new Router() )->register();
		ProductController::register_query_filters();
		( new WooEventSubscriber() )->register();
		( new EventDelivery() )->register();
		( new WidgetLoader() )->register();
		( new Updater() )->register();
	}
}
