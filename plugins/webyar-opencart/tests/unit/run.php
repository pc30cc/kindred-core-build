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
use WebYar\OpenCart\CallbackPage;
use WebYar\OpenCart\I18n;
use WebYar\OpenCart\Updater;
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
	public function packageLine(): string { return '4.1.x'; }
	public function updateTargets(?string $adminDir): array { return ['' => sys_get_temp_dir() . '/webyar-fake/']; }
	public function recordInstalledFiles(array $zipNames, string $version): void {}
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
for ($i = 0; $i < Widget::CONTEXT_LIMIT + 10; $i++) {
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
$oc->customers[101] = ['customer_id' => 101, 'customer_group_id' => 1, 'store_id' => 0, 'firstname' => 'A', 'lastname' => 'B', 'email' => 'a@example.test', 'telephone' => '+905551234567', 'status' => 1];
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
check('phone is signed with the profile', $payload['phone'] === '+905551234567');
check('same customer has stable opaque subject', $again['subject'] === $issued['subject'] && preg_match('/^u[a-f0-9]{64}$/', $issued['subject']) === 1);
check('guest subject resets the widget', $identity->assertionFor($conn, 'sessionaaaaaaaaaaaaaaaaaaaaaa', [])['subject'] === 'anon');
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

// ── I18n ────────────────────────────────────────────────────────────
check('Persian admin → fa', I18n::pick('fa-ir', 'en-gb') === 'fa');
check('English admin, Persian store → fa (the store default wins over English)', I18n::pick('en-gb', 'fa-ir') === 'fa');
check('English everywhere → en', I18n::pick('en-gb', 'en-gb') === 'en');
check('unknown language → en', I18n::pick('de-de') === 'en');
check('fa is right-to-left with Vazirmatn', I18n::direction('fa') === 'rtl' && I18n::font('fa') === 'Vazirmatn' && I18n::font('en') === 'Inter');
$en = I18n::strings('en');
$fa = I18n::strings('fa');
$tr = I18n::strings('tr');
check('every language has every key', array_keys($en) == array_keys(json_decode((string)file_get_contents(__DIR__ . '/../../i18n/fa.json'), true)) && array_keys($en) == array_keys(json_decode((string)file_get_contents(__DIR__ . '/../../i18n/tr.json'), true)));
check('fa strings are Persian', preg_match('/\p{Arabic}/u', $fa['button_back_to_module']) === 1);
check('no editable Web Yar address remains', !isset($en['entry_app_url']) && !isset($en['entry_api_url']));
check('sprintf placeholders match across languages', (function () use ($en, $fa, $tr) {
	foreach ($en as $k => $v) {
		foreach ([$fa, $tr] as $other) {
			if (substr_count($v, '%s') !== substr_count($other[$k], '%s')) {
				return false;
			}
		}
	}

	return true;
})());

// ── connection result page ──────────────────────────────────────────
$page = CallbackPage::render(true, '', 'fa', 'https://shop.example/admin/index.php?route=x&user_token=abc');
check('result page: Persian, rtl, Vazirmatn', strpos($page, 'dir="rtl"') !== false && strpos($page, 'family=Vazirmatn') !== false && strpos($page, $fa['button_back_to_module']) !== false);
check('result page: back button links to the module (escaped)', strpos($page, 'href="https://shop.example/admin/index.php?route=x&amp;user_token=abc"') !== false);
check('result page: success returns by itself, sends no referrer, is not indexed', strpos($page, 'http-equiv="refresh"') !== false && strpos($page, 'name="referrer" content="no-referrer"') !== false && strpos($page, 'noindex') !== false);
$page = CallbackPage::render(false, 'pairing_expired', 'en', 'https://shop.example/admin/');
check('result page: failure shows the reason, the button, no auto-return', strpos($page, 'pairing_expired') !== false && strpos($page, $en['button_back_to_module']) !== false && strpos($page, 'http-equiv') === false && strpos($page, 'dir="ltr"') !== false);
$page = CallbackPage::render(false, '', 'en', 'javascript:alert(1)');
check('result page: only an http(s) return link is used', strpos($page, 'javascript:') === false && strpos($page, $en['text_callback_return']) !== false);
$page = CallbackPage::render(true, '', 'en', 'https://x.example/"><script>');
check('result page: a return url with markup is refused', strpos($page, '<script>') === false);

// ── self-update: signed manifest ────────────────────────────────────
$pair = sodium_crypto_sign_keypair();
$sk = sodium_crypto_sign_secretkey($pair);
$pk = base64_encode(sodium_crypto_sign_publickey($pair));
$sha = str_repeat('ab', 32);
$manifest = fn (array $over = []) => json_encode($over + ['slug' => 'webyar-opencart', 'version' => '9.0.0', 'protocol' => Protocol::PROTOCOL_VERSION, 'packages' => [
	['opencart' => '4.1.x', 'path' => '/downloads/opencart/4.1/webyar.ocmod.zip', 'sha256' => $sha],
	['opencart' => '3.0.5.x', 'path' => '/downloads/opencart/3.0/webyar-oc3.ocmod.zip', 'sha256' => $sha],
]]);
$sign = fn (string $body) => base64_encode(sodium_crypto_sign_detached($body, $sk));
$parseFails = function (string $body, string $sig, string $key = '', string $current = '1.1.0', string $line = '4.1.x') use ($pk): ?string {
	try {
		Updater::parseManifest($body, $sig, $key ?: $pk, $current, $line);

		return null;
	} catch (\Throwable $e) {
		return $e->getMessage();
	}
};
$body = $manifest();
$release = Updater::parseManifest($body, $sign($body), $pk, '1.1.0', '4.1.x');
check('a signed, newer release is accepted for this line', $release === ['version' => '9.0.0', 'path' => '/downloads/opencart/4.1/webyar.ocmod.zip', 'sha256' => $sha]);
check('the 3.0 line gets its own package', Updater::parseManifest($body, $sign($body), $pk, '1.1.0', '3.0.5.x')['path'] === '/downloads/opencart/3.0/webyar-oc3.ocmod.zip');
check('same or older version → nothing to do', Updater::parseManifest($body, $sign($body), $pk, '9.0.0', '4.1.x') === null && Updater::parseManifest($body, $sign($body), $pk, '9.1.0', '4.1.x') === null);
check('a tampered manifest is refused', $parseFails(str_replace('9.0.0', '9.0.1', $body), $sign($body)) === 'signature_invalid');
check('another key\'s signature is refused', $parseFails($body, $sign($body), base64_encode(sodium_crypto_sign_publickey(sodium_crypto_sign_keypair()))) === 'signature_invalid');
check('a malformed signature is refused', $parseFails($body, 'not-base64!') === 'bad_signature_format' && $parseFails($body, base64_encode('short')) === 'bad_signature_format');
$b = $manifest(['protocol' => 'webyar-commerce/2']);
check('another protocol is refused', $parseFails($b, $sign($b)) === 'manifest_incompatible');
$b = $manifest(['slug' => 'something-else']);
check('another product is refused', $parseFails($b, $sign($b)) === 'manifest_invalid');
$b = $manifest(['packages' => [['opencart' => '4.1.x', 'path' => 'https://evil.example/x.zip', 'sha256' => $sha]]]);
check('a package off the fixed path is refused', $parseFails($b, $sign($b)) === 'package_invalid');
$b = $manifest(['packages' => [['opencart' => '4.1.x', 'path' => '/downloads/opencart/../../x.zip', 'sha256' => $sha]]]);
check('a traversing package path is refused', $parseFails($b, $sign($b)) === 'package_invalid');
$b = $manifest(['packages' => [['opencart' => '4.1.x', 'path' => '/downloads/opencart/4.1/webyar.ocmod.zip', 'sha256' => 'nope']]]);
check('a package without a proper checksum is refused', $parseFails($b, $sign($b)) === 'package_invalid');
check('no package for this line → refused', $parseFails($body, $sign($body), '', '1.1.0', '2.0.x') === 'no_package_for_2.0.x');
check('the built-in key is a 32-byte Ed25519 key', strlen((string)base64_decode(Protocol::UPDATE_PUBLIC_KEY, true)) === 32);

// ── self-update: package contents ───────────────────────────────────
$zipOf = function (array $entries, array $links = []): string {
	$file = tempnam(sys_get_temp_dir(), 'wyt');
	$zip = new \ZipArchive();
	$zip->open($file, \ZipArchive::OVERWRITE);

	foreach ($entries as $name => $data) {
		$zip->addFromString($name, $data);
	}

	foreach ($links as $name) {
		$zip->addFromString($name, '/etc/passwd');
		$zip->setExternalAttributesName($name, \ZipArchive::OPSYS_UNIX, (0120777) << 16);
	}

	$zip->close();
	$bytes = (string)file_get_contents($file);
	unlink($file);

	return $bytes;
};
$unpackFails = function (string $bytes, array $targets): ?string {
	try {
		Updater::unpackFor($bytes, $targets);

		return null;
	} catch (\Throwable $e) {
		return $e->getMessage();
	}
};
$oc4 = ['' => '/srv/oc/extension/webyar/'];
$oc3 = ['upload/admin/' => '/srv/oc/admin/', 'upload/catalog/' => '/srv/oc/catalog/', 'upload/system/' => '/srv/oc/system/'];
$files = Updater::unpackFor($zipOf(['install.json' => '{}', 'system/library/webyar/Api.php' => '<?php', 'admin/view/template/module/webyar.twig' => 'x']), $oc4);
check('4.1: files map into the extension folder only', array_column($files, 'path') === ['/srv/oc/extension/webyar/install.json', '/srv/oc/extension/webyar/system/library/webyar/Api.php', '/srv/oc/extension/webyar/admin/view/template/module/webyar.twig']);
$files = Updater::unpackFor($zipOf(['upload/admin/controller/extension/module/webyar.php' => '<?php', 'upload/system/library/webyar/i18n/fa.json' => '{}']), $oc3);
check('3.0: upload/ maps onto the real admin, catalog and system folders', array_column($files, 'path') === ['/srv/oc/admin/controller/extension/module/webyar.php', '/srv/oc/system/library/webyar/i18n/fa.json']);
check('3.0: anything outside upload/{admin,catalog,system} is refused', $unpackFails($zipOf(['upload/image/x.png' => 'x']), $oc3) === 'package_outside_extension' && $unpackFails($zipOf(['install.xml' => 'x']), $oc3) === 'package_file_type');
check('".." entries are refused', $unpackFails($zipOf(['system/../../../index.php' => 'x']), $oc4) === 'package_bad_path');
check('absolute entries are refused', $unpackFails($zipOf(['/etc/cron.d/x.php' => 'x']), $oc4) === 'package_bad_path');
check('symlinks are refused', $unpackFails($zipOf(['a.php' => '<?php'], ['link.php']), $oc4) === 'package_symlink');
check('unexpected file types are refused', $unpackFails($zipOf(['shell.phtml' => 'x']), $oc4) === 'package_file_type' && $unpackFails($zipOf(['.htaccess' => 'x']), $oc4) === 'package_file_type');
check('a non-zip is refused', $unpackFails('not a zip', $oc4) === 'package_unreadable');
check('unknown targets refuse everything', $unpackFails($zipOf(['a.php' => 'x']), []) === 'update_targets_unknown');
$built = __DIR__ . '/../../../../public/downloads/opencart/4.1/webyar.ocmod.zip';

if (is_file($built)) {
	$names = array_column(Updater::unpackFor((string)file_get_contents($built), $oc4), 'name');
	check('the real 4.1 package passes its own update checks', in_array('system/library/webyar/Updater.php', $names, true) && in_array('admin/view/template/module/webyar.twig', $names, true));
	$names = array_column(Updater::unpackFor((string)file_get_contents(dirname($built, 2) . '/3.0/webyar-oc3.ocmod.zip'), $oc3), 'name');
	check('the real 3.0 package passes its own update checks', in_array('upload/system/library/webyar/Updater.php', $names, true));
}

// ── compiled template cache after an upgrade ────────────────────────
$cache = sys_get_temp_dir() . '/wy-cache-' . bin2hex(random_bytes(4));
mkdir($cache . '/template/ab', 0777, true);
mkdir($cache . '/template/cd', 0777, true);
file_put_contents($cache . '/template/ab/1.php', "<?php\n/* extension/webyar/admin/view/template/module/webyar.twig */\nclass A {}");
file_put_contents($cache . '/template/ab/2.php', "<?php\n/* extension/module/webyar.twig */\nclass B {}");
file_put_contents($cache . '/template/cd/3.php', "<?php\n/* common/header.twig */\nclass C {}");
file_put_contents($cache . '/template/cd/4.php', "<?php\n/* extension/webyarsomething/module/other.twig */\nclass D {}");
check('template cache: only Web Yar pages are dropped (4.1 and 3.0 names)', Updater::clearTemplateCache($cache . '/') === 2 && !is_file($cache . '/template/ab/1.php') && !is_file($cache . '/template/ab/2.php') && is_file($cache . '/template/cd/3.php') && is_file($cache . '/template/cd/4.php'));
check('template cache: nothing to do is fine', Updater::clearTemplateCache('') === 0 && Updater::clearTemplateCache($cache . '/missing/') === 0);
array_map('unlink', glob($cache . '/template/*/*.php'));

echo "core unit tests: $passed passed, $failures failed\n";
exit($failures ? 1 : 0);
