<?php
namespace WebYar\WooCommerce\Support;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Minimal logging via WooCommerce's own logger. Never logs secrets — only
 * safe error codes, correlation ids, and event ids (spec §58).
 */
final class Logger {

	private const SOURCE = 'webyar-woocommerce';

	public static function info( string $message, array $context = array() ): void {
		self::log( 'info', $message, $context );
	}

	public static function warning( string $message, array $context = array() ): void {
		self::log( 'warning', $message, $context );
	}

	public static function error( string $message, array $context = array() ): void {
		self::log( 'error', $message, $context );
	}

	private static function log( string $level, string $message, array $context ): void {
		$safe_context = self::redact( $context );
		if ( function_exists( 'wc_get_logger' ) ) {
			wc_get_logger()->log( $level, $message . ' ' . wp_json_encode( $safe_context ), array( 'source' => self::SOURCE ) );
			return;
		}
		error_log( '[webyar-woocommerce] ' . $level . ': ' . $message . ' ' . wp_json_encode( $safe_context ) ); // phpcs:ignore
	}

	/** Strips any key that looks like it could carry a secret. */
	private static function redact( array $context ): array {
		$denylist = array( 'secret', 'signature', 'token', 'password', 'code_verifier', 'installation_secret' );
		foreach ( $context as $key => $value ) {
			foreach ( $denylist as $needle ) {
				if ( stripos( (string) $key, $needle ) !== false ) {
					$context[ $key ] = '[redacted]';
				}
			}
		}
		return $context;
	}
}
