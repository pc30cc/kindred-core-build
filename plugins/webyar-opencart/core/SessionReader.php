<?php
namespace WebYar\OpenCart;

/**
 * Reads an OpenCart storefront session READ-ONLY, the same way OpenCart's own
 * session adapter reads it, without starting, extending or rewriting it.
 *
 * Used at private-query time to answer one question cheaply: is the shopper
 * who was signed in when the widget asked for an identity assertion STILL the
 * signed-in customer of that browser session? Logout (customer_id removed),
 * expiry (row gone / expire passed) and a different customer signing in on
 * the same browser all answer "no". One primary-key lookup.
 *
 * Supports OpenCart's two core engines, `db` (the catalog default in 3.0.x
 * and 4.1.x) and `file`. A store configured with anything else gets
 * `session_engine_unsupported` and private data is refused — never guessed.
 */
final class SessionReader {
	private Db $db;
	private Platform $platform;

	public function __construct(Db $db, Platform $platform) {
		$this->db = $db;
		$this->platform = $platform;
	}

	/** @return array<string,mixed>|null null = no live session; throws for an unsupported engine */
	public function read(string $sessionId): ?array {
		if (!preg_match('/^[a-zA-Z0-9,\-]{22,52}$/', $sessionId)) {
			return null;
		}

		$engine = (string)($this->platform->config('session_engine') ?: 'db');

		if ($engine === 'db') {
			$row = $this->db->row('SELECT `data` FROM ' . $this->db->t('session') . ' WHERE `session_id` = ' . $this->db->str($sessionId) . ' AND `expire` > ' . $this->db->str(gmdate('Y-m-d H:i:s')) . ' LIMIT 1');

			if (!$row) {
				return null;
			}

			$data = json_decode((string)$row['data'], true);

			return is_array($data) ? $data : null;
		}

		if ($engine === 'file') {
			$file = rtrim($this->platform->sessionDir(), '/\\') . '/sess_' . basename($sessionId);

			if (!is_file($file)) {
				return null;
			}

			$lifetime = (int)($this->platform->config('session_expire') ?: 86400);

			if (filemtime($file) + $lifetime < time()) {
				return null;
			}

			$data = json_decode((string)file_get_contents($file), true);

			return is_array($data) ? $data : null;
		}

		throw new ApiError('session_engine_unsupported', 409);
	}
}
