/**
 * One deployment serves builds of both kinds: a build Xcode installs registers
 * its token with Apple's sandbox, a TestFlight or App Store build with
 * production. The configured gateway answers BadDeviceToken for the other
 * kind, and that used to disable the device for good (RESPOK's iPhone, built
 * from Xcode, against a production deployment: no notification ever). The
 * send now tries the other gateway once before it gives the token up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const PROD = 'https://api.push.apple.com';
const SANDBOX = 'https://api.sandbox.push.apple.com';

// host -> token -> [status, reason]
const answers = new Map<string, Map<string, [number, string?]>>();
const calls: string[] = [];

vi.mock('node:http2', () => {
  const connect = (host: string) => {
    const session = new EventEmitter() as EventEmitter & Record<string, unknown>;
    session.closed = false;
    session.destroyed = false;
    session.close = () => { session.closed = true; };
    session.setTimeout = () => session;
    session.request = (headers: Record<string, string>) => {
      const token = String(headers[':path']).split('/').pop()!;
      calls.push(`${host} ${token}`);
      const stream = new EventEmitter() as EventEmitter & Record<string, unknown>;
      stream.setTimeout = () => stream;
      stream.close = () => {};
      stream.end = () => {
        const [status, reason] = answers.get(host)?.get(token) ?? [200];
        queueMicrotask(() => {
          stream.emit('response', { ':status': status });
          if (reason) stream.emit('data', JSON.stringify({ reason }));
          stream.emit('end');
        });
      };
      return stream;
    };
    return session;
  };
  const constants = { NGHTTP2_CANCEL: 8 };
  return { default: { connect, constants }, connect, constants };
});

const { performApnsRequest, resetApnsCache } = await import('../../../server/services/push/apns');

function request(token: string, host = PROD) {
  return { host, headers: { ':method': 'POST', ':path': `/3/device/${token}` }, body: Buffer.from('{}') };
}

function answer(host: string, token: string, status: number, reason?: string) {
  if (!answers.has(host)) answers.set(host, new Map());
  answers.get(host)!.set(token, [status, reason]);
}

beforeEach(() => {
  answers.clear();
  calls.length = 0;
  resetApnsCache();
});

describe('APNs gateway fallback', () => {
  it('delivers a sandbox token through a production deployment, and remembers where it lives', async () => {
    answer(PROD, 'aa11', 400, 'BadDeviceToken');
    expect(await performApnsRequest(request('aa11'))).toMatchObject({ ok: true });
    expect(calls).toEqual([`${PROD} aa11`, `${SANDBOX} aa11`]);

    calls.length = 0;
    expect(await performApnsRequest(request('aa11'))).toMatchObject({ ok: true });
    expect(calls).toEqual([`${SANDBOX} aa11`]);
  });

  it('works the other way round: a production token on a sandbox deployment', async () => {
    answer(SANDBOX, 'bb22', 400, 'BadDeviceToken');
    expect(await performApnsRequest(request('bb22', SANDBOX))).toMatchObject({ ok: true });
    expect(calls).toEqual([`${SANDBOX} bb22`, `${PROD} bb22`]);
  });

  it('still gives up a token both gateways reject', async () => {
    answer(PROD, 'cc33', 400, 'BadDeviceToken');
    answer(SANDBOX, 'cc33', 400, 'BadDeviceToken');
    expect(await performApnsRequest(request('cc33'))).toMatchObject({ ok: false, unregistered: true, reason: 'BadDeviceToken' });
  });

  it('does not retry a token Apple says is gone (410)', async () => {
    answer(PROD, 'dd44', 410, 'Unregistered');
    expect(await performApnsRequest(request('dd44'))).toMatchObject({ ok: false, unregistered: true });
    expect(calls).toEqual([`${PROD} dd44`]);
  });
});
