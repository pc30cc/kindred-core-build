<?php
namespace WebYar\OpenCart;

/**
 * The admin side, shared by the OpenCart 4.1 and 3.0 controllers: only
 * routes, the event API and a few config keys differ, and those come from
 * the small hooks each controller implements (bottom of this trait).
 *
 * Access and modify are OpenCart's own user-group permissions on the
 * extension's route. Every state-changing action is a POST that must carry
 * both the core's session-bound user_token (checked by OpenCart for every
 * admin route) and this page's own per-session form token.
 */
trait AdminActions {
	public function index(): void {
		$this->load->language($this->wyRoute());
		$lang = $this->wyLanguage();
		$t = I18n::strings($lang);
		$this->document->setTitle($t['heading_title']);
		$token = 'user_token=' . $this->session->data['user_token'];
		$supported = $this->wySupported();
		$db = new Db($this->db, DB_PREFIX);
		$settings = new Settings($db);

		if ($supported && $this->user->hasPermission('modify', $this->wyRoute())) {
			// Idempotent upgrade: a new package version or OpenCart update re-runs
			// the install steps once, never on every page view.
			$this->wyUpgradeIfNeeded();

			if ($settings->get(0, 'admin_dir') !== DIR_APPLICATION) {
				$settings->set(0, 'admin_dir', DIR_APPLICATION);
			}

			// Fallback update path (Web Yar normally asks the store itself):
			// at most every 12 hours, only when connected and allowed.
			$updater = new Updater($db, $settings, $this->wyPlatform());
			$state = $updater->state();

			if ($updater->enabled() && Updater::supported() && $settings->allConnections() && (int)($state['checked_at'] ?? 0) < time() - 43200) {
				$result = $updater->run(false);

				if ($result['status'] === 'updated') {
					// Render with the new code: reload once.
					$this->response->redirect(str_replace('&amp;', '&', $this->url->link($this->wyRoute(), $token . '&updated=1')));

					return;
				}
			}
		}

		$key = LocalKey::load(DIR_STORAGE);
		$updater = new Updater($db, $settings, $this->wyPlatform());
		$state = $updater->state();

		$data = [
			't'          => $t,
			'lang'       => $lang,
			'dir'        => I18n::direction($lang),
			'font'       => I18n::font($lang),
			'csrf'       => $this->wyCsrf(),
			'save'       => $this->url->link($this->wyMethod('save'), $token),
			'connect'    => $this->url->link($this->wyMethod('connect'), $token),
			'disconnect' => $this->url->link($this->wyMethod('disconnect'), $token),
			'test'       => $this->url->link($this->wyMethod('test'), $token),
			'update'     => $this->url->link($this->wyMethod('update'), $token),
			'back'       => $this->url->link($this->wyExtensionsRoute(), $token . '&type=module'),
			'dashboard'  => Endpoints::app(),
			'supported'  => $supported,
			'text_unsupported' => sprintf($t['text_unsupported'], VERSION),
			'key_ok'     => $key !== null,
			'version'    => Protocol::CONNECTOR_VERSION,
			'oc_version' => VERSION,
			'updated'    => !empty($this->request->get['updated']),
			'status'     => (int)$this->config->get('module_webyar_status'),
			'orders'     => $this->wyToggle('orders'),
			'reviews'    => $this->wyToggle('reviews'),
			'auto_update' => $this->wyToggle('auto_update'),
			'customer_scope' => (string)($this->config->get('module_webyar_customer_scope') ?: 'installation'),
			'update_supported' => Updater::supported(),
			'update_checked_at' => !empty($state['checked_at']) ? date('Y-m-d H:i', (int)$state['checked_at']) : '',
			'update_status' => (string)($state['status'] ?? ''),
			'stores'     => [],
		];

		$connectedCount = 0;
		$widgetCount = 0;

		foreach ($this->wyStores() as $store) {
			$record = $settings->get($store['store_id'], 'conn');
			$connected = is_array($record) && (int)($record['store_id'] ?? -1) === $store['store_id'] && $key !== null && Connection::fromRecord($record, $key) !== null;
			$widget = (int)$settings->get($store['store_id'], 'widget', 0);
			$connectedCount += $connected ? 1 : 0;
			$widgetCount += ($connected && $widget) ? 1 : 0;
			$data['stores'][] = $store + [
				'connected'    => $connected,
				'https'        => stripos($store['url'], 'https://') === 0,
				'host'         => (string)parse_url($store['url'], PHP_URL_HOST),
				'workspace_id' => $connected ? (string)$record['workspace_id'] : '',
				'paired_at'    => $connected ? (string)$record['paired_at'] : '',
				'widget'       => $widget,
			];
		}

		$data['connected_count'] = $connectedCount;
		$data['store_count'] = count($data['stores']);
		$data['widget_count'] = $widgetCount;
		$data['header'] = $this->load->controller('common/header');
		$data['column_left'] = $this->load->controller('common/column_left');
		$data['footer'] = $this->load->controller('common/footer');

		$this->response->setOutput($this->load->view($this->wyView(), $data));
	}

	public function save(): void {
		$t = I18n::strings($this->wyLanguage());
		$json = $this->wyGuard($t);

		if (!$json) {
			$post = $this->request->post;
			$settings = new Settings(new Db($this->db, DB_PREFIX));
			$settings->set(0, 'status', !empty($post['module_webyar_status']) ? '1' : '0');
			$settings->set(0, 'orders', !empty($post['module_webyar_orders']) ? '1' : '0');
			$settings->set(0, 'reviews', !empty($post['module_webyar_reviews']) ? '1' : '0');
			$settings->set(0, 'auto_update', !empty($post['module_webyar_auto_update']) ? '1' : '0');
			$settings->set(0, 'customer_scope', ($post['module_webyar_customer_scope'] ?? '') === 'registration_store' ? 'registration_store' : 'installation');

			foreach ($this->wyStores() as $store) {
				// Written on EVERY store row: store 0's value would otherwise
				// leak into stores that have none of their own.
				$settings->set($store['store_id'], 'widget', !empty($post['widget'][$store['store_id']]) ? '1' : '0');
			}

			$json['success'] = $t['text_success'];
		}

		$this->wyJson($json);
	}

	public function connect(): void {
		$lang = $this->wyLanguage();
		$t = I18n::strings($lang);
		$json = $this->wyGuard($t);
		$store = $this->wyStoreFromPost();

		if (!$json && !$store) {
			$json['error'] = $t['error_store'];
		}

		if (!$json) {
			if (stripos($store['url'], 'https://') !== 0) {
				$json['error'] = $t['error_https'];
			} else {
				try {
					$key = LocalKey::load(DIR_STORAGE, true);

					if ($key === null) {
						throw new \RuntimeException($t['error_storage']);
					}

					$return = str_replace('&amp;', '&', $this->url->link($this->wyRoute(), 'user_token=' . $this->session->data['user_token']));
					$pairing = new Pairing(new Settings(new Db($this->db, DB_PREFIX)), $key);
					$json['redirect'] = $pairing->start($store['store_id'], $store['url'], $this->wyCallbackUrl($store['url']), VERSION, $return, $lang);
				} catch (\Throwable $e) {
					$json['error'] = sprintf($t['error_connect'], htmlspecialchars($e->getMessage(), ENT_QUOTES, 'UTF-8'));
				}
			}
		}

		$this->wyJson($json);
	}

	public function disconnect(): void {
		$t = I18n::strings($this->wyLanguage());
		$json = $this->wyGuard($t);
		$store = $this->wyStoreFromPost();

		if (!$json && !$store) {
			$json['error'] = $t['error_store'];
		}

		if (!$json) {
			$key = LocalKey::load(DIR_STORAGE);
			$settings = new Settings(new Db($this->db, DB_PREFIX));

			if ($key !== null) {
				(new Pairing($settings, $key))->disconnect($store['store_id']);
			} else {
				$settings->delete($store['store_id'], 'conn');
			}

			$json['success'] = $t['text_disconnected'];
			$json['redirect'] = str_replace('&amp;', '&', $this->url->link($this->wyRoute(), 'user_token=' . $this->session->data['user_token']));
		}

		$this->wyJson($json);
	}

	public function test(): void {
		$t = I18n::strings($this->wyLanguage());
		$json = $this->wyGuard($t);
		$store = $this->wyStoreFromPost();

		if (!$json && !$store) {
			$json['error'] = $t['error_store'];
		}

		if (!$json) {
			// Throttled locally too: at most one check every 30 s per admin session.
			$last = (int)($this->session->data['webyar_test_at'] ?? 0);

			if ($last > time() - 30) {
				$json['error'] = $t['error_test_throttled'];
			} else {
				$this->session->data['webyar_test_at'] = time();
				$key = LocalKey::load(DIR_STORAGE);
				$record = (new Settings(new Db($this->db, DB_PREFIX)))->get($store['store_id'], 'conn');
				$conn = ($key !== null && is_array($record)) ? Connection::fromRecord($record, $key) : null;

				if (!$conn) {
					$json['error'] = $t['error_not_connected'];
				} else {
					try {
						$result = Pairing::signedAction($conn, 'test');
						$json[$result['status'] === 200 ? 'success' : 'error'] = $result['status'] === 200
							? $t['text_test_ok']
							: sprintf($t['error_test'], (string)($result['json']['error'] ?? $result['status']));
					} catch (\Throwable $e) {
						$json['error'] = sprintf($t['error_test'], htmlspecialchars($e->getMessage(), ENT_QUOTES, 'UTF-8'));
					}
				}
			}
		}

		$this->wyJson($json);
	}

	/** "Check for updates": same signed-release rules as the automatic path. */
	public function update(): void {
		$t = I18n::strings($this->wyLanguage());
		$json = $this->wyGuard($t);

		if (!$json) {
			$result = (new Updater(new Db($this->db, DB_PREFIX), new Settings(new Db($this->db, DB_PREFIX)), $this->wyPlatform()))->run(true);

			if ($result['status'] === 'updated') {
				$json['success'] = sprintf($t['text_updated'], (string)$result['to']);
				$json['redirect'] = str_replace('&amp;', '&', $this->url->link($this->wyRoute(), 'user_token=' . $this->session->data['user_token'] . '&updated=1'));
			} elseif ($result['status'] === 'up_to_date') {
				$json['success'] = $t['text_up_to_date'];
			} elseif ($result['status'] === 'unsupported') {
				$json['error'] = $t['text_update_unsupported'];
			} elseif ($result['status'] === 'busy') {
				$json['error'] = $t['text_update_busy'];
			} else {
				$json['error'] = sprintf($t['error_update'], htmlspecialchars((string)($result['error'] ?? 'unknown'), ENT_QUOTES, 'UTF-8'));
			}
		}

		$this->wyJson($json);
	}

	public function install(): void {
		// Called by the core's module installer after IT checked the user may
		// modify modules; this request's user object predates the permission
		// the core just granted on our own route, so that one is not checked.
		if (!$this->wySupported() || !$this->user->hasPermission('modify', $this->wyModulesRoute())) {
			return;
		}

		$this->wyInstallSteps();
		$settings = new Settings(new Db($this->db, DB_PREFIX));

		if ($settings->get(0, 'status') === null) {
			foreach (['status', 'orders', 'reviews', 'auto_update'] as $name) {
				$settings->set(0, $name, '1');
			}
		}
	}

	public function uninstall(): void {
		if (!$this->user->hasPermission('modify', $this->wyModulesRoute())) {
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

		$this->wyDeleteEvent();
		// Only rows, tables and files this extension created.
		$settings->deleteAll();
		(new Schema($db, DB_DATABASE))->uninstall();
		LocalKey::remove(DIR_STORAGE);
	}

	// ── shared internals ───────────────────────────────────────────────

	private function wyLanguage(): string {
		// The admin's own language when the extension speaks it, otherwise the
		// store's default language, otherwise English.
		return I18n::pick((string)$this->config->get($this->wyAdminLanguageKey()), (string)$this->wyStoreLanguage());
	}

	private function wyInstallSteps(): void {
		$db = new Db($this->db, DB_PREFIX);
		$schema = new Schema($db, DB_DATABASE);
		$schema->install();
		$settings = new Settings($db);
		$settings->set(0, 'schema', $schema->detect(VERSION) + ['connector' => Protocol::CONNECTOR_VERSION]);
		// The Web Yar address is part of the package now; older versions
		// stored an editable copy.
		$settings->delete(0, 'app_url');
		$settings->delete(0, 'api_url');

		if ($settings->get(0, 'auto_update') === null && $settings->get(0, 'status') !== null) {
			$settings->set(0, 'auto_update', '1');
		}

		LocalKey::load(DIR_STORAGE, true);
		// Delete-then-add: re-running install never leaves two widget events.
		$this->wyDeleteEvent();
		$this->wyAddEvent();
	}

	private function wyUpgradeIfNeeded(): void {
		$schema = $this->config->get('module_webyar_schema');

		if (!is_array($schema) || ($schema['version'] ?? '') !== VERSION || ($schema['connector'] ?? '') !== Protocol::CONNECTOR_VERSION) {
			$this->wyInstallSteps();
		}
	}

	private function wyToggle(string $name): int {
		$value = $this->config->get('module_webyar_' . $name);

		return ($value === null || $value === '') ? 1 : (int)$value;
	}

	/** @return array<int,array{store_id:int,name:string,url:string}> */
	private function wyStores(): array {
		$stores = [['store_id' => 0, 'name' => (string)$this->config->get('config_name'), 'url' => rtrim(HTTP_CATALOG, '/') . '/']];
		$this->load->model('setting/store');

		foreach ($this->model_setting_store->getStores() as $store) {
			$stores[] = ['store_id' => (int)$store['store_id'], 'name' => (string)$store['name'], 'url' => rtrim((string)$store['url'], '/') . '/'];
		}

		return $stores;
	}

	private function wyStoreFromPost(): ?array {
		$id = (int)($this->request->post['store_id'] ?? -1);

		foreach ($this->wyStores() as $store) {
			if ($store['store_id'] === $id) {
				return $store;
			}
		}

		return null;
	}

	private function wyCsrf(): string {
		if (empty($this->session->data['webyar_csrf'])) {
			$this->session->data['webyar_csrf'] = bin2hex(random_bytes(16));
		}

		return $this->session->data['webyar_csrf'];
	}

	/**
	 * @param array<string,string> $t
	 * @return array<string,string> empty when the request may proceed
	 */
	private function wyGuard(array $t): array {
		if (!$this->user->hasPermission('modify', $this->wyRoute())) {
			return ['error' => $t['error_permission']];
		}

		if (($this->request->server['REQUEST_METHOD'] ?? '') !== 'POST' || empty($this->session->data['webyar_csrf']) || !hash_equals((string)$this->session->data['webyar_csrf'], (string)($this->request->post['webyar_csrf'] ?? ''))) {
			return ['error' => $t['error_csrf']];
		}

		if (!$this->wySupported()) {
			return ['error' => sprintf($t['text_unsupported'], VERSION)];
		}

		return [];
	}

	private function wyJson(array $json): void {
		$this->response->addHeader('Content-Type: application/json');
		$this->response->setOutput((string)json_encode($json));
	}

	// ── hooks each OpenCart version implements ─────────────────────────

	abstract protected function wyRoute(): string;

	abstract protected function wyMethod(string $method): string;

	abstract protected function wyView(): string;

	abstract protected function wyExtensionsRoute(): string;

	/** The route whose modify permission installing/uninstalling modules requires. */
	abstract protected function wyModulesRoute(): string;

	abstract protected function wySupported(): bool;

	abstract protected function wyAdminLanguageKey(): string;

	abstract protected function wyStoreLanguage(): string;

	abstract protected function wyCallbackUrl(string $storeUrl): string;

	abstract protected function wyPlatform(): Platform;

	abstract protected function wyAddEvent(): void;

	abstract protected function wyDeleteEvent(): void;
}
