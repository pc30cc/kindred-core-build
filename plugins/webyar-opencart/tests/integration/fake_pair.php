<?php
/**
 * TEST ONLY — writes a connection record the way Pairing::complete() does,
 * for a local store that cannot pair for real (Web Yar's pairing requires an
 * https origin that is not a private address). Uses the extension's own
 * classes and the key file the real install created.
 *
 * php fake_pair.php <db> <prefix> <storage_dir> <store_id> <installation_id> <secret> <workspace_id> <connection_id> <store_url> <app_base>
 */
require __DIR__ . '/../../core/autoload.php';

[, $dbName, $prefix, $storage, $storeId, $installation, $secret, $workspace, $connection, $storeUrl, $app] = $argv;

$mysqli = new mysqli('127.0.0.1', 'oc', 'ocpass', $dbName, 33306);
$mysqli->set_charset('utf8mb4');
$ocDb = new class($mysqli) {
	public function __construct(private mysqli $m) {}
	public function query($sql) {
		$r = $this->m->query($sql);
		if ($r instanceof mysqli_result) {
			$rows = $r->fetch_all(MYSQLI_ASSOC);
			return (object)['rows' => $rows, 'row' => $rows[0] ?? [], 'num_rows' => count($rows)];
		}
		if ($r === false) {
			throw new RuntimeException($this->m->error);
		}
		return true;
	}
	public function escape($v) { return $this->m->real_escape_string($v); }
};

$db = new WebYar\OpenCart\Db($ocDb, $prefix);
$key = WebYar\OpenCart\LocalKey::load($storage);
if ($key === null) {
	fwrite(STDERR, "no local key — install the extension first\n");
	exit(1);
}
$record = WebYar\OpenCart\Connection::toRecord((int)$storeId, ['installationId' => $installation, 'connectionId' => $connection, 'workspaceId' => $workspace], $secret, $key, $storeUrl, $app, $app);
(new WebYar\OpenCart\Settings($db))->set((int)$storeId, 'conn', $record);
(new WebYar\OpenCart\Settings($db))->set((int)$storeId, 'widget', '1');
echo "paired store $storeId\n";
