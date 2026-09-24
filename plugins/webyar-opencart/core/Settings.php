<?php
namespace WebYar\OpenCart;

/**
 * Extension settings in OpenCart's own `setting` table under the code
 * `module_webyar` — the table and columns are identical in 3.0.x and 4.1.x,
 * so neither version's model API (editSetting vs editValue) is needed.
 *
 * Per-store values live on that store's row. OpenCart merges store 0 into
 * every store's config, so a connection record always carries its own
 * store_id and every reader compares it with the store being served.
 */
final class Settings {
	public const CODE = 'module_webyar';

	private Db $db;

	public function __construct(Db $db) {
		$this->db = $db;
	}

	/** @return mixed */
	public function get(int $storeId, string $key, $default = null) {
		$row = $this->db->row('SELECT `value`, `serialized` FROM ' . $this->db->t('setting') . ' WHERE `store_id` = ' . $storeId . ' AND `code` = ' . $this->db->str(self::CODE) . ' AND `key` = ' . $this->db->str(self::CODE . '_' . $key) . ' LIMIT 1');

		if (!$row) {
			return $default;
		}

		return (int)$row['serialized'] ? json_decode((string)$row['value'], true) : $row['value'];
	}

	/** @param mixed $value */
	public function set(int $storeId, string $key, $value): void {
		$full = self::CODE . '_' . $key;
		$serialized = is_array($value) ? 1 : 0;
		$stored = $serialized ? json_encode($value) : (string)$value;

		$this->db->exec('DELETE FROM ' . $this->db->t('setting') . ' WHERE `store_id` = ' . $storeId . ' AND `code` = ' . $this->db->str(self::CODE) . ' AND `key` = ' . $this->db->str($full));
		$this->db->exec('INSERT INTO ' . $this->db->t('setting') . ' SET `store_id` = ' . $storeId . ', `code` = ' . $this->db->str(self::CODE) . ', `key` = ' . $this->db->str($full) . ', `value` = ' . $this->db->str($stored) . ', `serialized` = ' . $serialized);
	}

	public function delete(int $storeId, string $key): void {
		$this->db->exec('DELETE FROM ' . $this->db->t('setting') . ' WHERE `store_id` = ' . $storeId . ' AND `code` = ' . $this->db->str(self::CODE) . ' AND `key` = ' . $this->db->str(self::CODE . '_' . $key));
	}

	/** Every row this extension ever wrote — used by uninstall only. */
	public function deleteAll(): void {
		$this->db->exec('DELETE FROM ' . $this->db->t('setting') . ' WHERE `code` = ' . $this->db->str(self::CODE));
	}

	/** @return array<int,array<string,mixed>> store_id => connection record */
	public function allConnections(): array {
		$out = [];

		foreach ($this->db->rows('SELECT `store_id`, `value` FROM ' . $this->db->t('setting') . ' WHERE `code` = ' . $this->db->str(self::CODE) . ' AND `key` = ' . $this->db->str(self::CODE . '_conn')) as $row) {
			$conn = json_decode((string)$row['value'], true);

			if (is_array($conn) && (int)($conn['store_id'] ?? -1) === (int)$row['store_id']) {
				$out[(int)$row['store_id']] = $conn;
			}
		}

		return $out;
	}
}
