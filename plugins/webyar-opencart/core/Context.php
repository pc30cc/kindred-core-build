<?php
namespace WebYar\OpenCart;

/**
 * The effective storefront context of ONE API request: which language,
 * currency, customer group and tax location every price and text in the
 * response was computed for. It is returned with the response so Web Yar can
 * key its cache on what the store actually used rather than on what it asked.
 */
final class Context {
	public int $storeId;
	public int $languageId;
	public string $language;
	public string $currency;
	public int $customerGroupId;
	public bool $customer;
	public bool $pricesVisible;
	public bool $taxDisplay;
	public string $taxRegion;

	/**
	 * @param array<string,mixed> $input  request body (language / currency hints)
	 * @param array<string,mixed>|null $verified Identity::verifyCustomer() result
	 */
	public static function apply(Platform $platform, array $input, ?array $verified): self {
		$c = new self();
		$c->storeId = $platform->storeId();

		$languages = $platform->languages();
		$code = self::pickLanguage($languages, (string)($input['language'] ?? ''), (string)($platform->config('config_language_catalog') ?: $platform->config('config_language')));

		if ($code !== null) {
			$platform->useLanguage($code);
			$c->language = $code;
			$c->languageId = (int)$languages[$code]['language_id'];
		} else {
			$c->language = (string)$platform->config('config_language');
			$c->languageId = (int)$platform->config('config_language_id');
		}

		$currencies = $platform->currencies();
		$currency = strtoupper((string)($input['currency'] ?? ''));

		if ($verified && !empty($verified['session']['currency']) && isset($currencies[(string)$verified['session']['currency']])) {
			// The currency the signed-in shopper selected on the storefront.
			$currency = (string)$verified['session']['currency'];
		}

		$c->currency = isset($currencies[$currency]) ? $currency : (string)$platform->config('config_currency');

		$c->customer = $verified !== null;
		$c->customerGroupId = $verified ? (int)$verified['customer_group_id'] : (int)$platform->config('config_customer_group_id');
		$platform->useCustomerGroup($c->customerGroupId);

		$shipping = $verified ? self::address($verified['session']['shipping_address'] ?? null) : null;
		$payment = $verified ? self::address($verified['session']['payment_address'] ?? null) : null;

		if ($shipping || $payment) {
			$platform->useTaxAddresses($shipping, $payment);
		}

		$c->taxRegion = $shipping ? 's' . $shipping['country_id'] . ':' . $shipping['zone_id'] : ($payment ? 'p' . $payment['country_id'] . ':' . $payment['zone_id'] : 'store');
		$c->taxDisplay = (bool)$platform->config('config_tax');
		// Same rule as the storefront product page.
		$c->pricesVisible = $c->customer || !$platform->config('config_customer_price');

		return $c;
	}

	/** @return array<string,mixed> */
	public function toArray(): array {
		return [
			'store_id'          => $this->storeId,
			'language'          => $this->language,
			'currency'          => $this->currency,
			'customer_group_id' => $this->customerGroupId,
			'customer'          => $this->customer,
			'prices_visible'    => $this->pricesVisible,
			'tax_included'      => $this->taxDisplay,
			'tax_region'        => $this->taxRegion,
		];
	}

	private static function pickLanguage(array $languages, string $hint, string $default): ?string {
		$hint = strtolower(trim($hint));

		if ($hint !== '' && isset($languages[$hint])) {
			return $hint;
		}

		if ($hint !== '') {
			$prefix = explode('-', $hint)[0];

			foreach ($languages as $code => $language) {
				if (explode('-', strtolower((string)$code))[0] === $prefix) {
					return (string)$code;
				}
			}
		}

		return isset($languages[$default]) ? $default : null;
	}

	private static function address($raw): ?array {
		if (!is_array($raw) || empty($raw['country_id'])) {
			return null;
		}

		return ['country_id' => (int)$raw['country_id'], 'zone_id' => (int)($raw['zone_id'] ?? 0)];
	}
}
