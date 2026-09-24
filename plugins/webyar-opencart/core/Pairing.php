<?php
namespace WebYar\OpenCart;

/**
 * Connect / disconnect, reusing Web Yar's authorization-code + PKCE pairing
 * (docs/commerce/SECURITY.md §Pairing) unchanged.
 *
 * The PKCE verifier never leaves the store: it is kept encrypted with the
 * store-local key in a short-lived pending record, and the browser only ever
 * carries `state` and the single-use `code`. The callback is a CATALOG route
 * on the connected store's own origin (Web Yar requires the redirect origin
 * to equal the store origin), so the admin's user_token never travels to or
 * is stored by Web Yar.
 */
final class Pairing {
	private const TTL = 600;
	private const MAX_PENDING = 5;

	private Settings $settings;
	private string $localKey;

	public function __construct(Settings $settings, string $localKey) {
		$this->settings = $settings;
		$this->localKey = $localKey;
	}

	/** @return string the Web Yar authorize URL to send the admin to */
	public function start(int $storeId, string $storeUrl, string $callbackUrl, string $appBase, string $apiBase): string {
		$appBase = rtrim($appBase, '/');
		$apiBase = rtrim($apiBase ?: $appBase, '/');

		if (!Http::allowedUrl($appBase) || !Http::allowedUrl($apiBase)) {
			throw new \RuntimeException('invalid_webyar_url');
		}

		$state = Crypto::base64url(random_bytes(24));
		$verifier = Crypto::base64url(random_bytes(48));
		$challenge = Crypto::base64url(hash('sha256', $verifier, true));
		$origin = self::origin($storeUrl);

		$response = Http::postJson($apiBase . '/api/commerce/pairing/register', (string)json_encode([
			'state'           => $state,
			'codeChallenge'   => $challenge,
			'redirectUri'     => $callbackUrl,
			'storeOrigin'     => $origin,
			'provider'        => 'opencart',
			'externalStoreId' => (string)$storeId,
			'storeUrl'        => $storeUrl,
		], JSON_UNESCAPED_SLASHES));

		if ($response['status'] !== 200) {
			throw new \RuntimeException((string)($response['json']['error'] ?? 'register_failed'));
		}

		$pending = $this->pending();
		$pending[$state] = [
			'store_id'     => $storeId,
			'verifier_enc' => Crypto::encrypt($this->localKey, $verifier, $state),
			'expires'      => time() + self::TTL,
			'store_url'    => $storeUrl,
			'app_base'     => $appBase,
			'api_base'     => $apiBase,
		];
		$this->savePending(array_slice($pending, -self::MAX_PENDING, null, true));

		return $appBase . '/commerce/authorize?state=' . rawurlencode($state);
	}

	/** Completes the pairing; returns the store id that is now connected. */
	public function complete(string $state, string $code, int $servingStoreId): int {
		$pending = $this->pending();
		$record = $pending[$state] ?? null;

		// Single use, whatever happens next.
		unset($pending[$state]);
		$this->savePending($pending);

		if (!$record || (int)$record['expires'] < time()) {
			throw new \RuntimeException('pairing_expired');
		}

		if ((int)$record['store_id'] !== $servingStoreId) {
			// The callback must land on the store that asked to be paired.
			throw new \RuntimeException('store_mismatch');
		}

		$verifier = Crypto::decrypt($this->localKey, (string)$record['verifier_enc'], $state);

		if ($verifier === null) {
			throw new \RuntimeException('pairing_expired');
		}

		$response = Http::postJson($record['api_base'] . '/api/commerce/pairing/exchange', (string)json_encode(['state' => $state, 'code' => $code, 'codeVerifier' => $verifier]));
		$json = $response['json'] ?? [];

		if ($response['status'] !== 200 || empty($json['installationId']) || empty($json['installationSecret'])) {
			throw new \RuntimeException((string)($json['error'] ?? 'exchange_failed'));
		}

		$this->settings->set((int)$record['store_id'], 'conn', Connection::toRecord((int)$record['store_id'], $json, (string)$json['installationSecret'], $this->localKey, (string)$record['store_url'], (string)$record['app_base'], (string)$record['api_base']));

		return (int)$record['store_id'];
	}

	/** Tells Web Yar (best effort) and forgets the credential locally regardless. */
	public function disconnect(int $storeId): void {
		$record = $this->settings->get($storeId, 'conn');
		$conn = is_array($record) ? Connection::fromRecord($record, $this->localKey) : null;

		if ($conn) {
			try {
				self::signedAction($conn, 'disconnect');
			} catch (\Throwable $e) {
				// Local removal still happens; Web Yar marks the store offline.
			}
		}

		$this->settings->delete($storeId, 'conn');
	}

	/** @return array{status:int,json:?array} */
	public static function signedAction(Connection $conn, string $action): array {
		$path = '/api/commerce/connection/' . $action;

		return Http::postJson($conn->apiBase . $path, '', Signer::headers($conn->secret(), $conn->installationId, 'POST', $path, ''), 15);
	}

	public static function origin(string $url): string {
		$p = parse_url($url);

		return strtolower(($p['scheme'] ?? 'https') . '://' . ($p['host'] ?? '')) . (isset($p['port']) ? ':' . $p['port'] : '');
	}

	private function pending(): array {
		$now = time();
		$all = $this->settings->get(0, 'pairing', []);

		return array_filter(is_array($all) ? $all : [], fn ($r) => is_array($r) && (int)($r['expires'] ?? 0) >= $now);
	}

	private function savePending(array $pending): void {
		$pending ? $this->settings->set(0, 'pairing', $pending) : $this->settings->delete(0, 'pairing');
	}
}
