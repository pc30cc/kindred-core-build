<?php
/**
 * Dependency-free unit tests for the version-agnostic core.
 *
 *   php plugins/webyar-opencart/tests/unit/run.php
 *
 * No Composer, no framework: the core must stay loadable on a bare OpenCart
 * host, so its tests are too. OpenCart itself is exercised by the real
 * installs in tests/integration (run.sh).
 */
require __DIR__ . '/../../core/autoload.php';

use WebYar\OpenCart\ApiError;
use WebYar\OpenCart\Connection;
use WebYar\OpenCart\Crypto;
use WebYar\OpenCart\Db;
use WebYar\OpenCart\Identity;
use WebYar\OpenCart\Platform;
use WebYar\OpenCart\Protocol;
use WebYar\OpenCart\ReplayGuard;
use WebYar\OpenCart\Signer;
use WebYar\OpenCart\Text;
use WebYar\OpenCart\Widget;

$failures = 0;
$passed = 0;

function check(string $name, bool $ok, $detail = null): void {
	global $failures, $passed;

	if ($ok) {
		$passed++;
	} else {
		$failures++;
		fwrite(STDERR, "FAIL: $name" . ($detail !== null ? ' — ' . json_encode($detail, JSON_UNESCAPED_UNICODE) : '') . "\n");
	}
}

/** OpenCart-shaped db object backed by in-memory rows (only what the core uses). */
final class FakeOcDb {
	public array $sessions = [];
	public array $customers = [];
	public array $nonces = [];
	public int $affected = 0;
	public array $log = [];

	public function escape($v) {
		return addslashes((string)$v);
	}

	public function countAffected() {
		return $this->affected;
	}

	public function query($sql) {
		$this->log[] = $sql;

		if (preg_match("/INSERT IGNORE INTO `oc_webyar_nonce` SET `nonce_hash` = '([a-f0-9]+)'/", $sql, $m)) {
			$this->affected = isset($this->nonces[$m[1]]) ? 0 : 1;
			$this->nonces[$m[1]] = true;

			return true;
		}

		if (preg_match("/FROM `oc_session` WHERE `session_id` = '([^']+)'/", $sql, $m)) {
			$row = $this->sessions[$m[1]] ?? null;

			return (object)['num_rows' => $row ? 1 : 0, 'row' => $row ? ['data' => json_encode($row)] : [], 'rows' => $row ? [['data' => json_encode($row)]] : []];
		}

		if (preg_match('/FROM `oc_customer` WHERE `customer_id` = (\d+)/', $sql, $m)) {
			$row = $this->customers[(int)$m[1]] ?? null;

			return (object)['num_rows' => $row ? 1 : 0, 'row' => $row ?? [], 'rows' => $row ? [$row] : []];
		}

		return (object)['num_rows' => 0, 'row' => [], 'rows' => []];
	}
}

final class FakePlatform implements Platform {
	public array $config = ['session_engine' => 'db', 'module_webyar_customer_scope' => 'installation'];

	public function version(): string { return '4.1.0.4'; }
	public function storeId(): int { return 0; }
	public function config(string $key) { return $this->config[$key] ?? null; }
	public function storageDir(): string { return sys_get_temp_dir(); }
	public function sessionDir(): string { return sys_get_temp_dir(); }
	public function databaseName(): string { return 'db'; }
	public function languages(): array { return []; }
	public function useLanguage(string $code): void {}
	public function currencies(): array { return []; }
	public function formatMoney(float $amount, string $currency, float $rate = 0.0): string { return (string)$amount; }
	public function convertMoney(float $amount, string $currency, float $rate = 0.0): float { return $amount; }
	public function useCustomerGroup(int $customerGroupId): void {}
	public function useTaxAddresses(?array $shipping, ?array $payment): void {}
	public function withTax(float $value, int $taxClassId): float { return $value; }
	public function priceStatements(): array { return ['discount' => 'NULL AS discount', 'special' => 'NULL AS special']; }
	public function quantityDiscounts(int $productId): array { return []; }
	public function link(string $route, array $args = []): string { return 'https://shop.example/index.php?route=' . $route; }
	public function extensionLink(string $method, array $args = []): string { return $this->link('extension/webyar/module/webyar.' . $method, $args); }
	public function imageUrl(string $path): ?string { return null; }
	public function trackingFromExtensions(array $order): array { return []; }
}

// ── signing: byte-identical to server/services/commerce/signing.ts ─────
$vector = json_decode((string)file_get_contents(__DIR__ . '/../fixtures/signing-vector.json'), true);
$sts = Signer::stringToSign($vector['protocolVersion'], $vector['method'], $vector['canonicalPath'], $vector['installationId'], $vector['timestamp'], $vector['nonce'], $vector['body']);
check('signature matches the TypeScript vector', Crypto::hmac($vector['secret'], $sts) === $vector['expectedSignature']);

$headers = array_change_key_case(Signer::headers('s3cret', 'inst-1', 'POST', '/opencart/v1/health', '{}'));
check('fresh headers verify', Signer::verify($headers, 's3cret', 'inst-1', 'POST', '/opencart/v1/health', '{}') === null);
check('wrong secret is a bad signature', Signer::verify($headers, 'other', 'inst-1', 'POST', '/opencart/v1/health', '{}') === 'bad_signature');
check('another path is a bad signature', Signer::verify($headers, 's3cret', 'inst-1', 'POST', '/opencart/v1/orders/list', '{}') === 'bad_signature');
check('a modified body is a bad signature', Signer::verify($headers, 's3cret', 'inst-1', 'POST', '/opencart/v1/health', '{"x":1}') === 'bad_signature');
check('another installation is refused', Signer::verify($headers, 's3cret', 'inst-2', 'POST', '/opencart/v1/health', '{}') === 'unknown_installation');
check('clock skew is refused', Signer::verify($headers, 's3cret', 'inst-1', 'POST', '/opencart/v1/health', '{}', time() + 3600) === 'clock_skew');
$h = $headers;
$h['x-webyar-protocol'] = 'webyar-commerce/2';
check('another protocol is refused', Signer::verify($h, 's3cret', 'inst-1', 'POST', '/opencart/v1/health', '{}') === 'protocol_mismatch');
$h = $headers;
unset($h['x-webyar-nonce']);
check('missing headers are refused', Signer::verify($h, 's3cret', 'inst-1', 'POST', '/opencart/v1/health', '{}') === 'missing_signature_headers');
check('oversized body is refused', Signer::verify(array_change_key_case(Signer::headers('s', 'i', 'POST', '/p', str_repeat('a', Protocol::MAX_BODY_BYTES + 1))), 's', 'i', 'POST', '/p', str_repeat('a', Protocol::MAX_BODY_BYTES + 1)) === 'body_too_large');

// ── replay guard ──────────────────────────────────────────────────────
$oc = new FakeOcDb();
$guard = new ReplayGuard(new Db($oc, 'oc_'));
check('first nonce accepted', $guard->claim('inst', 'n1') === true);
check('replayed nonce refused', $guard->claim('inst', 'n1') === false);
check('same nonce, other installation accepted', $guard->claim('inst-b', 'n1') === true);

// ── crypto ────────────────────────────────────────────────────────────
$key = Crypto::random(32);
$enc = Crypto::encrypt($key, 'secret', 'aad');
check('encrypt round-trips', Crypto::decrypt($key, $enc, 'aad') === 'secret');
check('wrong AAD does not decrypt', Crypto::decrypt($key, $enc, 'other') === null);
check('wrong key does not decrypt', Crypto::decrypt(Crypto::random(32), $enc, 'aad') === null);
check('random IV: two encryptions differ', Crypto::encrypt($key, 'secret', 'aad') !== $enc);
check('deterministic: same input, same output', Crypto::encryptDeterministic($key, 'x', 'a') === Crypto::encryptDeterministic($key, 'x', 'a'));
check('deterministic: decrypts', Crypto::decrypt($key, Crypto::encryptDeterministic($key, 'x', 'a'), 'a') === 'x');
check('deterministic: different input differs', Crypto::encryptDeterministic($key, 'x', 'a') !== Crypto::encryptDeterministic($key, 'y', 'a'));
check('tampered ciphertext is rejected', Crypto::decrypt($key, substr($enc, 0, -2) . 'AA', 'aad') === null);

// ── text ──────────────────────────────────────────────────────────────
check('markup stripped', Text::clean('<b>Hi</b><script>x</script>') === 'Hix');
check('bounded', mb_strlen(Text::clean(str_repeat('ا', 500), 10)) === 11);
check('terms keep letters, drop SQL', Text::terms(["آیفون", "x' OR 1=1 --", 'a']) === ['آیفون', 'xOR11--']);
check('terms are capped', count(Text::terms(array_fill(0, 20, 'abcd'))) === 1 && count(Text::terms(['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh'])) === Protocol::MAX_TERMS);
check('yeh/kaf variants', in_array('كيف', Text::variants('کیف'), true));

// ── widget ────────────────────────────────────────────────────────────
$record = ['workspace_id' => 'ws"</script><script>alert(1)</script>', 'api_base' => 'https://api.example', 'app_base' => 'https://app.example', 'connection_id' => 'c1'];
$snippet = Widget::snippet($record, 'https://shop.example/index.php?route=x&y=1');
check('snippet escapes everything it embeds', strpos($snippet, '</script><script>alert') === false);
check('snippet carries no identity', strpos($snippet, 'assertion') === false && strpos($snippet, 'secret') === false);
$page = '<html><body><p>x</p></body></html>';
$once = Widget::inject($page, $snippet);
check('injected before </body>', strpos($once, '</script></body>') !== false);
check('never injected twice', Widget::inject($once, $snippet) === $once);
check('a page that already has a loader is left alone', Widget::inject('<script src="https://app.example/widget/loader.js"></script></body>', $snippet) === '<script src="https://app.example/widget/loader.js"></script></body>');
$session = [];
$allowed = 0;
for ($i = 0; $i < 30; $i++) {
	$allowed += Widget::allowContextRequest($session, 1000) ? 1 : 0;
}
check('context endpoint rate limited per session', $allowed === Widget::CONTEXT_LIMIT);
check('limit window resets', Widget::allowContextRequest($session, 1000 + Widget::CONTEXT_WINDOW + 1));

// ── identity: continued access is decided by the live session ─────────
$localKey = Crypto::random(32);
$conn = Connection::fromRecord(Connection::toRecord(0, ['installationId' => 'inst-x', 'connectionId' => 'c', 'workspaceId' => 'w'], 'install-secret', $localKey, 'https://shop.example/', 'https://app', 'https://app'), $localKey);
check('connection record decrypts its own secret', $conn !== null && $conn->secret() === 'install-secret');
$tampered = Connection::toRecord(0, ['installationId' => 'inst-x'], 'install-secret', $localKey, 'u', 'a', 'a');
$tampered['installation_id'] = 'inst-y';
check('a secret moved to another installation does not decrypt', Connection::fromRecord($tampered, $localKey) === null);

$oc = new FakeOcDb();
$oc->customers[101] = ['customer_id' => 101, 'customer_group_id' => 1, 'store_id' => 0, 'firstname' => 'A', 'lastname' => 'B', 'email' => 'a@example.test', 'status' => 1];
$oc->customers[102] = ['customer_id' => 102, 'customer_group_id' => 2, 'store_id' => 1, 'firstname' => 'C', 'lastname' => 'D', 'email' => 'c@example.test', 'status' => 1];
$oc->sessions['sessionaaaaaaaaaaaaaaaaaaaaaa'] = ['customer_id' => 101, 'currency' => 'EUR'];
$platform = new FakePlatform();
$identity = new Identity(new Db($oc, 'oc_'), $platform, $localKey);

$issued = $identity->assertionFor($conn, 'sessionaaaaaaaaaaaaaaaaaaaaaa', ['customer_id' => 101, 'currency' => 'EUR']);
[$payloadB64, $sig] = explode('.', (string)$issued['assertion']);
$payload = json_decode((string)Crypto::base64urlDecode($payloadB64), true);
check('assertion signed with the installation secret', hash_equals(Crypto::hmac('install-secret', $payloadB64), $sig));
check('assertion short-lived and audience-bound', $payload['expires_at'] - $payload['issued_at'] === Protocol::ASSERTION_TTL && $payload['audience'] === 'webyar-widget');
check('session id is never in the clear', strpos((string)$issued['assertion'], 'sessionaaaa') === false && strpos(base64_decode(strtr($payloadB64, '-_', '+/')), 'sessionaaaa') === false);
$again = $identity->assertionFor($conn, 'sessionaaaaaaaaaaaaaaaaaaaaaa', ['customer_id' => 101]);
$payload2 = json_decode((string)Crypto::base64urlDecode(explode('.', (string)$again['assertion'])[0]), true);
check('same session → same reference (Web Yar can skip the write)', $payload2['session_ref'] === $payload['session_ref']);
check('a guest gets no assertion', $identity->assertionFor($conn, 'sessionaaaaaaaaaaaaaaaaaaaaaa', [])['assertion'] === null);

$ref = ['id' => '101', 'session_ref' => $payload['session_ref']];
$ok = $identity->verifyCustomer($conn, $ref);
check('live session of the same customer is accepted', $ok['customer_id'] === 101 && $ok['customer_group_id'] === 1);

$fails = function (callable $fn): ?string {
	try {
		$fn();
	} catch (ApiError $e) {
		return $e->errorCode;
	}

	return null;
};
check('customer id swap is refused', $fails(fn () => $identity->verifyCustomer($conn, ['id' => '102', 'session_ref' => $payload['session_ref']])) === 'identity_invalid');
check('a made-up reference is refused', $fails(fn () => $identity->verifyCustomer($conn, ['id' => '101', 'session_ref' => 'abc'])) === 'identity_invalid');
check('no reference is refused', $fails(fn () => $identity->verifyCustomer($conn, null)) === 'identity_required');
$oc->sessions['sessionaaaaaaaaaaaaaaaaaaaaaa'] = [];
check('logout ends access', $fails(fn () => $identity->verifyCustomer($conn, $ref)) === 'identity_session_ended');
$oc->sessions['sessionaaaaaaaaaaaaaaaaaaaaaa'] = ['customer_id' => 102];
check('another customer in the same session ends access', $fails(fn () => $identity->verifyCustomer($conn, $ref)) === 'identity_session_ended');
unset($oc->sessions['sessionaaaaaaaaaaaaaaaaaaaaaa']);
check('an expired session ends access', $fails(fn () => $identity->verifyCustomer($conn, $ref)) === 'identity_session_ended');
$oc->sessions['sessionaaaaaaaaaaaaaaaaaaaaaa'] = ['customer_id' => 101];
$oc->customers[101]['status'] = 0;
check('a disabled account ends access', $fails(fn () => $identity->verifyCustomer($conn, $ref)) === 'account_disabled');
$oc->customers[101]['status'] = 1;
$otherConn = Connection::fromRecord(Connection::toRecord(0, ['installationId' => 'inst-reconnected'], 'new-secret', $localKey, 'u', 'a', 'a'), $localKey);
check('a reconnect (new installation) invalidates old references', $fails(fn () => $identity->verifyCustomer($otherConn, $ref)) === 'identity_invalid');
$platform->config['session_engine'] = 'redis';
check('an unsupported session engine refuses rather than guesses', $fails(fn () => $identity->verifyCustomer($conn, $ref)) === 'session_engine_unsupported');
$platform->config['session_engine'] = 'db';
$platform->config['module_webyar_customer_scope'] = 'registration_store';
$oc->customers[101]['store_id'] = 1;
check('registration-store scope is enforced', $fails(fn () => $identity->verifyCustomer($conn, $ref)) === 'customer_out_of_store_scope');

echo "core unit tests: $passed passed, $failures failed\n";
exit($failures ? 1 : 0);
