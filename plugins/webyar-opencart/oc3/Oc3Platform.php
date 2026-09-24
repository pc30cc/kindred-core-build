<?php
namespace WebYar\OpenCart;

/**
 * OpenCart 3.0.5.x adapter. The 3.0.x product model inlines its price
 * sub-queries (and its getProducts() is N+1 by design), so the two price
 * fragments are reproduced here VERBATIM from 3.0.x's
 * catalog/model/catalog/product.php::getProduct(); everything else — tax,
 * currency rounding and formatting, URLs, quantity tiers — goes through the
 * store's own 3.0 objects.
 */
final class Oc3Platform implements Platform {
	private $registry;
	private ?array $languages = null;
	private ?array $currencies = null;

	public function __construct($registry) {
		$this->registry = $registry;
	}

	private function get(string $key) {
		return $this->registry->get($key);
	}

	public function version(): string {
		return defined('VERSION') ? VERSION : '3.0';
	}

	public function storeId(): int {
		return (int)$this->get('config')->get('config_store_id');
	}

	public function config(string $key) {
		return $this->get('config')->get($key);
	}

	public function storageDir(): string {
		return DIR_STORAGE;
	}

	public function sessionDir(): string {
		return defined('DIR_SESSION') ? DIR_SESSION : DIR_STORAGE . 'session/';
	}

	public function databaseName(): string {
		return DB_DATABASE;
	}

	public function languages(): array {
		if ($this->languages === null) {
			$this->get('load')->model('localisation/language');
			$this->languages = [];

			foreach ($this->get('model_localisation_language')->getLanguages() as $code => $language) {
				if ((int)$language['status'] === 1) {
					$this->languages[(string)$code] = ['language_id' => (int)$language['language_id'], 'code' => (string)$code, 'name' => (string)$language['name']];
				}
			}
		}

		return $this->languages;
	}

	public function useLanguage(string $code): void {
		$languages = $this->languages();

		if (!isset($languages[$code]) || (int)$this->config('config_language_id') === $languages[$code]['language_id']) {
			return;
		}

		// As catalog/controller/startup/startup.php does for a session language.
		$language = new \Language($code);
		$language->load($code);
		$this->registry->set('language', $language);
		$this->get('config')->set('config_language_id', $languages[$code]['language_id']);
	}

	public function currencies(): array {
		if ($this->currencies === null) {
			$this->get('load')->model('localisation/currency');
			$this->currencies = [];

			foreach ($this->get('model_localisation_currency')->getCurrencies() as $code => $currency) {
				if ((int)$currency['status'] === 1) {
					$this->currencies[(string)$code] = ['code' => (string)$code, 'value' => (float)$currency['value'], 'decimal_place' => (int)$currency['decimal_place']];
				}
			}
		}

		return $this->currencies;
	}

	public function formatMoney(float $amount, string $currency, float $rate = 0.0): string {
		return (string)$this->get('currency')->format($amount, $currency, $rate ?: '');
	}

	public function convertMoney(float $amount, string $currency, float $rate = 0.0): float {
		return (float)$this->get('currency')->format($amount, $currency, $rate ?: '', false);
	}

	public function useCustomerGroup(int $customerGroupId): void {
		$this->get('config')->set('config_customer_group_id', $customerGroupId);
	}

	public function useTaxAddresses(?array $shipping, ?array $payment): void {
		$tax = new \Cart\Tax($this->registry);

		if ($shipping) {
			$tax->setShippingAddress($shipping['country_id'], $shipping['zone_id']);
		} elseif ($this->config('config_tax_default') == 'shipping') {
			$tax->setShippingAddress($this->config('config_country_id'), $this->config('config_zone_id'));
		}

		if ($payment) {
			$tax->setPaymentAddress($payment['country_id'], $payment['zone_id']);
		} elseif ($this->config('config_tax_default') == 'payment') {
			$tax->setPaymentAddress($this->config('config_country_id'), $this->config('config_zone_id'));
		}

		$tax->setStoreAddress($this->config('config_country_id'), $this->config('config_zone_id'));
		$this->registry->set('tax', $tax);
	}

	public function withTax(float $value, int $taxClassId): float {
		return (float)$this->get('tax')->calculate($value, $taxClassId, $this->config('config_tax'));
	}

	public function priceStatements(): array {
		$group = (int)$this->config('config_customer_group_id');

		return [
			'discount' => "(SELECT price FROM " . DB_PREFIX . "product_discount pd2 WHERE pd2.product_id = p.product_id AND pd2.customer_group_id = '" . $group . "' AND pd2.quantity = '1' AND ((pd2.date_start = '0000-00-00' OR pd2.date_start < NOW()) AND (pd2.date_end = '0000-00-00' OR pd2.date_end > NOW())) ORDER BY pd2.priority ASC, pd2.price ASC LIMIT 1) AS discount",
			'special'  => "(SELECT price FROM " . DB_PREFIX . "product_special ps WHERE ps.product_id = p.product_id AND ps.customer_group_id = '" . $group . "' AND ((ps.date_start = '0000-00-00' OR ps.date_start < NOW()) AND (ps.date_end = '0000-00-00' OR ps.date_end > NOW())) ORDER BY ps.priority ASC, ps.price ASC LIMIT 1) AS special",
		];
	}

	public function quantityDiscounts(int $productId): array {
		$this->get('load')->model('catalog/product');

		return array_map(fn ($d) => ['quantity' => (int)$d['quantity'], 'price' => (float)$d['price']], $this->get('model_catalog_product')->getProductDiscounts($productId));
	}

	public function link(string $route, array $args = []): string {
		return str_replace('&amp;', '&', (string)$this->get('url')->link($route, http_build_query($args), true));
	}

	public function extensionLink(string $method, array $args = []): string {
		return $this->link('extension/module/webyar/' . $method, $args);
	}

	public function imageUrl(string $path): ?string {
		$path = ltrim($path, '/');
		$base = (string)($this->config('config_ssl') ?: $this->config('config_url'));

		return $path !== '' ? rtrim($base, '/') . '/image/' . str_replace(' ', '%20', $path) : null;
	}

	public function trackingFromExtensions(array $order): array {
		$shipments = [];
		$this->get('event')->trigger('webyar/order/tracking', [&$order, &$shipments]);

		return is_array($shipments) ? $shipments : [];
	}
}
