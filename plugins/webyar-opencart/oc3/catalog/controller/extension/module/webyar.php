<?php
require_once DIR_SYSTEM . 'library/webyar/autoload.php';

use WebYar\OpenCart\Api;
use WebYar\OpenCart\Connection;
use WebYar\OpenCart\Db;
use WebYar\OpenCart\Identity;
use WebYar\OpenCart\LocalKey;
use WebYar\OpenCart\Oc3Platform;
use WebYar\OpenCart\Pairing;
use WebYar\OpenCart\Settings;
use WebYar\OpenCart\Widget;

/**
 * Web Yar — storefront side (OpenCart 3.0.5.x).
 *
 *   injectWidget  event on catalog/view/common/footer/after — no DB, no network
 *   api           the signed machine endpoint Web Yar calls (POST only)
 *   context       same-origin, never cached; called by the loader on chat open
 *   callback      pairing return (state + single-use code)
 *   order         "view this order" link target for the signed-in owner
 */
class ControllerExtensionModuleWebyar extends Controller {
	public function injectWidget(&$route, &$args, &$output) {
		// Everything read here is already in the store's config: zero queries.
		if (!$this->config->get('module_webyar_status') || !$this->config->get('module_webyar_widget')) {
			return;
		}

		$record = $this->config->get('module_webyar_conn');
		$storeId = (int)$this->config->get('config_store_id');

		// OpenCart merges store 0's settings into every store: a connection
		// belongs to exactly the store it was made for.
		if (!is_array($record) || (int)($record['store_id'] ?? -1) !== $storeId || empty($record['workspace_id'])) {
			return;
		}

		// Built by hand, not through url->link(): the SEO rewriter would look
		// the route up in seo_url — queries on every page view for a link no
		// visitor ever sees.
		$contextUrl = rtrim((string)($this->config->get('config_secure') && $this->config->get('config_ssl') ? $this->config->get('config_ssl') : $this->config->get('config_url')), '/') . '/index.php?route=extension/module/webyar/context';
		$output = Widget::inject($output, Widget::snippet($record, $contextUrl));
	}

	public function api(): void {
		$db = new Db($this->db, DB_PREFIX);
		$key = LocalKey::load(DIR_STORAGE);
		$headers = [];

		foreach ($_SERVER as $name => $value) {
			if (strncmp($name, 'HTTP_X_WEBYAR_', 14) === 0) {
				$headers[strtolower(str_replace('_', '-', substr($name, 5)))] = (string)$value;
			}
		}

		if ($key === null) {
			$result = ['status' => 503, 'body' => ['error' => 'extension_not_installed']];
		} else {
			$api = new Api($db, $this->platform(), new Settings($db), $key, (array)($this->config->get('module_webyar_schema') ?: []));
			$result = $api->handle((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'), (string)($this->request->get['op'] ?? ''), $headers, (string)file_get_contents('php://input'));
		}

		$this->suppressSessionWrite();
		$this->json($result['body'], $result['status']);
	}

	public function context(): void {
		$this->response->addHeader('Cache-Control: no-store, private, max-age=0');
		$this->response->addHeader('Vary: Cookie');

		$data = $this->session->data;

		if (!Widget::allowContextRequest($data, time())) {
			$this->session->data['webyar_ctx'] = $data['webyar_ctx'];
			$this->json(['error' => 'rate_limited'], 429);

			return;
		}

		$this->session->data['webyar_ctx'] = $data['webyar_ctx'];

		// Same-origin only: a cross-site page cannot read this response
		// (no CORS headers are ever sent), and a browser that says the call
		// is cross-site is refused outright.
		$site = (string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '');

		if ($site !== '' && $site !== 'same-origin') {
			$this->json(['error' => 'cross_site'], 403);

			return;
		}

		$record = $this->config->get('module_webyar_conn');
		$storeId = (int)$this->config->get('config_store_id');
		$conn = (is_array($record) && (int)($record['store_id'] ?? -1) === $storeId) ? $this->connectionFromRecord($record) : null;

		if (!$conn || !$this->config->get('module_webyar_status')) {
			$this->json(['assertion' => null, 'signed_in' => false]);

			return;
		}

		$key = LocalKey::load(DIR_STORAGE);
		$identity = new Identity(new Db($this->db, DB_PREFIX), $this->platform(), (string)$key);
		$this->json($identity->assertionFor($conn, $this->session->getId(), $this->session->data));
	}

	public function callback(): void {
		$this->load->language('extension/module/webyar');
		$key = LocalKey::load(DIR_STORAGE);
		$ok = false;

		try {
			if ($key === null) {
				throw new \RuntimeException('extension_not_installed');
			}

			$db = new Db($this->db, DB_PREFIX);
			(new Pairing(new Settings($db), $key))->complete((string)($this->request->get['state'] ?? ''), (string)($this->request->get['code'] ?? ''), (int)$this->config->get('config_store_id'));
			$ok = true;
			$message = $this->language->get('text_callback_success');
		} catch (\Throwable $e) {
			$message = $this->language->get('text_callback_failed') . ' (' . preg_replace('/[^a-z0-9_]/', '', strtolower($e->getMessage())) . ')';
		}

		$this->response->addHeader('Cache-Control: no-store');
		$this->response->addHeader('Content-Type: text/html; charset=utf-8');
		$this->response->setOutput('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Web Yar</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">' . ($ok ? '✓ ' : '✕ ') . htmlspecialchars($message, ENT_QUOTES, 'UTF-8') . '</h1><p>' . htmlspecialchars($this->language->get('text_callback_return'), ENT_QUOTES, 'UTF-8') . '</p></body>');
	}

	public function order(): void {
		$orderId = (int)($this->request->get['order_id'] ?? 0);

		if (!$this->customer->isLogged()) {
			$this->session->data['redirect'] = $this->url->link('account/order', '', true);
			$this->response->redirect($this->url->link('account/login', '', true));

			return;
		}

		// account/order/info itself checks that the order is this customer's.
		$this->response->redirect($orderId > 0 ? $this->url->link('account/order/info', 'order_id=' . $orderId, true) : $this->url->link('account/order', '', true));
	}

	private function platform(): Oc3Platform {
		return new Oc3Platform($this->registry);
	}

	private function connectionFromRecord(array $record): ?Connection {
		$key = LocalKey::load(DIR_STORAGE);

		return $key === null ? null : Connection::fromRecord($record, $key);
	}

	private function json(array $body, int $status = 200): void {
		if ($status !== 200) {
			$this->response->addHeader(($_SERVER['SERVER_PROTOCOL'] ?? 'HTTP/1.1') . ' ' . $status . ' ' . ($status >= 500 ? 'Error' : 'Refused'));
		}

		$this->response->addHeader('Content-Type: application/json; charset=utf-8');
		$this->response->addHeader('X-Content-Type-Options: nosniff');
		$this->response->addHeader('Cache-Control: no-store');
		$this->response->setOutput((string)json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
	}

	/**
	 * A machine call carries no cookie, so OpenCart opened a brand-new session
	 * for it and would write that empty row on shutdown — one junk INSERT per
	 * Web Yar call. The session is not used for anything here; blanking its id
	 * makes the core's own write() skip (`if ($session_id)`).
	 */
	private function suppressSessionWrite(): void {
		try {
			$property = new \ReflectionProperty($this->session, 'session_id');
			$property->setAccessible(true);
			$property->setValue($this->session, '');
		} catch (\Throwable $e) {
			// Worst case the store's own session GC removes the row.
		}
	}
}
