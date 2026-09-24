<?php
namespace WebYar\OpenCart;

/**
 * One store's pairing with one Web Yar workspace.
 *
 * Stored on THAT store's settings row. The installation secret is encrypted
 * with the store-local key (LocalKey) and bound to the installation id as
 * AEAD associated data, so a secret copied onto another record does not
 * decrypt.
 */
final class Connection {
	public int $storeId;
	public string $installationId;
	public string $connectionId;
	public string $workspaceId;
	public string $storeUrl;
	public string $appBase;
	public string $apiBase;
	public string $pairedAt;
	private string $secret;

	private function __construct() {
	}

	public static function fromRecord(array $record, string $localKey): ?self {
		if (empty($record['installation_id']) || empty($record['secret_enc']) || !isset($record['store_id'])) {
			return null;
		}

		$secret = Crypto::decrypt($localKey, (string)$record['secret_enc'], (string)$record['installation_id']);

		if ($secret === null || $secret === '') {
			return null;
		}

		$c = new self();
		$c->storeId = (int)$record['store_id'];
		$c->installationId = (string)$record['installation_id'];
		$c->connectionId = (string)($record['connection_id'] ?? '');
		$c->workspaceId = (string)($record['workspace_id'] ?? '');
		$c->storeUrl = (string)($record['store_url'] ?? '');
		$c->appBase = rtrim((string)($record['app_base'] ?? ''), '/');
		$c->apiBase = rtrim((string)($record['api_base'] ?? ''), '/');
		$c->pairedAt = (string)($record['paired_at'] ?? '');
		$c->secret = $secret;

		return $c;
	}

	/** @return array<string,mixed> */
	public static function toRecord(int $storeId, array $exchange, string $secret, string $localKey, string $storeUrl, string $appBase, string $apiBase): array {
		return [
			'store_id'        => $storeId,
			'installation_id' => (string)$exchange['installationId'],
			'connection_id'   => (string)($exchange['connectionId'] ?? ''),
			'workspace_id'    => (string)($exchange['workspaceId'] ?? ''),
			'secret_enc'      => Crypto::encrypt($localKey, $secret, (string)$exchange['installationId']),
			'store_url'       => $storeUrl,
			'app_base'        => rtrim($appBase, '/'),
			'api_base'        => rtrim($apiBase, '/'),
			'paired_at'       => gmdate('c'),
		];
	}

	public function secret(): string {
		return $this->secret;
	}
}
