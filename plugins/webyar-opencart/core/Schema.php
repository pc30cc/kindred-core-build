<?php
namespace WebYar\OpenCart;

/**
 * Installs the extension's own table and records which optional columns this
 * OpenCart build has, ONCE at install/upgrade time — never per request.
 *
 * Within 4.1.x alone the product SKU moved from `product.sku` (4.1.0.0) to
 * the `product_code` table (4.1.0.3+), and 3.0.x keeps specials in their own
 * `product_special` table while 4.1.x folds them into `product_discount`.
 * The flags recorded here are what the read services branch on.
 */
final class Schema {
	private Db $db;
	private string $database;

	public function __construct(Db $db, string $database) {
		$this->db = $db;
		$this->database = $database;
	}

	public function install(): void {
		$this->db->exec('CREATE TABLE IF NOT EXISTS ' . $this->db->t('webyar_nonce') . ' (
			`nonce_hash` CHAR(64) NOT NULL,
			`created_at` INT UNSIGNED NOT NULL,
			PRIMARY KEY (`nonce_hash`),
			KEY `created_at` (`created_at`)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
	}

	public function uninstall(): void {
		$this->db->exec('DROP TABLE IF EXISTS ' . $this->db->t('webyar_nonce'));
	}

	/** @return array<string,bool|string> */
	public function detect(string $version): array {
		return [
			'version'            => $version,
			'product_sku'        => $this->hasColumn('product', 'sku'),
			'product_code'       => $this->hasTable('product_code'),
			'product_special'    => $this->hasTable('product_special'),
			'discount_special'   => $this->hasColumn('product_discount', 'special'),
			'discount_type'      => $this->hasColumn('product_discount', 'type'),
			'product_rating'     => $this->hasColumn('product', 'rating'),
			'product_master'     => $this->hasColumn('product', 'master_id'),
			'order_method_json'  => version_compare($version, '4.0.0.0', '>='),
			'return_table'       => $this->hasTable('return'),
		];
	}

	private function hasTable(string $table): bool {
		return (bool)$this->db->row("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = " . $this->db->str($this->database) . " AND TABLE_NAME = " . $this->db->str($this->prefix() . $table) . ' LIMIT 1');
	}

	private function hasColumn(string $table, string $column): bool {
		return (bool)$this->db->row("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = " . $this->db->str($this->database) . " AND TABLE_NAME = " . $this->db->str($this->prefix() . $table) . " AND COLUMN_NAME = " . $this->db->str($column) . ' LIMIT 1');
	}

	private function prefix(): string {
		return trim(str_replace('`', '', $this->db->t('')), '`');
	}
}
