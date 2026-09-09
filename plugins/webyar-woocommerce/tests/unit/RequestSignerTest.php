<?php
use PHPUnit\Framework\TestCase;
use WebYar\WooCommerce\Auth\RequestSigner;

final class RequestSignerTest extends TestCase {

	public function test_valid_signature_verifies(): void {
		$secret = 'installation-secret-abc';
		$headers = RequestSigner::build_headers( $secret, 'inst-1', 'POST', '/api/commerce/events', '{"a":1}' );

		$string_to_sign = RequestSigner::string_to_sign(
			$headers['X-WebYar-Protocol'],
			'POST',
			'/api/commerce/events',
			'inst-1',
			$headers['X-WebYar-Timestamp'],
			$headers['X-WebYar-Nonce'],
			hash( 'sha256', '{"a":1}' )
		);
		$expected = RequestSigner::sign( $secret, $string_to_sign );

		$this->assertTrue( RequestSigner::constant_time_equals( $expected, $headers['X-WebYar-Signature'] ) );
	}

	public function test_tampered_body_breaks_signature(): void {
		$secret  = 'installation-secret-abc';
		$headers = RequestSigner::build_headers( $secret, 'inst-1', 'POST', '/api/commerce/events', '{"a":1}' );

		// Recompute using a DIFFERENT body — simulates a body modified after signing.
		$string_to_sign = RequestSigner::string_to_sign(
			$headers['X-WebYar-Protocol'], 'POST', '/api/commerce/events', 'inst-1',
			$headers['X-WebYar-Timestamp'], $headers['X-WebYar-Nonce'], hash( 'sha256', '{"a":2}' )
		);
		$recomputed = RequestSigner::sign( $secret, $string_to_sign );

		$this->assertFalse( RequestSigner::constant_time_equals( $recomputed, $headers['X-WebYar-Signature'] ) );
	}

	public function test_wrong_secret_breaks_signature(): void {
		$headers = RequestSigner::build_headers( 'secret-a', 'inst-1', 'GET', '/wp-json/webyar/v1/health', '' );
		$string_to_sign = RequestSigner::string_to_sign(
			$headers['X-WebYar-Protocol'], 'GET', '/wp-json/webyar/v1/health', 'inst-1',
			$headers['X-WebYar-Timestamp'], $headers['X-WebYar-Nonce'], hash( 'sha256', '' )
		);
		$wrong_secret_signature = RequestSigner::sign( 'secret-b', $string_to_sign );

		$this->assertFalse( RequestSigner::constant_time_equals( $wrong_secret_signature, $headers['X-WebYar-Signature'] ) );
	}

	public function test_headers_contain_expected_keys(): void {
		$headers = RequestSigner::build_headers( 'secret', 'inst-9', 'POST', '/x', '{}' );
		foreach ( array( 'X-WebYar-Installation', 'X-WebYar-Timestamp', 'X-WebYar-Nonce', 'X-WebYar-Signature', 'X-WebYar-Protocol' ) as $key ) {
			$this->assertArrayHasKey( $key, $headers );
		}
		$this->assertSame( 'inst-9', $headers['X-WebYar-Installation'] );
	}
}
