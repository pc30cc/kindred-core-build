<?php
namespace WebYar\WooCommerce\Events;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Background outbound delivery via WooCommerce's own Action Scheduler
 * (spec §15) — no second queue framework is invented. Enqueuing NEVER
 * makes a network call itself; it only schedules a job and returns, so a
 * `save_post`/checkout-adjacent hook is never slowed down by Web Yar.
 */
final class EventQueue {

	public const HOOK  = 'webyar_wc_deliver_event';
	public const GROUP = 'webyar-wc';

	/**
	 * @param string               $type      e.g. 'product.updated'
	 * @param string               $entity_id
	 * @param string               $entity_version ISO-8601 UTC — used for out-of-order protection on the Web Yar side
	 * @param array<string,mixed>  $payload   bounded, normalized — never raw postmeta
	 */
	public static function enqueue( string $type, string $entity_id, string $entity_version, array $payload ): void {
		if ( ! function_exists( 'as_schedule_single_action' ) ) {
			// Action Scheduler ships inside WooCommerce; this should never
			// happen, but never fatal a save/checkout hook if it does.
			return;
		}

		$event = array(
			'event_id'         => wp_generate_uuid4(),
			'type'              => $type,
			'entity_id'         => $entity_id,
			'entity_version'    => $entity_version,
			'occurred_at'       => gmdate( 'c' ),
			'protocol_version'  => defined( 'WEBYAR_WC_PROTOCOL_VERSION' ) ? WEBYAR_WC_PROTOCOL_VERSION : 'webyar-commerce/1',
			'payload'           => self::bound_payload( $payload ),
		);

		as_schedule_single_action( time(), self::HOOK, array( 'event' => $event, 'attempt' => 1 ), self::GROUP );
	}

	/** Bounds payload size before it ever reaches the queue (spec §66). */
	private static function bound_payload( array $payload ): array {
		$json = wp_json_encode( $payload );
		if ( strlen( (string) $json ) <= 16_000 ) {
			return $payload;
		}
		// Truncate the largest known offender rather than dropping the event.
		if ( isset( $payload['shortDescription'] ) && is_string( $payload['shortDescription'] ) ) {
			$payload['shortDescription'] = mb_substr( $payload['shortDescription'], 0, 200 );
		}
		if ( isset( $payload['variants'] ) && is_array( $payload['variants'] ) ) {
			$payload['variants'] = array_slice( $payload['variants'], 0, 20 );
		}
		return $payload;
	}

	public static function cancel_all(): void {
		if ( function_exists( 'as_unschedule_all_actions' ) ) {
			// Hook only — NOT ( hook, array(), group ). Given both a hook and
			// a group with empty $args, Action Scheduler falls through to a
			// loop that matches only actions whose args are exactly array().
			// Every job this queue schedules carries `event` + `attempt`, so
			// that form cancels nothing and the queue stays armed after a
			// disconnect. Passing the hook alone cancels by hook regardless
			// of args, which is what this method promises.
			as_unschedule_all_actions( self::HOOK );
		}
	}
}
