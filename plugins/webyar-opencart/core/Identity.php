<?php
namespace WebYar\OpenCart;

/**
 * Customer identity for the widget.
 *
 * INTRODUCTION (browser, once per widget open): the storefront session of a
 * signed-in customer gets a short-lived assertion — HMAC-signed with the
 * installation secret, audience-bound, single-use by nonce — that Web Yar
 * verifies and binds to the widget visitor. It carries an opaque
 * `session_ref`: the OpenCart session id encrypted with the STORE-LOCAL key,
 * which Web Yar can store and send back but can neither read nor use as a
 * cookie.
 *
 * CONTINUED ACCESS (server-to-server, every private query): Web Yar sends the
 * customer id and session_ref back; this class decrypts the ref, reads that
 * session read-only and requires it to still be alive and still belong to
 * the same customer, whose account must still be enabled. A long-lived link
 * on Web Yar's side is therefore never, by itself, permission to read an
 * order: logout, session expiry, a different customer in the same browser,
 * a disabled account, a reconnect (new installation id = ref AAD mismatch) or
 * another store all fail here.
 */
final class Identity {
	private Db $db;
	private Platform $platform;
	private string $localKey;

	public function __construct(Db $db, Platform $platform, string $localKey) {
		$this->db = $db;
		$this->platform = $platform;
		$this->localKey = $localKey;
	}

	/**
	 * @param array<string,mixed> $sessionData the CURRENT request's session
	 * @return array{assertion:?string,signed_in:bool}
	 */
	public function assertionFor(Connection $conn, string $sessionId, array $sessionData): array {
		$customerId = (int)($sessionData['customer_id'] ?? 0);

		if ($customerId <= 0) {
			return ['assertion' => null, 'signed_in' => false];
		}

		$customer = $this->db->row('SELECT `customer_id`, `customer_group_id`, `store_id`, `firstname`, `lastname`, `email`, `status` FROM ' . $this->db->t('customer') . ' WHERE `customer_id` = ' . $customerId . ' LIMIT 1');

		if (!$customer || (int)$customer['status'] !== 1 || !$this->inScope($customer, $conn->storeId)) {
			return ['assertion' => null, 'signed_in' => false];
		}

		$now = time();
		$payload = [
			'installation_id'      => $conn->installationId,
			'external_customer_id' => (string)$customerId,
			'store_id'             => (string)$conn->storeId,
			'customer_group_id'    => (string)(int)$customer['customer_group_id'],
			'session_ref'          => $this->sessionRef($conn, $sessionId, $customerId, $now),
			// Only what files the conversation under the right person.
			'email'                => (string)$customer['email'],
			'name'                 => trim($customer['firstname'] . ' ' . $customer['lastname']),
			'language'             => (string)($sessionData['language'] ?? ''),
			'currency'             => (string)($sessionData['currency'] ?? ''),
			'issued_at'            => $now,
			'expires_at'           => $now + Protocol::ASSERTION_TTL,
			'nonce'                => Crypto::random(12),
			'audience'             => Protocol::AUDIENCE,
			'provider'             => 'opencart',
		];

		$encoded = Crypto::base64url((string)json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

		return ['assertion' => $encoded . '.' . Crypto::hmac($conn->secret(), $encoded), 'signed_in' => true];
	}

	/**
	 * Re-validates a customer reference sent by Web Yar for a private read.
	 *
	 * @param array<string,mixed> $ref {id, session_ref}
	 * @return array{customer_id:int,customer_group_id:int,session:array<string,mixed>}
	 */
	public function verifyCustomer(Connection $conn, $ref): array {
		if (!is_array($ref) || !isset($ref['id'], $ref['session_ref'])) {
			throw new ApiError('identity_required', 401);
		}

		$claimed = (int)$ref['id'];
		$raw = Crypto::decrypt($this->localKey, (string)$ref['session_ref'], $conn->installationId);
		$decoded = $raw === null ? null : json_decode($raw, true);

		if (!is_array($decoded) || (int)($decoded['cid'] ?? 0) !== $claimed || (int)($decoded['sto'] ?? -1) !== $conn->storeId || $claimed <= 0) {
			throw new ApiError('identity_invalid', 401);
		}

		// A reference never outlives OpenCart's own maximum session lifetime.
		if ((int)($decoded['iat'] ?? 0) < time() - max(86400, (int)$this->platform->config('session_expire')) * 30) {
			throw new ApiError('identity_expired', 401);
		}

		$session = (new SessionReader($this->db, $this->platform))->read((string)$decoded['sid']);

		if ($session === null || (int)($session['customer_id'] ?? 0) !== $claimed) {
			throw new ApiError('identity_session_ended', 401);
		}

		$customer = $this->db->row('SELECT `customer_id`, `customer_group_id`, `store_id`, `status` FROM ' . $this->db->t('customer') . ' WHERE `customer_id` = ' . $claimed . ' LIMIT 1');

		if (!$customer || (int)$customer['status'] !== 1) {
			throw new ApiError('account_disabled', 403);
		}

		if (!$this->inScope($customer, $conn->storeId)) {
			throw new ApiError('customer_out_of_store_scope', 403);
		}

		return ['customer_id' => $claimed, 'customer_group_id' => (int)$customer['customer_group_id'], 'session' => $session];
	}

	/**
	 * OpenCart core shares customer accounts across all stores of one
	 * installation (there is no core setting to restrict it); `customer.store_id`
	 * only records where the account was created. The merchant can narrow this
	 * with the extension's own "customer scope" setting.
	 */
	private function inScope(array $customer, int $storeId): bool {
		$scope = (string)($this->platform->config('module_webyar_customer_scope') ?: 'installation');

		return $scope !== 'registration_store' || (int)$customer['store_id'] === $storeId;
	}

	private function sessionRef(Connection $conn, string $sessionId, int $customerId, int $now): string {
		return Crypto::encrypt($this->localKey, (string)json_encode(['sid' => $sessionId, 'cid' => $customerId, 'sto' => $conn->storeId, 'iat' => $now]), $conn->installationId);
	}
}
