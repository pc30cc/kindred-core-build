/**
 * WEBYAR Telephony Control Service — unit/integration tests.
 *
 * The production code paths under test are the real ones shipped in
 * ops/telephony/src. Only the outer edges are faked (Asterisk CLI/ARI, the
 * PJSIP Realtime store, LiveKit SIP and Core) so CI needs no SIP provider.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../../../ops/telephony/src/app.js';
import { parseRegistrationState } from '../../../ops/telephony/src/asteriskAri.js';
import {
  objectIdFor,
  outcomeToState,
  parseProvisionRequest,
} from '../../../ops/telephony/src/registrations.js';
import {
  createCallOrchestrator,
  endpointFromChannelName,
  maskNumber,
} from '../../../ops/telephony/src/incomingCalls.js';
import { signLiveKitToken, createLiveKitSipClient } from '../../../ops/telephony/src/livekitSip.js';
import { createCoreClient } from '../../../ops/telephony/src/coreClient.js';

const SECRET = 'test-internal-secret-value';
const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const INST_A = '33333333-3333-4333-8333-333333333333';
const INST_B = '44444444-4444-4444-8444-444444444444';

function fakeStore(overrides: Record<string, any> = {}) {
  const rows = new Map<string, any>();
  return {
    rows,
    ping: vi.fn(async () => undefined),
    upsertRegistration: vi.fn(async (obj: any) => { rows.set(obj.objectId, obj); }),
    deleteRegistration: vi.fn(async (id: string) => rows.delete(id)),
    findEndpointOwner: vi.fn(async (id: string) => {
      const row = rows.get(id);
      return row
        ? { installationId: row.installationId, workspaceId: row.workspaceId, provider: 'daftareshoma' }
        : null;
    }),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeAsterisk(state = 'Registered', overrides: Record<string, any> = {}) {
  return {
    info: vi.fn(async () => ({ ok: true, version: '20.0.0' })),
    sipStackUp: vi.fn(async () => true),
    cli: vi.fn(async () => ''),
    reloadRegistration: vi.fn(async () => undefined),
    registrationState: vi.fn(async () => parseRegistrationState(state)),
    removeRegistration: vi.fn(async () => undefined),
    getChannelVar: vi.fn(async () => 'sip-call-id-1'),
    answer: vi.fn(async () => undefined),
    ring: vi.fn(async () => undefined),
    hangup: vi.fn(async () => undefined),
    createBridge: vi.fn(async () => undefined),
    addToBridge: vi.fn(async () => undefined),
    destroyBridge: vi.fn(async () => undefined),
    originateToLiveKit: vi.fn(async () => 'media-channel-1'),
    ...overrides,
  };
}

function fakeCore(incoming: any = { ok: true, room_name: 'tel_abc_x1', call_session_id: 'cs-1' }) {
  return {
    health: vi.fn(async () => true),
    reportRegistrationState: vi.fn(async () => undefined),
    incomingCall: vi.fn(async () => incoming),
    callEnded: vi.fn(async () => undefined),
  };
}

function fakeLiveKit(ok = true) {
  return {
    ready: vi.fn(async () => (ok ? { ok: true } : { ok: false, error: 'connection refused' })),
    bootstrap: vi.fn(async () => ({ trunkId: 't1', dispatchRuleId: 'd1', created: [] })),
  };
}

function buildApp(parts: Partial<Record<string, any>> = {}) {
  const store = parts.store ?? fakeStore();
  const asterisk = parts.asterisk ?? fakeAsterisk();
  const core = parts.core ?? fakeCore();
  const livekit = parts.livekit ?? fakeLiveKit();
  const orchestrator = parts.orchestrator ?? createCallOrchestrator({
    asterisk: asterisk as any,
    store: store as any,
    core: core as any,
    livekitSipEndpoint: 'livekit_sip',
  });
  const app = createApp({
    internalSecret: SECRET,
    store: store as any,
    asterisk: asterisk as any,
    livekit: livekit as any,
    core: core as any,
    orchestrator,
    publicSipHost: 'sip.example.test',
    registrationTimeoutMs: 50,
    sleep: async () => undefined,
  });
  return { app, store, asterisk, core, livekit, orchestrator };
}

const validBody = (workspaceId = WS_A) => ({
  workspace_id: workspaceId,
  provider: 'daftareshoma',
  sip_username: 'user123',
  sip_password: 'S3cret!pass',
  sip_extension: '1001',
  domain: 'sip.provider.example',
  transport: 'udp',
});

describe('control service — internal auth', () => {
  it('rejects a request with no credential', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/internal/telephony/health');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong secret and accepts either transport', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/internal/telephony/health').set('authorization', 'Bearer nope')).status).toBe(401);
    expect((await request(app).get('/internal/telephony/health')
      .set('x-telephony-internal-secret', SECRET)).status).toBe(200);
    expect((await request(app).get('/internal/telephony/health')
      .set('authorization', `Bearer ${SECRET}`)).status).toBe(200);
  });
});

describe('control service — registration provisioning', () => {
  it('writes realtime objects, kicks a real REGISTER and reports registered', async () => {
    const { app, store, asterisk, core } = buildApp();
    const res = await request(app)
      .put(`/internal/telephony/registrations/${INST_A}`)
      .set('authorization', `Bearer ${SECRET}`)
      .send(validBody());

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('registered');
    expect(store.upsertRegistration).toHaveBeenCalledTimes(1);
    expect(asterisk.reloadRegistration).toHaveBeenCalledWith(objectIdFor(INST_A));
    expect(core.reportRegistrationState).toHaveBeenCalled();
  });

  it('never returns the SIP password in any response', async () => {
    const { app } = buildApp();
    const ok = await request(app).put(`/internal/telephony/registrations/${INST_A}`)
      .set('authorization', `Bearer ${SECRET}`).send(validBody());
    const bad = await request(app).put(`/internal/telephony/registrations/${INST_A}`)
      .set('authorization', `Bearer ${SECRET}`).send({ ...validBody(), sip_password: 'has space' });
    expect(JSON.stringify(ok.body)).not.toContain('S3cret!pass');
    expect(JSON.stringify(bad.body)).not.toContain('has space');
    expect(bad.status).toBe(400);
    expect(bad.body.fields).toContain('sip_password_invalid');
  });

  it('is idempotent: repeating the same provisioning keeps one object set', async () => {
    const { app, store } = buildApp();
    for (let i = 0; i < 3; i += 1) {
      await request(app).put(`/internal/telephony/registrations/${INST_A}`)
        .set('authorization', `Bearer ${SECRET}`).send(validBody());
    }
    expect(store.rows.size).toBe(1);
  });

  it('rejects configuration-injection attempts instead of escaping them', () => {
    const attack = parseProvisionRequest(INST_A, {
      ...validBody(),
      sip_username: 'user\n[evil]\ntype=endpoint',
      domain: 'evil.example/;rm -rf',
    });
    expect(attack.ok).toBe(false);
    if (!attack.ok) {
      const attackErrors = 'errors' in attack ? attack.errors : [];
      expect(attackErrors).toContain('sip_username_invalid');
      expect(attackErrors).toContain('domain_invalid');
    }
  });

  it('removes a registration and marks it disabled in Core', async () => {
    const { app, store, core } = buildApp();
    await request(app).put(`/internal/telephony/registrations/${INST_A}`)
      .set('authorization', `Bearer ${SECRET}`).send(validBody());
    const res = await request(app).delete(`/internal/telephony/registrations/${INST_A}`)
      .set('authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    expect(store.rows.size).toBe(0);
    expect(core.reportRegistrationState).toHaveBeenCalledWith(INST_A, 'disabled', null);
  });
});

describe('control service — tenant isolation', () => {
  it('gives each installation its own Asterisk objects', async () => {
    const { app, store } = buildApp();
    await request(app).put(`/internal/telephony/registrations/${INST_A}`)
      .set('authorization', `Bearer ${SECRET}`).send(validBody(WS_A));
    await request(app).put(`/internal/telephony/registrations/${INST_B}`)
      .set('authorization', `Bearer ${SECRET}`).send(validBody(WS_B));

    expect(store.rows.size).toBe(2);
    expect(store.rows.get(objectIdFor(INST_A)).workspaceId).toBe(WS_A);
    expect(store.rows.get(objectIdFor(INST_B)).workspaceId).toBe(WS_B);
    expect(objectIdFor(INST_A)).not.toBe(objectIdFor(INST_B));
  });

  it('removing one workspace leaves the other registered', async () => {
    const { app, store } = buildApp();
    await request(app).put(`/internal/telephony/registrations/${INST_A}`)
      .set('authorization', `Bearer ${SECRET}`).send(validBody(WS_A));
    await request(app).put(`/internal/telephony/registrations/${INST_B}`)
      .set('authorization', `Bearer ${SECRET}`).send(validBody(WS_B));
    await request(app).delete(`/internal/telephony/registrations/${INST_A}`)
      .set('authorization', `Bearer ${SECRET}`);
    expect(store.rows.has(objectIdFor(INST_B))).toBe(true);
  });
});

describe('control service — Test Connection maps real SIP outcomes', () => {
  const cases: Array<[string, string, string | undefined]> = [
    ['  Registered  ', 'registered', undefined],
    ['Rejected (permanent) 403 Forbidden', 'failed', 'invalid_credentials'],
    ['Rejected (temporary) 503', 'failed', 'provider_rejected'],
    ['Failed to resolve sip.provider.example', 'failed', 'dns_failure'],
    ['Unregistered', 'failed', 'registration_timeout'],
    ['Unable to find object', 'not_configured', 'not_configured'],
  ];

  it.each(cases)('maps %s', async (cliOutput, state, errorCode) => {
    const { app } = buildApp({ asterisk: fakeAsterisk(cliOutput) });
    const res = await request(app).post(`/internal/telephony/registrations/${INST_A}/test`)
      .set('authorization', `Bearer ${SECRET}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.state).toBe(state);
    expect(res.body.error_code).toBe(errorCode);
  });

  it('never reports registered just because a database row exists', async () => {
    const store = fakeStore();
    store.rows.set(objectIdFor(INST_A), { installationId: INST_A, workspaceId: WS_A });
    const { app } = buildApp({ store, asterisk: fakeAsterisk('Unregistered') });
    const res = await request(app).post(`/internal/telephony/registrations/${INST_A}/test`)
      .set('authorization', `Bearer ${SECRET}`).send({});
    expect(res.body.state).not.toBe('registered');
  });
});

describe('control service — dependency failures', () => {
  it('reports gateway_unavailable when Asterisk is down', async () => {
    const asterisk = fakeAsterisk('Registered', {
      registrationState: vi.fn(async () => { throw new Error('asterisk_cli_failed:connection refused'); }),
    });
    const { app } = buildApp({ asterisk });
    const res = await request(app).post(`/internal/telephony/registrations/${INST_A}/test`)
      .set('authorization', `Bearer ${SECRET}`).send({});
    expect(res.body.state).toBe('failed');
    expect(res.body.error_code).toBe('registration_timeout');
  });

  it('fails provisioning with gateway_unavailable when the realtime database is down', async () => {
    const store = fakeStore({
      upsertRegistration: vi.fn(async () => { throw new Error('ECONNREFUSED database'); }),
    });
    const { app } = buildApp({ store });
    const res = await request(app).put(`/internal/telephony/registrations/${INST_A}`)
      .set('authorization', `Bearer ${SECRET}`).send(validBody());
    expect(res.status).toBe(503);
    expect(res.body.error_code).toBe('gateway_unavailable');
  });

  it('is unhealthy — never silently degraded — when LiveKit SIP is unavailable', async () => {
    const { app } = buildApp({ livekit: fakeLiveKit(false) });
    const res = await request(app).get('/internal/telephony/health')
      .set('authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(503);
    expect(res.body.livekit_sip_ready).toBe(false);
    expect(res.body.gateway_healthy).toBe(false);
  });

  it('health reports every dependency it actually probed', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/internal/telephony/health')
      .set('authorization', `Bearer ${SECRET}`);
    expect(res.body).toMatchObject({
      gateway_healthy: true, asterisk_ari: true, asterisk_sip: true,
      realtime_db: true, livekit_sip_ready: true,
    });
  });
});

describe('control service — inbound calls', () => {
  const stasis = (channelId = 'chan-1') => ({
    channel: {
      id: channelId,
      name: `PJSIP/${objectIdFor(INST_A)}-0000000a`,
      caller: { number: '+989121234567' },
      dialplan: { exten: '2140000' },
    },
  });

  function orchestratorWith(core = fakeCore(), asterisk = fakeAsterisk()) {
    const store = fakeStore();
    store.rows.set(objectIdFor(INST_A), { installationId: INST_A, workspaceId: WS_A });
    const orchestrator = createCallOrchestrator({
      asterisk: asterisk as any, store: store as any, core: core as any,
      livekitSipEndpoint: 'livekit_sip',
    });
    return { orchestrator, core, asterisk, store };
  }

  it('resolves the tenant from the endpoint row, not from SIP headers', async () => {
    const { orchestrator, core } = orchestratorWith();
    const call = await orchestrator.handleStasisStart(stasis() as any);
    expect(call?.installationId).toBe(INST_A);
    expect(core.incomingCall).toHaveBeenCalledWith(expect.objectContaining({
      installation_id: INST_A, sip_call_id: 'sip-call-id-1', caller_number: '+989121234567',
    }));
    expect(call?.roomName).toBe('tel_abc_x1');
  });

  it('rejects a call on an endpoint with no known installation', async () => {
    const store = fakeStore();
    const asterisk = fakeAsterisk();
    const core = fakeCore();
    const orchestrator = createCallOrchestrator({
      asterisk: asterisk as any, store: store as any, core: core as any, livekitSipEndpoint: 'livekit_sip',
    });
    const call = await orchestrator.handleStasisStart(stasis() as any);
    expect(call).toBeNull();
    expect(core.incomingCall).not.toHaveBeenCalled();
    expect(asterisk.hangup).toHaveBeenCalled();
  });

  it('is idempotent for a duplicate SIP Call-ID', async () => {
    const { orchestrator, core } = orchestratorWith();
    const first = await orchestrator.handleStasisStart(stasis('chan-1') as any);
    const second = await orchestrator.handleStasisStart(stasis('chan-2') as any);
    expect(core.incomingCall).toHaveBeenCalledTimes(1);
    expect(second?.sipCallId).toBe(first?.sipCallId);
    expect(orchestrator.registry.bySipCallId.size).toBe(1);
  });

  it('hangs up when Core refuses the call', async () => {
    const { orchestrator, asterisk } = orchestratorWith(fakeCore({ ok: false, error: 'voice_not_entitled' }) as any);
    const call = await orchestrator.handleStasisStart(stasis() as any);
    expect(call).toBeNull();
    expect(asterisk.hangup).toHaveBeenCalled();
  });

  it('answer bridges the PSTN leg into the exact room Core chose', async () => {
    const { orchestrator, asterisk } = orchestratorWith();
    await orchestrator.handleStasisStart(stasis() as any);
    await orchestrator.answer('sip-call-id-1', 'tel_abc_x1');
    expect(asterisk.answer).toHaveBeenCalledWith('chan-1');
    expect(asterisk.originateToLiveKit).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'livekit_sip', room: 'tel_abc_x1',
    }));
    expect(asterisk.addToBridge).toHaveBeenCalledWith(expect.any(String), ['chan-1', 'media-channel-1']);
  });

  it('answering twice does not create a second media session', async () => {
    const { orchestrator, asterisk } = orchestratorWith();
    await orchestrator.handleStasisStart(stasis() as any);
    await orchestrator.answer('sip-call-id-1', 'tel_abc_x1');
    await orchestrator.answer('sip-call-id-1', 'tel_abc_x1');
    expect(asterisk.originateToLiveKit).toHaveBeenCalledTimes(1);
  });

  it('converges on one ended lifecycle whichever side hangs up', async () => {
    const { orchestrator, core, asterisk } = orchestratorWith();
    await orchestrator.handleStasisStart(stasis() as any);
    await orchestrator.answer('sip-call-id-1', 'tel_abc_x1');

    await orchestrator.handleChannelDestroyed('chan-1', 'caller_hangup');   // PSTN side
    await orchestrator.handleChannelDestroyed('media-channel-1', 'livekit'); // LiveKit side

    expect(core.callEnded).toHaveBeenCalledTimes(1);
    expect(asterisk.destroyBridge).toHaveBeenCalled();
    expect(orchestrator.registry.bySipCallId.size).toBe(0);
  });

  it('rejects and hangs up through the HTTP control route, 404 for unknown calls', async () => {
    const { orchestrator } = orchestratorWith();
    await orchestrator.handleStasisStart(stasis() as any);
    const { app } = buildApp({ orchestrator });

    const ok = await request(app).post('/internal/telephony/calls/control')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ sip_call_id: 'sip-call-id-1', action: 'reject' });
    expect(ok.status).toBe(200);

    const missing = await request(app).post('/internal/telephony/calls/control')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ sip_call_id: 'nope', action: 'hangup' });
    expect(missing.status).toBe(404);
  });
});

describe('control service — Core callback authentication', () => {
  it('signs every Core request with the internal secret in both transports', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers });
      return new Response(JSON.stringify({ ok: true, room_name: 'r', call_session_id: 'c' }), { status: 200 });
    }) as unknown as typeof fetch;

    const core = createCoreClient('https://core.example/', SECRET, fetchImpl);
    await core.incomingCall({ installation_id: INST_A, provider: 'daftareshoma', sip_call_id: 'x' });
    expect(calls[0].url).toBe('https://core.example/internal/telephony/calls/incoming');
    expect(calls[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(calls[0].headers['x-telephony-internal-secret']).toBe(SECRET);
  });

  it('surfaces a Core rejection instead of pretending the call was accepted', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'unknown_installation' }), { status: 404 })
    ) as unknown as typeof fetch;
    const core = createCoreClient('https://core.example', SECRET, fetchImpl);
    const res = await core.incomingCall({ installation_id: INST_A, provider: 'daftareshoma', sip_call_id: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_installation');
  });
});

describe('LiveKit SIP bootstrap', () => {
  it('is idempotent: existing trunk and dispatch rule are reused', async () => {
    const posted: string[] = [];
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      posted.push(u);
      if (u.endsWith('ListSIPInboundTrunk')) {
        return new Response(JSON.stringify({ items: [{ sip_trunk_id: 't1', name: 'webyar-inbound-trunk' }] }), { status: 200 });
      }
      if (u.endsWith('ListSIPDispatchRule')) {
        return new Response(JSON.stringify({ items: [{ sip_dispatch_rule_id: 'd1', name: 'webyar-callee-dispatch' }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const client = createLiveKitSipClient({
      url: 'wss://livekit.example', apiKey: 'k', apiSecret: 'sssssssssssssssssssssssssssssss',
      trunkName: 'webyar-inbound-trunk', dispatchRuleName: 'webyar-callee-dispatch',
    }, fetchImpl);

    const result = await client.bootstrap();
    expect(result.created).toEqual([]);
    expect(result.trunkId).toBe('t1');
    expect(posted.some((u) => u.includes('CreateSIPInboundTrunk'))).toBe(false);
    expect(posted.some((u) => u.includes('CreateSIPDispatchRule'))).toBe(false);
  });

  it('creates the trunk and callee dispatch rule exactly once on a fresh deployment', async () => {
    const created: string[] = [];
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('ListSIPInboundTrunk') || u.endsWith('ListSIPDispatchRule')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      created.push(u.split('/').pop()!);
      return new Response(JSON.stringify({ sip_trunk_id: 't9', sip_dispatch_rule_id: 'd9' }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createLiveKitSipClient({
      url: 'https://livekit.example', apiKey: 'k', apiSecret: 'sssssssssssssssssssssssssssssss',
      trunkName: 'webyar-inbound-trunk', dispatchRuleName: 'webyar-callee-dispatch',
    }, fetchImpl);

    const result = await client.bootstrap();
    expect(created).toEqual(['CreateSIPInboundTrunk', 'CreateSIPDispatchRule']);
    expect(result.created).toEqual(['trunk', 'dispatch_rule']);
  });

  it('signs a SIP-admin token that LiveKit can verify', () => {
    const token = signLiveKitToken('key', 'secret-value-long-enough-for-hmac');
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    expect(claims.iss).toBe('key');
    expect(claims.sip.admin).toBe(true);
  });
});

describe('helpers', () => {
  it('derives the endpoint from an ARI channel name', () => {
    expect(endpointFromChannelName('PJSIP/wbyabc123-00000001')).toBe('wbyabc123');
    expect(endpointFromChannelName('Local/x@ctx-0001;1')).toBeNull();
  });

  it('masks caller numbers in logs', () => {
    expect(maskNumber('+989121234567')).toBe('+98***67');
    expect(maskNumber(null)).toBe('anonymous');
  });

  it('maps every registration outcome to a safe state', () => {
    expect(outcomeToState('registered')).toEqual({ state: 'registered', errorCode: null });
    expect(outcomeToState('invalid_credentials').state).toBe('failed');
    expect(outcomeToState('not_found').state).toBe('not_configured');
  });
});
