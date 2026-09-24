<?php
namespace WebYar\OpenCart;

/**
 * Nonce replay protection for signed requests from Web Yar.
 *
 * One row per ACCEPTED signed request in the extension's own table
 * (`<prefix>webyar_nonce`); the primary key makes "seen before" atomic, so two
 * concurrent copies of the same request cannot both pass. OpenCart's file
 * cache could not give that guarantee.
 *
 * Only reached after the HMAC has verified, so an anonymous caller cannot
 * make the store write anything. Pruning is opportunistic and bounded: about
 * one request in fifty deletes rows older than twice the clock-skew window
 * (they can never validate again).
 */
final class ReplayGuard {
	private Db $db;

	public function __construct(Db $db) {
		$this->db = $db;
	}

	public function claim(string $installationId, string $nonce): bool {
		$key = hash('sha256', $installationId . '|' . $nonce);

		try {
			// INSERT IGNORE + affected rows rather than catching a duplicate-key
			// error: OpenCart 3's mysqli driver prints a PHP warning into the
			// response on a failed query instead of only throwing.
			$this->db->exec('INSERT IGNORE INTO ' . $this->db->t('webyar_nonce') . ' SET `nonce_hash` = ' . $this->db->str($key) . ', `created_at` = ' . time());

			if ($this->db->affected() !== 1) {
				return false; // seen before: a replay
			}
		} catch (\Throwable $e) {
			return false; // any other failure fails closed
		}

		if (random_int(1, 50) === 1) {
			$this->prune();
		}

		return true;
	}

	public function prune(): void {
		try {
			$this->db->exec('DELETE FROM ' . $this->db->t('webyar_nonce') . ' WHERE `created_at` < ' . (time() - Protocol::CLOCK_SKEW_SECONDS * 2) . ' LIMIT 500');
		} catch (\Throwable $e) {
			// best effort
		}
	}
}
