<?php
namespace WebYar\OpenCart;

/**
 * The machine protocol between Web Yar and this extension.
 *
 * Signing is byte-identical to the WooCommerce bridge and to
 * server/services/commerce/signing.ts (protocol `webyar-commerce/1`). The
 * canonical path is `/opencart/v1/<op>`: OpenCart has no REST router, so the
 * operation travels in the `op` query parameter of ONE catalog route and the
 * signature covers it through the canonical path.
 *
 * Every operation is listed here with the capability it needs, whether it is
 * private (customer-bound) and the plugin-side toggle that can switch it off.
 * There is no generic proxy, no SQL endpoint and no "call any route" path.
 */
final class Protocol {
	public const PROTOCOL_VERSION = 'webyar-commerce/1';
	public const CONNECTOR_VERSION = '1.1.0';
	public const PATH_PREFIX = '/opencart/v1/';
	public const CLOCK_SKEW_SECONDS = 300;
	public const MAX_BODY_BYTES = 65536;
	public const MAX_PAGE_SIZE = 10;
	public const MAX_IDS = 10;
	public const MAX_REVIEWS = 5;
	public const MAX_TERMS = 6;
	public const MAX_TERM_LENGTH = 40;
	public const ASSERTION_TTL = 120;
	public const AUDIENCE = 'webyar-widget';

	/**
	 * Ed25519 public key that release manifests are signed with. The private
	 * key never leaves the Web Yar release host; an update whose manifest
	 * does not verify against this key is never installed.
	 */
	public const UPDATE_PUBLIC_KEY = 'vbNNY6jM7bZvxmvV39oRSZ4XSZ7EMks/eEyyVcrwPKQ=';

	/** op => [capability, private, plugin toggle key or null] */
	public const OPS = [
		'health'              => ['store.read', false, null],
		'products/search'     => ['products.read', false, null],
		'products/get'        => ['products.read', false, null],
		'products/reviews'    => ['reviews.read', false, 'reviews'],
		'catalog/categories'  => ['products.read', false, null],
		'orders/list'         => ['orders.read', true, 'orders'],
		'orders/get'          => ['orders.read', true, 'orders'],
		'orders/tracking'     => ['tracking.read', true, 'orders'],
		'orders/returns'      => ['returns.read', true, 'orders'],
		// Web Yar asks the store to update itself; the store fetches the
		// signed manifest from the fixed Web Yar address and decides.
		'connector/update'    => ['connector.update', false, 'auto_update'],
	];

	public const CAPABILITIES = [
		'store.read',
		'products.read',
		'availability.read',
		'reviews.read',
		'orders.read',
		'tracking.read',
		'returns.read',
		'customer_context',
		'widget.bootstrap',
		'search.direct',
		'connector.update',
	];

	public static function canonicalPath(string $op): string {
		return self::PATH_PREFIX . $op;
	}

	public static function isKnownOp(string $op): bool {
		return isset(self::OPS[$op]);
	}
}
