<?php
use PHPUnit\Framework\TestCase;
use WebYar\WooCommerce\Commerce\OrderReader;
use WebYar\WooCommerce\Rest\OrderController;

require_once __DIR__ . '/../support/OrderStubs.php';
require_once __DIR__ . '/../../src/Rest/OrderController.php';

/**
 * Every order path that returns data (single lookup, customer list,
 * tracking) must confirm the authorization covers THAT order. Regression
 * for: tracking had no check at all; lookup by order id skipped the check
 * unless kind was verified_customer; the customer list trusted customer_id
 * without comparing it to the authorized customer.
 */
final class OrderAuthorizationTest extends TestCase {

	private const ALICE = '7';
	private const BOB   = '8';

	protected function setUp(): void {
		OrderReader::$orders = array(
			100 => 7, // Alice
			200 => 8, // Bob
			300 => 0, // guest checkout
		);
		OrderReader::$listed = array();
	}

	private static function customer( string $customer_id, string $order_id = '' ): array {
		$auth = array( 'kind' => 'verified_customer', 'installationId' => 'inst', 'externalCustomerId' => $customer_id );
		if ( '' !== $order_id ) {
			$auth['externalOrderId'] = $order_id;
		}
		return $auth;
	}

	private static function guest( string $order_id, string $proof = 'proof-token' ): array {
		return array( 'kind' => 'verified_guest', 'installationId' => 'inst', 'verificationProofToken' => $proof, 'externalOrderId' => $order_id );
	}

	private function lookup( array $params ): \WP_REST_Response {
		return ( new OrderController() )->lookup( new \WP_REST_Request( $params ) );
	}

	private function tracking( array $params ): \WP_REST_Response {
		return ( new OrderController() )->tracking( new \WP_REST_Request( $params ) );
	}

	public function test_customer_sees_own_order(): void {
		$res = $this->lookup( array( 'order_id' => '100', 'authorization' => self::customer( self::ALICE, '100' ) ) );
		$this->assertSame( 200, $res->get_status() );
		$this->assertTrue( $res->get_data()['found'] );
	}

	public function test_customer_cannot_see_another_customers_order(): void {
		$res = $this->lookup( array( 'order_id' => '200', 'authorization' => self::customer( self::ALICE, '200' ) ) );
		$this->assertSame( 404, $res->get_status() );
		$this->assertSame( array( 'found' => false ), $res->get_data() );
	}

	public function test_lookup_without_authorization_is_indistinguishable_from_missing(): void {
		$missing = $this->lookup( array( 'order_id' => '999' ) );
		foreach ( array( null, array(), array( 'kind' => 'anonymous' ), array( 'kind' => 'VERIFIED_CUSTOMER', 'externalCustomerId' => '8' ) ) as $auth ) {
			$res = $this->lookup( array( 'order_id' => '200', 'authorization' => $auth ) );
			$this->assertSame( $missing->get_status(), $res->get_status() );
			$this->assertSame( $missing->get_data(), $res->get_data() );
		}
	}

	public function test_guest_order_never_matches_a_customer_id_of_zero_or_empty(): void {
		foreach ( array( '0', '', ' ', '00', '-1', 'abc', '7abc' ) as $bad ) {
			$res = $this->lookup( array( 'order_id' => '300', 'authorization' => self::customer( $bad ) ) );
			$this->assertSame( 404, $res->get_status(), "customer id '$bad' must not open a guest order" );
		}
	}

	public function test_customer_authorization_naming_another_order_is_refused(): void {
		// Alice's authorization for order 100 cannot be re-pointed at order 101 even if both were hers.
		OrderReader::$orders[101] = 7;
		$res = $this->lookup( array( 'order_id' => '101', 'authorization' => self::customer( self::ALICE, '100' ) ) );
		$this->assertSame( 404, $res->get_status() );
	}

	public function test_verified_guest_sees_only_the_verified_order(): void {
		$this->assertSame( 200, $this->lookup( array( 'order_id' => '300', 'authorization' => self::guest( '300' ) ) )->get_status() );
		$this->assertSame( 404, $this->lookup( array( 'order_id' => '200', 'authorization' => self::guest( '300' ) ) )->get_status() );
		$this->assertSame( 404, $this->lookup( array( 'order_id' => '300', 'authorization' => self::guest( '300', '' ) ) )->get_status() );
		$this->assertSame( 404, $this->lookup( array( 'order_id' => '300', 'authorization' => self::guest( '' ) ) )->get_status() );
	}

	public function test_customer_list_is_limited_to_the_authorized_customer(): void {
		$own = $this->lookup( array( 'customer_id' => self::ALICE, 'authorization' => self::customer( self::ALICE ) ) );
		$this->assertSame( 200, $own->get_status() );
		$this->assertSame( array( array( 'external_id' => '100' ) ), $own->get_data()['orders'] );

		$other = $this->lookup( array( 'customer_id' => self::BOB, 'authorization' => self::customer( self::ALICE ) ) );
		$this->assertSame( 403, $other->get_status() );
		$this->assertSame( array( 'orders' => array() ), $other->get_data() );

		foreach ( array( null, self::guest( '300' ) ) as $auth ) {
			$res = $this->lookup( array( 'customer_id' => self::BOB, 'authorization' => $auth ) );
			$this->assertSame( 403, $res->get_status() );
		}
		// The reader was only ever asked for Alice.
		$this->assertSame( array( 7 ), OrderReader::$listed );
	}

	public function test_customer_list_never_widens_to_guest_orders(): void {
		foreach ( array( 'abc', '+7', ' 7', '7.0', '07' ) as $bad ) {
			$res = $this->lookup( array( 'customer_id' => $bad, 'authorization' => self::customer( $bad ) ) );
			$this->assertSame( 403, $res->get_status(), "customer id '$bad'" );
		}
		$this->assertSame( array(), OrderReader::$listed );
	}

	public function test_tracking_requires_the_same_ownership_as_lookup(): void {
		$own = $this->tracking( array( 'order_id' => '100', 'authorization' => self::customer( self::ALICE, '100' ) ) );
		$this->assertSame( 200, $own->get_status() );
		$this->assertSame( 'TRK-100', $own->get_data()['trackingNumber'] );

		foreach ( array( null, self::customer( self::ALICE, '200' ), self::customer( self::BOB, '100' ), self::guest( '300' ) ) as $auth ) {
			$res = $this->tracking( array( 'order_id' => '100', 'authorization' => $auth ) );
			$this->assertSame( 404, $res->get_status() );
			$this->assertSame( array( 'found' => false ), $res->get_data() );
		}
		$this->assertSame( 200, $this->tracking( array( 'order_id' => '300', 'authorization' => self::guest( '300' ) ) )->get_status() );
	}

	public function test_authorizes_is_pure_and_closed(): void {
		$this->assertTrue( OrderController::authorizes( self::customer( '7' ), '7', '100' ) );
		$this->assertFalse( OrderController::authorizes( self::customer( '7' ), '70', '100' ) );
		$this->assertFalse( OrderController::authorizes( array( 'kind' => 'admin' ), '7', '100' ) );
		$this->assertFalse( OrderController::authorizes( array(), '0', '100' ) );
	}
}
