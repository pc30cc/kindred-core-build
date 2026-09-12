<?php
use PHPUnit\Framework\TestCase;
use WebYar\WooCommerce\Auth\CredentialStore;

final class CredentialStoreTest extends TestCase {

	protected function setUp(): void {
		$GLOBALS['__webyar_test_options'] = array();
	}

	public function test_round_trip_save_and_get(): void {
		CredentialStore::save(
			array(
				'installation_id'     => 'inst-1',
				'workspace_id'        => 'ws-1',
				'store_id'            => 'https://example.com',
				'protocol_version'    => 'webyar-commerce/1',
				'installation_secret' => 'top-secret-value',
				'capabilities'        => array( 'store.read' ),
				'approved_origin'     => 'https://example.com',
				'created_at'          => 1234567890,
				'rotated_at'          => null,
			)
		);

		$data = CredentialStore::get();
		$this->assertNotNull( $data );
		$this->assertSame( 'top-secret-value', $data['installation_secret'] );
		$this->assertSame( 'inst-1', $data['installation_id'] );
	}

	public function test_secret_is_not_stored_in_plaintext(): void {
		CredentialStore::save(
			array(
				'installation_id' => 'inst-1', 'workspace_id' => 'ws-1', 'store_id' => 's',
				'protocol_version' => 'webyar-commerce/1', 'installation_secret' => 'super-secret-plaintext',
				'capabilities' => array(), 'approved_origin' => 'https://example.com', 'created_at' => 1, 'rotated_at' => null,
			)
		);
		$raw = $GLOBALS['__webyar_test_options']['webyar_wc_installation'];
		$this->assertStringNotContainsString( 'super-secret-plaintext', wp_json_encode( $raw ) );
	}

	public function test_clear_removes_credential(): void {
		CredentialStore::save(
			array(
				'installation_id' => 'inst-1', 'workspace_id' => 'ws-1', 'store_id' => 's',
				'protocol_version' => 'webyar-commerce/1', 'installation_secret' => 'x',
				'capabilities' => array(), 'approved_origin' => 'https://example.com', 'created_at' => 1, 'rotated_at' => null,
			)
		);
		CredentialStore::clear();
		$this->assertNull( CredentialStore::get() );
	}

	public function test_get_returns_null_when_never_connected(): void {
		$this->assertNull( CredentialStore::get() );
		$this->assertFalse( CredentialStore::is_connected() );
	}
}
