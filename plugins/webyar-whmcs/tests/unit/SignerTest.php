<?php

use PHPUnit\Framework\TestCase;
use WebYar\Whmcs\Api\Endpoint;
use WebYar\Whmcs\Platform;
use WebYar\Whmcs\Signer;
use WebYar\Whmcs\Version;

final class SignerTest extends TestCase
{
    protected function setUp(): void
    {
        WhmcsDb::boot();
        WhmcsDb::seed();
    }

    public function test_a_correctly_signed_request_is_accepted(): void
    {
        list($status, $payload) = Signing::call('health');
        $this->assertSame(200, $status);
        $this->assertTrue($payload['ok']);
        $this->assertSame(Version::PROTOCOL, $payload['data']['protocol_version']);
    }

    public function test_a_tampered_body_is_rejected(): void
    {
        $body = json_encode(array('op' => 'health'));
        $headers = Signing::headers($body);
        list($status, $payload) = Endpoint::process('POST', $headers, json_encode(array('op' => 'catalog.browse')));
        $this->assertSame(401, $status);
        $this->assertSame('bad_signature', $payload['error']);
    }

    public function test_health_reads_the_configured_merchant_name_as_bounded_plain_text(): void
    {
        \WebYar\Whmcs\Platform::$settingsOverride['CompanyName'] = " <b>فروشگاه من</b> &amp; Cloud\n ";
        $this->assertSame('فروشگاه من & Cloud', Signing::call('health')[1]['data']['store_name']);
        \WebYar\Whmcs\Platform::$settingsOverride['CompanyName'] = str_repeat('ف', 250);
        $this->assertSame(str_repeat('ف', 200), Signing::call('health')[1]['data']['store_name']);
        unset(\WebYar\Whmcs\Platform::$settingsOverride['CompanyName']);
        $this->assertSame('', Signing::call('health')[1]['data']['store_name']);
    }

    public function test_the_wrong_secret_is_rejected(): void
    {
        $body = json_encode(array('op' => 'health'));
        list($status, $payload) = Endpoint::process('POST', Signing::headers($body, 'not-the-secret'), $body);
        $this->assertSame(401, $status);
        $this->assertSame('bad_signature', $payload['error']);
    }

    public function test_another_installation_is_rejected_before_the_hmac(): void
    {
        $body = json_encode(array('op' => 'health'));
        list($status, $payload) = Endpoint::process('POST', Signing::headers($body, WhmcsDb::SECRET, '11111111-1111-1111-1111-111111111111'), $body);
        $this->assertSame(401, $status);
        $this->assertSame('unknown_installation', $payload['error']);
    }

    public function test_a_replayed_nonce_is_rejected(): void
    {
        $body = json_encode(array('op' => 'health'));
        $headers = Signing::headers($body);
        $this->assertSame(200, Endpoint::process('POST', $headers, $body)[0]);
        list($status, $payload) = Endpoint::process('POST', $headers, $body);
        $this->assertSame(401, $status);
        $this->assertSame('replay', $payload['error']);
    }

    public function test_a_stale_or_future_timestamp_is_rejected(): void
    {
        $body = json_encode(array('op' => 'health'));
        foreach (array(-301, 301) as $offset) {
            $headers = Signing::headers($body);
            Platform::$nowOverride += $offset; // the server clock moved, the request did not
            list($status, $payload) = Endpoint::process('POST', $headers, $body);
            Platform::$nowOverride -= $offset;
            $this->assertSame(401, $status);
            $this->assertSame('clock_skew', $payload['error']);
        }
    }

    public function test_protocol_method_and_content_type_are_enforced(): void
    {
        $body = json_encode(array('op' => 'health'));
        $this->assertSame('protocol_mismatch', Endpoint::process('POST', Signing::headers($body, WhmcsDb::SECRET, WhmcsDb::INSTALLATION, array('x-webyar-protocol' => 'webyar-commerce/2')), $body)[1]['error']);
        $this->assertSame(405, Endpoint::process('GET', Signing::headers($body), $body)[0]);
        $this->assertSame(415, Endpoint::process('POST', Signing::headers($body, WhmcsDb::SECRET, WhmcsDb::INSTALLATION, array('content-type' => 'text/plain')), $body)[0]);
        $this->assertSame(413, Endpoint::process('POST', Signing::headers($body), null)[0]);
    }

    public function test_an_unknown_op_is_refused_there_is_no_generic_path(): void
    {
        foreach (array('sql', 'localApi', 'GetClientsDetails', '../health', '') as $op) {
            list($status, $payload) = Signing::call($op);
            $this->assertSame(400, $status, $op);
            $this->assertSame('unknown_op', $payload['error']);
        }
    }

    /**
     * The shared protocol vector (tests/fixtures/protocol-vectors.json) is
     * verified by BOTH this suite and src/test/commerce/whmcsProtocol.test.ts,
     * so the PHP and TypeScript signers cannot drift apart.
     */
    public function test_shared_signature_vector(): void
    {
        $vector = json_decode(file_get_contents(__DIR__ . '/../fixtures/protocol-vectors.json'), true);
        $r = $vector['request'];
        $string = Signer::stringToSign($r['protocol'], $r['method'], $r['path'], $r['installation_id'], $r['timestamp'], $r['nonce'], hash('sha256', $r['body']));
        $this->assertSame($r['string_to_sign'], $string);
        $this->assertSame($r['signature'], Signer::sign($vector['secret'], $string));
    }
}
