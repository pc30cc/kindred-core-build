<?php
namespace WebYar\OpenCart;

/**
 * Thin wrapper over OpenCart's own `db` registry object (identical API in
 * 3.0.x and 4.1.x: query() returning {row, rows, num_rows}, escape()).
 *
 * It exists for two reasons only:
 *  - every value that enters SQL goes through int()/esc()/like() here, so a
 *    review of the SQL in this extension is a review of these call sites;
 *  - it COUNTS queries and time, so each API response can report exactly
 *    how much database work the store did for it (see docs/commerce/
 *    OPENCART_RESOURCE_REPORT.md). No connection of our own is ever opened.
 */
final class Db {
	/** @var object */
	private $db;
	private string $prefix;
	private int $queries = 0;
	private int $reads = 0;
	private int $writes = 0;
	private float $ms = 0.0;

	public function __construct(object $db, string $prefix) {
		$this->db = $db;
		$this->prefix = $prefix;
	}

	public function t(string $table): string {
		return '`' . $this->prefix . $table . '`';
	}

	public function esc(string $value): string {
		return $this->db->escape($value);
	}

	public function str(string $value): string {
		return "'" . $this->db->escape($value) . "'";
	}

	public static function int($value): int {
		return (int)$value;
	}

	/** LIKE pattern with the wildcard characters of the input neutralised. */
	public function like(string $value): string {
		$value = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $value);

		return "'%" . $this->db->escape($value) . "%'";
	}

	/** @param array<int,int|string> $ids */
	public static function intList(array $ids): string {
		$ints = array_values(array_unique(array_map('intval', $ids)));

		return $ints ? implode(',', $ints) : '0';
	}

	/** @return array<int,array<string,mixed>> */
	public function rows(string $sql): array {
		$result = $this->run($sql, false);

		return (is_object($result) && isset($result->rows)) ? $result->rows : [];
	}

	/** @return array<string,mixed>|null */
	public function row(string $sql): ?array {
		$result = $this->run($sql, false);

		return (is_object($result) && !empty($result->num_rows)) ? $result->row : null;
	}

	public function exec(string $sql): void {
		$this->run($sql, true);
	}

	/** Rows changed by the last write (OpenCart's own countAffected()). */
	public function affected(): int {
		return (int)$this->db->countAffected();
	}

	/** @return array{queries:int,reads:int,writes:int,ms:float} */
	public function stats(): array {
		return ['queries' => $this->queries, 'reads' => $this->reads, 'writes' => $this->writes, 'ms' => round($this->ms, 2)];
	}

	private function run(string $sql, bool $write) {
		$started = microtime(true);
		$this->queries++;
		$write ? $this->writes++ : $this->reads++;

		try {
			return $this->db->query($sql);
		} finally {
			$this->ms += (microtime(true) - $started) * 1000;
		}
	}
}
