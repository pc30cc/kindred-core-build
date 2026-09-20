<?php
namespace WebYar\WooCommerce\Events;

use WebYar\WooCommerce\Auth\CredentialStore;
use WebYar\WooCommerce\Auth\RequestSigner;
use WebYar\WooCommerce\Auth\PairingService;
use WebYar\WooCommerce\Support\Logger;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Action Scheduler callback — signs and delivers ONE event. Bounded
 * exponential backoff, retries only retryable failures, dead-letters
 * permanent ones (spec §17). Runs entirely off the customer-facing request
 * path.
 */
final class EventDelivery {

	private const MAX_ATTEMPTS = 6;

	/** Set when Web Yar rejects a signed event as unauthenticated; read by the settings screen. */
	public const AUTH_ERROR_OPTION = 'webyar_wc_auth_error';

	public static function clear_auth_error(): void {
		delete_option( self::AUTH_ERROR_OPTION );
	}

	public function register(): void {
		add_action( EventQueue::HOOK, array( $this, 'handle' ), 10, 2 );
	}

	public function handle( array $event, int $attempt = 1 ): void {
		$credential = CredentialStore::get();
		if ( null === $credential ) {
			Logger::warning( 'event delivery skipped — not connected', array( 'event_id' => $event['event_id'] ?? null ) );
			return; // no dead-letter needed: reconnecting re-syncs state anyway
		}

		$body    = wp_json_encode( $event );
		$path    = '/api/commerce/events';
		$headers = RequestSigner::build_headers( $credential['installation_secret'], $credential['installation_id'], 'POST', $path, $body );

		$response = wp_remote_post(
			trailingslashit( PairingService::app_base_url() ) . 'api/commerce/events',
			array(
				'timeout' => 8,
				'headers' => $headers,
				'body'    => $body,
			)
		);

		if ( is_wp_error( $response ) ) {
			$this->retry_or_dead_letter( $event, $attempt, 'network_error' );
			return;
		}

		$status = wp_remote_retrieve_response_code( $response );

		if ( $status >= 200 && $status < 300 ) {
			self::clear_auth_error(); // a delivery that lands proves the credential is good again
			return; // delivered — Web Yar's own idempotency ledger handles dedupe on its side
		}

		// Never retry a permanent rejection indefinitely (spec §17).
		if ( in_array( $status, array( 400, 401, 403, 404, 422 ), true ) ) {
			Logger::error( 'event delivery permanently rejected', array( 'event_id' => $event['event_id'] ?? null, 'status' => $status ) );
			// Record it. Dropping the event with no trace anywhere is how a
			// rotated or revoked credential turns into a store that still
			// reads "connected" in wp-admin while every event is silently
			// discarded — the admin has nothing to go on.
			$this->record_dead_letter( $event, 'http_' . $status );
			if ( 401 === $status || 403 === $status ) {
				// Auth-shaped rejection: the credential itself is no longer
				// accepted, so the connection needs re-pairing, not a retry.
				update_option(
					self::AUTH_ERROR_OPTION,
					array( 'status' => $status, 'at' => gmdate( 'c' ) ),
					false
				);
			}
			return; // dead — surfaced in diagnostics, not retried
		}

		$this->retry_or_dead_letter( $event, $attempt, 'http_' . $status );
	}

	private function retry_or_dead_letter( array $event, int $attempt, string $reason ): void {
		if ( $attempt >= self::MAX_ATTEMPTS ) {
			Logger::error( 'event delivery dead-lettered', array( 'event_id' => $event['event_id'] ?? null, 'reason' => $reason ) );
			$this->record_dead_letter( $event, $reason );
			return;
		}

		$delay = min( 3600, (int) ( 30 * ( 2 ** ( $attempt - 1 ) ) ) ); // 30s, 60s, 120s, 240s, 480s, capped at 1h
		if ( function_exists( 'as_schedule_single_action' ) ) {
			as_schedule_single_action( time() + $delay, EventQueue::HOOK, array( 'event' => $event, 'attempt' => $attempt + 1 ), EventQueue::GROUP );
		}
	}

	/** Admin diagnostics — safe metadata only, no PII/secrets (spec §17). */
	private function record_dead_letter( array $event, string $reason ): void {
		$dead_letters   = get_option( 'webyar_wc_dead_letters', array() );
		$dead_letters[] = array(
			'event_id' => $event['event_id'] ?? null,
			'type'     => $event['type'] ?? null,
			'reason'   => $reason,
			'at'       => gmdate( 'c' ),
		);
		update_option( 'webyar_wc_dead_letters', array_slice( $dead_letters, -50 ), false );
	}
}
