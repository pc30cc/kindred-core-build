<?php
namespace WebYar\OpenCart;

/**
 * What the core needs from a specific OpenCart major version. Implemented by
 * the 3.0.x and 4.1.x wrappers with that version's OWN objects (url builder,
 * tax, currency, language, product model SQL) — the core never re-derives a
 * price, a rounding rule or a URL on its own.
 */
interface Platform {
	public function version(): string;

	public function storeId(): int;

	/** @return mixed */
	public function config(string $key);

	public function storageDir(): string;

	public function sessionDir(): string;

	public function databaseName(): string;

	/** @return array<string,array{language_id:int,code:string,name:string}> enabled languages keyed by code */
	public function languages(): array;

	public function useLanguage(string $code): void;

	/** @return array<string,array{code:string,value:float,decimal_place:int}> enabled currencies keyed by code */
	public function currencies(): array;

	/** Formatted exactly as the storefront formats it (OpenCart's Currency::format). */
	public function formatMoney(float $amount, string $currency, float $rate = 0.0): string;

	/** Converted and rounded exactly as Currency::format(..., false) does. */
	public function convertMoney(float $amount, string $currency, float $rate = 0.0): float;

	public function useCustomerGroup(int $customerGroupId): void;

	/**
	 * @param array{country_id:int,zone_id:int}|null $shipping
	 * @param array{country_id:int,zone_id:int}|null $payment
	 */
	public function useTaxAddresses(?array $shipping, ?array $payment): void;

	/** Tax::calculate with the store's own "display prices with tax" setting. */
	public function withTax(float $value, int $taxClassId): float;

	/**
	 * The store's own SQL fragments for the customer-group price in force
	 * (`discount`, quantity 1) and the active special (`special`), aliased
	 * against `p` = product. Must be read AFTER useCustomerGroup().
	 *
	 * @return array{discount:string,special:string}
	 */
	public function priceStatements(): array;

	/**
	 * Quantity-discount tiers (quantity > 1) for the effective customer group,
	 * through the store's own model method — how a percentage or fixed
	 * discount is turned into a price differs between 4.1.x releases.
	 *
	 * @return array<int,array{quantity:int,price:float}>
	 */
	public function quantityDiscounts(int $productId): array;

	/** Storefront link through OpenCart's own URL builder (SEO rewrite included). */
	public function link(string $route, array $args = []): string;

	/** Link to one of this extension's own catalog methods. */
	public function extensionLink(string $method, array $args = []): string;

	public function imageUrl(string $path): ?string;

	/**
	 * Tracking extension point: fires this version's event system so another
	 * extension can supply shipment tracking for an order it knows about.
	 *
	 * @param array<string,mixed> $order
	 * @return array<int,array<string,mixed>>
	 */
	public function trackingFromExtensions(array $order): array;
}
