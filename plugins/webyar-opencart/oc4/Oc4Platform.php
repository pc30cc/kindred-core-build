<?php
namespace WebYar\OpenCart;

/**
 * OpenCart 4.1.x adapter: every price, rounding, URL and language decision
 * is delegated to the running store's own 4.1 objects.
 */
final class Oc4Platform implements Platform {
	/** @var \Opencart\System\Engine\Registry */
	private $registry;
	private ?array $statements = null;
	private ?array $languages = null;
	private ?array $currencies = null;

	public function __construct($registry) {
		$this->registry = $registry;
	}

	private function get(string $key) {
		return $this->registry->get($key);
	}

	public function version(): string {
		return defined('VERSION') ? VERSION : '4.1';
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
				$this->languages[(string)$code] = ['language_id' => (int)$language['language_id'], 'code' => (string)$code, 'name' => (string)$language['name']];
			}
		}

		return $this->languages;
	}

	public function useLanguage(string $code): void {
		if ($code === (string)$this->config('config_language')) {
			return;
		}

		// Let the store's own startup do it, exactly as for ?language=… on a
		// storefront URL: config_language(_id), language directory, strings.
		$this->get('request')->get['language'] = $code;
		$this->get('load')->controller('startup/language');
	}

	public function currencies(): array {
		if ($this->currencies === null) {
			$this->get('load')->model('localisation/currency');
			$this->currencies = [];

			foreach ($this->get('model_localisation_currency')->getCurrencies() as $code => $currency) {
				$this->currencies[(string)$code] = ['code' => (string)$code, 'value' => (float)$currency['value'], 'decimal_place' => (int)$currency['decimal_place']];
			}
		}

		return $this->currencies;
	}

	public function formatMoney(float $amount, string $currency, float $rate = 0.0): string {
		return (string)$this->get('currency')->format($amount, $currency, $rate);
	}

	public function convertMoney(float $amount, string $currency, float $rate = 0.0): float {
		return (float)$this->get('currency')->format($amount, $currency, $rate, false);
	}

	public function useCustomerGroup(int $customerGroupId): void {
		$this->get('config')->set('config_customer_group_id', $customerGroupId);
		$this->statements = null;
	}

	public function useTaxAddresses(?array $shipping, ?array $payment): void {
		// Same sequence as catalog/controller/startup/tax.php, with the
		// shopper's own session addresses in place of the store default.
		$tax = new \Opencart\System\Library\Cart\Tax($this->registry);

		if ($shipping) {
			$tax->setShippingAddress($shipping['country_id'], $shipping['zone_id']);
		} elseif ($this->config('config_tax_default') == 'shipping') {
			$tax->setShippingAddress((int)$this->config('config_country_id'), (int)$this->config('config_zone_id'));
		}

		if ($payment) {
			$tax->setPaymentAddress($payment['country_id'], $payment['zone_id']);
		} elseif ($this->config('config_tax_default') == 'payment') {
			$tax->setPaymentAddress((int)$this->config('config_country_id'), (int)$this->config('config_zone_id'));
		}

		$tax->setStoreAddress((int)$this->config('config_country_id'), (int)$this->config('config_zone_id'));
		$this->registry->set('tax', $tax);
	}

	public function withTax(float $value, int $taxClassId): float {
		return (float)$this->get('tax')->calculate($value, $taxClassId, (bool)$this->config('config_tax'));
	}

	public function priceStatements(): array {
		if ($this->statements === null) {
			// The 4.1 catalog product model builds its price sub-queries in its
			// constructor from config_customer_group_id. Reading them from a
			// fresh instance reuses THIS release's semantics — they changed
			// between 4.1.0.0 and 4.1.0.4 — instead of re-implementing them.
			$model = new class($this->registry) extends \Opencart\Catalog\Model\Catalog\Product {
				public function webyarStatements(): array {
					return $this->statement;
				}
			};
			$all = $model->webyarStatements();
			$this->statements = ['discount' => (string)$all['discount'], 'special' => (string)$all['special']];
		}

		return $this->statements;
	}

	public function quantityDiscounts(int $productId): array {
		$this->get('load')->model('catalog/product');

		return array_map(fn ($d) => ['quantity' => (int)$d['quantity'], 'price' => (float)$d['price']], $this->get('model_catalog_product')->getDiscounts($productId));
	}

	public function link(string $route, array $args = []): string {
		$args = ['language' => (string)$this->config('config_language')] + $args;

		return str_replace('&amp;', '&', (string)$this->get('url')->link($route, http_build_query($args)));
	}

	public function extensionLink(string $method, array $args = []): string {
		return $this->link('extension/webyar/module/webyar.' . $method, $args);
	}

	public function imageUrl(string $path): ?string {
		$path = ltrim($path, '/');

		return (is_file(DIR_IMAGE . $path) || $path !== '') ? rtrim((string)$this->config('config_url'), '/') . '/image/' . str_replace(' ', '%20', $path) : null;
	}

	public function trackingFromExtensions(array $order): array {
		$shipments = [];
		$this->get('event')->trigger('webyar/order/tracking', [&$order, &$shipments]);

		return is_array($shipments) ? $shipments : [];
	}
}
