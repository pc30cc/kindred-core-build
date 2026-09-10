<?php
namespace WebYar\WooCommerce\Auth;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Local installation credential storage.
 *
 * Never autoloaded (spec §9), never returned through REST, never logged,
 * never embedded in HTML/JS/widget config. Encrypted at rest with a key
 * DERIVED from WordPress's own salts (AUTH_KEY/SECURE_AUTH_KEY or the
 * `secret` option as a last resort) — this repo audited for a reusable
 * secure-storage abstraction and found none in the WordPress plugin
 * environment, so this is the canonical wrapper for this plugin only.
 */
final class CredentialStore {

	private const OPTION_KEY = 'webyar_wc_installation';

	/**
	 * @param array{
	 *   installation_id: string,
	 *   workspace_id: string,
	 *   store_id: string,
	 *   protocol_version: string,
	 *   installation_secret: string,
	 *   capabilities: string[],
	 *   approved_origin: string,
	 *   created_at: int,
	 *   rotated_at: int|null
	 * } $data
	 */
	public static function save( array $data ): void {
		$secret               = $data['installation_secret'];
		$data['installation_secret'] = self::encrypt( $secret );
		update_option( self::OPTION_KEY, $data, false ); // autoload = false
	}

	public static function get(): ?array {
		$data = get_option( self::OPTION_KEY, null );
		if ( ! is_array( $data ) || empty( $data['installation_secret'] ) ) {
			return null;
		}
		$decrypted = self::decrypt( $data['installation_secret'] );
		if ( null === $decrypted ) {
			return null; // fail closed — never operate on an unreadable credential
		}
		$data['installation_secret'] = $decrypted;
		return $data;
	}

	public static function get_installation_id(): ?string {
		$data = get_option( self::OPTION_KEY, null );
		return is_array( $data ) ? ( $data['installation_id'] ?? null ) : null;
	}

	public static function is_connected(): bool {
		return null !== self::get();
	}

	public static function clear(): void {
		delete_option( self::OPTION_KEY );
	}

	// ── Key derivation & AEAD ───────────────────────────────────────────

	private static function derive_key(): string {
		$material = '';
		foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY' ) as $const ) {
			if ( defined( $const ) ) {
				$material .= constant( $const );
			}
		}
		if ( '' === $material ) {
			// Last-resort fallback for an install missing unique salts
			// (rare, but must never fatal). Still per-site: `siteurl` is
			// folded in so two installs can never derive the same key.
			$material = (string) get_option( 'siteurl', 'webyar-fallback' );
		}
		return hash( 'sha256', 'webyar-wc-credential-store:' . $material, true );
	}

	private static function encrypt( string $plaintext ): string {
		$key   = self::derive_key();
		$nonce = random_bytes( 12 );
		if ( function_exists( 'openssl_encrypt' ) ) {
			$tag        = '';
			$ciphertext = openssl_encrypt( $plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $nonce, $tag );
			return base64_encode( $nonce . $tag . $ciphertext ); // phpcs:ignore
		}
		// No OpenSSL — extremely rare on a modern PHP build, but the
		// requirement is to never crash: XOR-obfuscate rather than store
		// plaintext, and mark it so decrypt() knows the format.
		return 'x1:' . base64_encode( $nonce . ( $plaintext ^ str_pad( '', strlen( $plaintext ), $key ) ) ); // phpcs:ignore
	}

	private static function decrypt( string $encoded ): ?string {
		$key = self::derive_key();
		if ( 0 === strpos( $encoded, 'x1:' ) ) {
			$raw   = base64_decode( substr( $encoded, 3 ) ); // phpcs:ignore
			$nonce = substr( $raw, 0, 12 );
			$body  = substr( $raw, 12 );
			return $body ^ str_pad( '', strlen( $body ), $key );
		}
		$raw = base64_decode( $encoded ); // phpcs:ignore
		if ( false === $raw || strlen( $raw ) < 28 ) {
			return null;
		}
		$nonce      = substr( $raw, 0, 12 );
		$tag        = substr( $raw, 12, 16 );
		$ciphertext = substr( $raw, 28 );
		$plaintext  = openssl_decrypt( $ciphertext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $nonce, $tag );
		return false === $plaintext ? null : $plaintext;
	}
}
