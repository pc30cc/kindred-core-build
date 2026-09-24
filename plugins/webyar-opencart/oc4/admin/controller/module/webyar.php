<?php
namespace Opencart\Admin\Controller\Extension\Webyar\Module;

require_once DIR_EXTENSION . 'webyar/system/library/webyar/autoload.php';

use WebYar\OpenCart\Connection;
use WebYar\OpenCart\Db;
use WebYar\OpenCart\LocalKey;
use WebYar\OpenCart\Pairing;
use WebYar\OpenCart\Protocol;
use WebYar\OpenCart\Schema;
use WebYar\OpenCart\Settings;

/**
 * Web Yar — admin side (OpenCart 4.1.x). Extensions → Extensions → Modules.
 *
 * Access and modify are OpenCart's own user-group permissions on
 * `extension/webyar/module/webyar` (granted to the installing group by the
 * core on install). Every state-changing action is a POST that must carry
 * both the core's session-bound user_token (checked by OpenCart for every
 * admin route) and this page's own per-session form token.
 */
class Webyar extends \Opencart\System\Engine\Controller {
	private const ROUTE = 'extension/webyar/module/webyar';
	private const EVENT_CODE = 'webyar_widget';

	public function index(): void {
		$this->load->language(self::ROUTE);
		$this->document->setTitle($this->language->get('heading_title'));
		$token = 'user_token=' . $this->session->data['user_token'];

		$data['breadcrumbs'] = [
			['text' => $this->language->get('text_home'), 'href' => $this->url->link('common/dashboard', $token)],
			['text' => $this->language->get('text_extension'), 'href' => $this->url->link('marketplace/extension', $token . '&type=module')],
			['text' => $this->language->get('heading_title'), 'href' => $this->url->link(self::ROUTE, $token)],
		];

		$data['supported'] = self::supported();
		$data['text_unsupported'] = sprintf($this->language->get('text_unsupported'), VERSION);

		if ($data['supported'] && $this->user->hasPermission('modify', self::ROUTE)) {
			// Idempotent upgrade: a new package version or OpenCart update re-runs
			// the install steps once, never on every page view.
			$this->upgradeIfNeeded();
		}

		$db = new Db($this->db, DB_PREFIX);
		$settings = new Settings($db);
		$key = LocalKey::load(DIR_STORAGE);

		$data['csrf'] = $this->csrf();
		$data['save'] = $this->url->link(self::ROUTE . '.save', $token);
		$data['connect'] = $this->url->link(self::ROUTE . '.connect', $token);
		$data['disconnect'] = $this->url->link(self::ROUTE . '.disconnect', $token);
		$data['test'] = $this->url->link(self::ROUTE . '.test', $token);
		$data['back'] = $this->url->link('marketplace/extension', $token . '&type=module');

		$data['module_webyar_status'] = (int)$this->config->get('module_webyar_status');
		$data['module_webyar_orders'] = $this->toggle('orders');
		$data['module_webyar_reviews'] = $this->toggle('reviews');
		$data['module_webyar_customer_scope'] = (string)($this->config->get('module_webyar_customer_scope') ?: 'installation');
		$data['module_webyar_app_url'] = (string)($this->config->get('module_webyar_app_url') ?: '');
		$data['module_webyar_api_url'] = (string)($this->config->get('module_webyar_api_url') ?: '');
		$data['key_ok'] = $key !== null;
		$data['version'] = Protocol::CONNECTOR_VERSION;
		$data['oc_version'] = VERSION;

		$data['stores'] = [];

		foreach ($this->stores() as $store) {
			$record = $settings->get($store['store_id'], 'conn');
			$connected = is_array($record) && (int)($record['store_id'] ?? -1) === $store['store_id'] && $key !== null && Connection::fromRecord($record, $key) !== null;
			$data['stores'][] = $store + [
				'connected'     => $connected,
				'https'         => stripos($store['url'], 'https://') === 0,
				'workspace_id'  => $connected ? (string)$record['workspace_id'] : '',
				'connection_id' => $connected ? (string)($record['connection_id'] ?? '') : '',
				'paired_at'     => $connected ? (string)$record['paired_at'] : '',
				'widget'        => (int)$settings->get($store['store_id'], 'widget', 0),
			];
		}

		$data['header'] = $this->load->controller('common/header');
		$data['column_left'] = $this->load->controller('common/column_left');
		$data['footer'] = $this->load->controller('common/footer');

		$this->response->setOutput($this->load->view(self::ROUTE, $data));
	}

	public function save(): void {
		$this->load->language(self::ROUTE);
		$json = $this->guard();

		if (!$json) {
			$post = $this->request->post;
			$app = trim((string)($post['module_webyar_app_url'] ?? ''));
			$api = trim((string)($post['module_webyar_api_url'] ?? ''));

			foreach ([$app, $api] as $url) {
				if ($url !== '' && !\WebYar\OpenCart\Http::allowedUrl($url)) {
					$json['error'] = $this->language->get('error_url');
				}
			}

			if (!$json) {
				$settings = new Settings(new Db($this->db, DB_PREFIX));
				$settings->set(0, 'status', !empty($post['module_webyar_status']) ? '1' : '0');
				$settings->set(0, 'orders', !empty($post['module_webyar_orders']) ? '1' : '0');
				$settings->set(0, 'reviews', !empty($post['module_webyar_reviews']) ? '1' : '0');
				$settings->set(0, 'customer_scope', ($post['module_webyar_customer_scope'] ?? '') === 'registration_store' ? 'registration_store' : 'installation');
				$settings->set(0, 'app_url', rtrim($app, '/'));
				$settings->set(0, 'api_url', rtrim($api, '/'));

				foreach ($this->stores() as $store) {
					// Written on EVERY store row: store 0's value would otherwise
					// leak into stores that have none of their own.
					$settings->set($store['store_id'], 'widget', !empty($post['widget'][$store['store_id']]) ? '1' : '0');
				}

				$json['success'] = $this->language->get('text_success');
			}
		}

		$this->sendJson($json);
	}

	public function connect(): void {
		$this->load->language(self::ROUTE);
		$json = $this->guard();
		$store = $this->storeFromPost();

		if (!$json && !$store) {
			$json['error'] = $this->language->get('error_store');
		}

		if (!$json) {
			$app = (string)($this->config->get('module_webyar_app_url') ?: '');

			if ($app === '') {
				$json['error'] = $this->language->get('error_app_url');
			} elseif (stripos($store['url'], 'https://') !== 0) {
				$json['error'] = $this->language->get('error_https');
			} else {
				try {
					$key = LocalKey::load(DIR_STORAGE, true);

					if ($key === null) {
						throw new \RuntimeException($this->language->get('error_storage'));
					}

					$pairing = new Pairing(new Settings(new Db($this->db, DB_PREFIX)), $key);
					$callback = $store['url'] . 'index.php?route=extension/webyar/module/webyar.callback';
					$json['redirect'] = $pairing->start($store['store_id'], $store['url'], $callback, $app, (string)($this->config->get('module_webyar_api_url') ?: $app));
				} catch (\Throwable $e) {
					$json['error'] = sprintf($this->language->get('error_connect'), htmlspecialchars($e->getMessage(), ENT_QUOTES, 'UTF-8'));
				}
			}
		}

		$this->sendJson($json);
	}

	public function disconnect(): void {
		$this->load->language(self::ROUTE);
		$json = $this->guard();
		$store = $this->storeFromPost();

		if (!$json && $store) {
			$key = LocalKey::load(DIR_STORAGE);
			$settings = new Settings(new Db($this->db, DB_PREFIX));

			if ($key !== null) {
				(new Pairing($settings, $key))->disconnect($store['store_id']);
			} else {
				$settings->delete($store['store_id'], 'conn');
			}

			$json['success'] = $this->language->get('text_disconnected');
			$json['redirect'] = str_replace('&amp;', '&', $this->url->link(self::ROUTE, 'user_token=' . $this->session->data['user_token']));
		}

		$this->sendJson($json);
	}

	public function test(): void {
		$this->load->language(self::ROUTE);
		$json = $this->guard();
		$store = $this->storeFromPost();

		if (!$json && $store) {
			// Throttled locally too: at most one check every 30 s per admin session.
			$last = (int)($this->session->data['webyar_test_at'] ?? 0);

			if ($last > time() - 30) {
				$json['error'] = $this->language->get('error_test_throttled');
			} else {
				$this->session->data['webyar_test_at'] = time();
				$key = LocalKey::load(DIR_STORAGE);
				$record = (new Settings(new Db($this->db, DB_PREFIX)))->get($store['store_id'], 'conn');
				$conn = ($key !== null && is_array($record)) ? Connection::fromRecord($record, $key) : null;

				if (!$conn) {
					$json['error'] = $this->language->get('error_not_connected');
				} else {
					try {
						$result = Pairing::signedAction($conn, 'test');

						if ($result['status'] === 200) {
							$json['success'] = $this->language->get('text_test_ok');
						} else {
							$json['error'] = sprintf($this->language->get('error_test'), (string)($result['json']['error'] ?? $result['status']));
						}
					} catch (\Throwable $e) {
						$json['error'] = sprintf($this->language->get('error_test'), htmlspecialchars($e->getMessage(), ENT_QUOTES, 'UTF-8'));
					}
				}
			}
		}

		$this->sendJson($json);
	}

	public function install(): void {
		// Called by the core's module installer after IT checked the user may
		// modify modules; this request's user object predates the permission
		// the core just granted on our own route, so that one is not checked.
		if (!self::supported() || !$this->user->hasPermission('modify', 'extension/module')) {
			return;
		}

		$this->installSteps();
		$settings = new Settings(new Db($this->db, DB_PREFIX));

		if ($settings->get(0, 'status') === null) {
			$settings->set(0, 'status', '1');
			$settings->set(0, 'orders', '1');
			$settings->set(0, 'reviews', '1');
		}
	}

	public function uninstall(): void {
		if (!$this->user->hasPermission('modify', 'extension/module')) {
			return;
		}

		$db = new Db($this->db, DB_PREFIX);
		$settings = new Settings($db);
		$key = LocalKey::load(DIR_STORAGE);

		// Tell Web Yar each connected store is going away (best effort).
		if ($key !== null) {
			foreach (array_keys($settings->allConnections()) as $storeId) {
				(new Pairing($settings, $key))->disconnect($storeId);
			}
		}

		$this->load->model('setting/event');
		$this->model_setting_event->deleteEventByCode(self::EVENT_CODE);
		// Only rows, tables and files this extension created.
		$settings->deleteAll();
		(new Schema($db, DB_DATABASE))->uninstall();
		LocalKey::remove(DIR_STORAGE);
	}

	// ── internals ──────────────────────────────────────────────────────

	private static function supported(): bool {
		return version_compare(VERSION, '4.1.0.0', '>=') && version_compare(VERSION, '4.2.0.0', '<') && PHP_VERSION_ID >= 80100;
	}

	private function installSteps(): void {
		$db = new Db($this->db, DB_PREFIX);
		$schema = new Schema($db, DB_DATABASE);
		$schema->install();
		$settings = new Settings($db);
		$settings->set(0, 'schema', $schema->detect(VERSION) + ['connector' => Protocol::CONNECTOR_VERSION]);
		LocalKey::load(DIR_STORAGE, true);

		// Delete-then-add: re-running install never leaves two widget events.
		$this->load->model('setting/event');
		$this->model_setting_event->deleteEventByCode(self::EVENT_CODE);
		$this->model_setting_event->addEvent([
			'code'        => self::EVENT_CODE,
			'description' => 'Web Yar: add the chat widget loader to storefront pages',
			'trigger'     => 'catalog/view/common/footer/after',
			'action'      => self::ROUTE . '.injectWidget',
			'status'      => 1,
			'sort_order'  => 0,
		]);
	}

	private function upgradeIfNeeded(): void {
		$schema = $this->config->get('module_webyar_schema');

		if (!is_array($schema) || ($schema['version'] ?? '') !== VERSION || ($schema['connector'] ?? '') !== Protocol::CONNECTOR_VERSION) {
			$this->installSteps();
		}
	}

	private function toggle(string $name): int {
		$value = $this->config->get('module_webyar_' . $name);

		return ($value === null || $value === '') ? 1 : (int)$value;
	}

	/** @return array<int,array{store_id:int,name:string,url:string}> */
	private function stores(): array {
		$stores = [['store_id' => 0, 'name' => (string)$this->config->get('config_name'), 'url' => rtrim(HTTP_CATALOG, '/') . '/']];
		$this->load->model('setting/store');

		foreach ($this->model_setting_store->getStores() as $store) {
			$stores[] = ['store_id' => (int)$store['store_id'], 'name' => (string)$store['name'], 'url' => rtrim((string)$store['url'], '/') . '/'];
		}

		return $stores;
	}

	private function storeFromPost(): ?array {
		$id = (int)($this->request->post['store_id'] ?? -1);

		foreach ($this->stores() as $store) {
			if ($store['store_id'] === $id) {
				return $store;
			}
		}

		return null;
	}

	private function csrf(): string {
		if (empty($this->session->data['webyar_csrf'])) {
			$this->session->data['webyar_csrf'] = bin2hex(random_bytes(16));
		}

		return $this->session->data['webyar_csrf'];
	}

	/** @return array<string,string> empty when the request may proceed */
	private function guard(): array {
		if (!$this->user->hasPermission('modify', self::ROUTE)) {
			return ['error' => $this->language->get('error_permission')];
		}

		if (($this->request->server['REQUEST_METHOD'] ?? '') !== 'POST' || empty($this->session->data['webyar_csrf']) || !hash_equals((string)$this->session->data['webyar_csrf'], (string)($this->request->post['webyar_csrf'] ?? ''))) {
			return ['error' => $this->language->get('error_csrf')];
		}

		if (!self::supported()) {
			return ['error' => sprintf($this->language->get('text_unsupported'), VERSION)];
		}

		return [];
	}

	private function sendJson(array $json): void {
		$this->response->addHeader('Content-Type: application/json');
		$this->response->setOutput((string)json_encode($json));
	}
}
