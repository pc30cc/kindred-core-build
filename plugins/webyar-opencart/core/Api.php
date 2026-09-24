<?php
namespace WebYar\OpenCart;

/**
 * The ONE machine endpoint Web Yar calls. Order of checks, cheapest and
 * least-trusting first:
 *
 *   method/size → known operation → a connection for THIS store and the
 *   named installation → HMAC over the canonical path + body (no DB) →
 *   nonce (one INSERT) → body store_id matches → merchant toggle →
 *   customer re-validation for private operations → the read itself.
 *
 * Every response carries `_meta.db` — how many queries the store ran for it —
 * so the resource cost is observable in production, not only in tests.
 */
final class Api {
	private Db $db;
	private Platform $platform;
	private Settings $settings;
	private string $localKey;
	private array $schema;

	public function __construct(Db $db, Platform $platform, Settings $settings, string $localKey, array $schema) {
		$this->db = $db;
		$this->platform = $platform;
		$this->settings = $settings;
		$this->localKey = $localKey;
		$this->schema = $schema;
	}

	/**
	 * @param array<string,string> $headers lower-cased
	 * @return array{status:int,body:array<string,mixed>}
	 */
	public function handle(string $method, string $op, array $headers, string $body): array {
		$started = microtime(true);

		try {
			$data = $this->dispatch($method, $op, $headers, $body);
			$status = 200;
		} catch (ApiError $e) {
			$data = ['error' => $e->errorCode];
			$status = $e->status;
		} catch (\Throwable $e) {
			// Never a stack trace or SQL error to the caller.
			$data = ['error' => 'internal_error'];
			$status = 500;
		}

		$data['_meta'] = [
			'connector_version' => Protocol::CONNECTOR_VERSION,
			'db'                => $this->db->stats(),
			'ms'                => round((microtime(true) - $started) * 1000, 1),
		];

		return ['status' => $status, 'body' => $data];
	}

	private function dispatch(string $method, string $op, array $headers, string $body): array {
		if ($method !== 'POST') {
			throw new ApiError('method_not_allowed', 405);
		}

		if (strlen($body) > Protocol::MAX_BODY_BYTES) {
			throw new ApiError('body_too_large', 413);
		}

		if (!Protocol::isKnownOp($op)) {
			throw new ApiError('unknown_operation', 404);
		}

		$storeId = $this->platform->storeId();
		// Already in the store's config (OpenCart loaded every setting row of
		// this store at startup); the table is read only if it is not.
		$record = $this->platform->config('module_webyar_conn');

		if (!is_array($record) || (int)($record['store_id'] ?? -1) !== $storeId) {
			$record = $this->settings->get($storeId, 'conn');
		}

		$conn = is_array($record) && (int)($record['store_id'] ?? -1) === $storeId ? Connection::fromRecord($record, $this->localKey) : null;

		if (!$conn) {
			throw new ApiError('not_connected', 403);
		}

		$failure = Signer::verify($headers, $conn->secret(), $conn->installationId, 'POST', Protocol::canonicalPath($op), $body);

		if ($failure !== null) {
			throw new ApiError($failure, $failure === 'protocol_mismatch' ? 400 : 401);
		}

		if (!(new ReplayGuard($this->db))->claim($conn->installationId, (string)$headers['x-webyar-nonce'])) {
			throw new ApiError('replay', 401);
		}

		$input = $body === '' ? [] : json_decode($body, true);

		if (!is_array($input)) {
			throw new ApiError('invalid_json', 422);
		}

		// Signed, so it cannot be altered in transit: the store Web Yar meant
		// must be the store OpenCart resolved for this request.
		if ((string)($input['store_id'] ?? '') !== (string)$storeId) {
			throw new ApiError('store_mismatch', 403);
		}

		[$capability, $private, $toggle] = Protocol::OPS[$op];

		if (!$this->platform->config('module_webyar_status')) {
			throw new ApiError('extension_disabled', 503);
		}

		if ($toggle !== null && !$this->toggleOn($toggle)) {
			throw new ApiError('disabled_by_store', 403);
		}

		$verified = null;
		$identity = new Identity($this->db, $this->platform, $this->localKey);

		if ($private) {
			$verified = $identity->verifyCustomer($conn, $input['customer'] ?? null);
		} elseif (isset($input['customer']) && is_array($input['customer'])) {
			// A signed-in shopper sees their group's prices — but only while
			// that session is still theirs. A stale reference quietly falls
			// back to guest pricing rather than failing a public question.
			try {
				$verified = $identity->verifyCustomer($conn, $input['customer']);
			} catch (ApiError $e) {
				$verified = null;
			}
		}

		if ($op === 'health') {
			return $this->health($conn);
		}

		$ctx = Context::apply($this->platform, $input, $verified);
		$catalog = new Catalog($this->db, $this->platform, $ctx, $this->schema);

		switch ($op) {
			case 'products/search':
				$result = $catalog->search($input);
				break;
			case 'products/get':
				$result = $catalog->get($input);
				break;
			case 'products/reviews':
				$result = $catalog->reviews($input);
				break;
			case 'catalog/categories':
				$result = $catalog->categories($input);
				break;
			default:
				$orders = new Orders($this->db, $this->platform, $ctx, $this->schema, (int)$verified['customer_id']);

				if ($op === 'orders/list') {
					$result = $orders->list($input);
				} elseif ($op === 'orders/get') {
					$result = $orders->get($input);
				} elseif ($op === 'orders/tracking') {
					$result = $orders->tracking($input);
				} else {
					$result = $orders->returns($input);
				}
		}

		$result['context'] = $ctx->toArray();

		return $result;
	}

	private function toggleOn(string $toggle): bool {
		$value = $this->platform->config('module_webyar_' . $toggle);

		// Unset means the documented default: on.
		return $value === null || $value === '' || (bool)$value;
	}

	/** @return array<string,mixed> */
	private function health(Connection $conn): array {
		$capabilities = array_values(array_filter(Protocol::CAPABILITIES, function ($cap) {
			if (in_array($cap, ['orders.read', 'tracking.read', 'returns.read'], true)) {
				return $this->toggleOn('orders') && ($cap !== 'returns.read' || !empty($this->schema['return_table']));
			}

			if ($cap === 'reviews.read') {
				return $this->toggleOn('reviews');
			}

			if ($cap === 'widget.bootstrap') {
				return (bool)$this->platform->config('module_webyar_widget');
			}

			return true;
		}));

		$engine = (string)($this->platform->config('session_engine') ?: 'db');

		return [
			'protocol_version'  => Protocol::PROTOCOL_VERSION,
			'connector_version' => Protocol::CONNECTOR_VERSION,
			'platform'          => 'opencart',
			'platform_version'  => $this->platform->version(),
			'php_version'       => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
			'store'             => [
				'id'               => (string)$this->platform->storeId(),
				'name'             => Text::clean($this->platform->config('config_name'), 120),
				'url'              => $conn->storeUrl,
				'default_language' => (string)($this->platform->config('config_language_catalog') ?: $this->platform->config('config_language')),
				'default_currency' => (string)$this->platform->config('config_currency'),
				'languages'        => array_keys($this->platform->languages()),
				'currencies'       => array_keys($this->platform->currencies()),
			],
			'capabilities'      => $capabilities,
			'search'            => ['strategy' => 'direct', 'mode' => 'store_sql_like', 'max_page_size' => Protocol::MAX_PAGE_SIZE],
			'store_policy'      => [
				'prices_require_login' => (bool)$this->platform->config('config_customer_price'),
				'stock_display'        => (bool)$this->platform->config('config_stock_display'),
				'stock_checkout'       => (bool)$this->platform->config('config_stock_checkout'),
				'prices_include_tax'   => (bool)$this->platform->config('config_tax'),
				'reviews_enabled'      => (bool)$this->platform->config('config_review_status'),
				'customer_scope'       => (string)($this->platform->config('module_webyar_customer_scope') ?: 'installation'),
				'session_engine'       => in_array($engine, ['db', 'file'], true) ? $engine : 'unsupported',
			],
			// A connection is only "ready" for direct reads; there is no
			// catalogue to sync, so this is not a sync flag.
			'catalog_ready'     => true,
		];
	}
}
