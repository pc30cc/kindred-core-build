<?php
/**
 * Just enough of WP REST and of this plugin's order readers to drive
 * Rest\OrderController's authorization decisions without WooCommerce.
 *
 * The readers here are stand-ins that serve a fixed in-memory order table,
 * so a test observes exactly which orders the controller hands back. The
 * real OrderReader/TrackingResolver (WC_Order_Query, meta) still need the
 * WooCommerce test framework — see tests/bootstrap.php.
 */
namespace {
	if ( ! class_exists( 'WP_REST_Request' ) ) {
		class WP_REST_Request {
			private $params;
			public function __construct( array $params = array() ) { $this->params = $params; }
			public function get_param( string $key ) { return $this->params[ $key ] ?? null; }
		}
	}
	if ( ! class_exists( 'WP_REST_Response' ) ) {
		class WP_REST_Response {
			public $data;
			public $status;
			public function __construct( $data = null, int $status = 200 ) { $this->data = $data; $this->status = $status; }
			public function get_data() { return $this->data; }
			public function get_status(): int { return $this->status; }
		}
	}
	if ( ! class_exists( 'WC_Order' ) ) {
		class WC_Order {
			private $id;
			private $customer_id;
			public function __construct( int $id, int $customer_id ) { $this->id = $id; $this->customer_id = $customer_id; }
			public function get_id(): int { return $this->id; }
			public function get_customer_id(): int { return $this->customer_id; }
		}
	}
}

namespace WebYar\WooCommerce\Commerce {
	if ( ! class_exists( OrderReader::class ) ) {
		final class OrderReader {
			/** @var array<int,int> order id => customer id (0 = guest) */
			public static $orders = array();
			/** customer ids orders_for_customer() was asked for, after its (int) cast */
			public static $listed = array();

			public static function find( string $external_id ): ?\WC_Order {
				$id = (int) $external_id;
				return isset( self::$orders[ $id ] ) ? new \WC_Order( $id, self::$orders[ $id ] ) : null;
			}
			public static function to_canonical( \WC_Order $order ): array {
				return array( 'status' => 'processing', 'order' => (string) $order->get_id() );
			}
			public static function orders_for_customer( string $external_customer_id, int $limit = 5 ): array {
				$customer       = (int) $external_customer_id;
				self::$listed[] = $customer;
				$out            = array();
				foreach ( self::$orders as $id => $owner ) {
					if ( $owner === $customer ) {
						$out[] = array( 'external_id' => (string) $id );
					}
				}
				return $out;
			}
			public static function contact_matches( \WC_Order $order, ?string $email, ?string $phone ): bool {
				return false;
			}
		}
	}
	if ( ! class_exists( TrackingResolver::class ) ) {
		final class TrackingResolver {
			public static function resolve( \WC_Order $order ): array {
				return array( 'carrier' => 'Post', 'trackingNumber' => 'TRK-' . $order->get_id() );
			}
		}
	}
}
