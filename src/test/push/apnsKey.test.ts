/**
 * The APNs key, however it was pasted into the server's environment.
 *
 * In production the key was set and every iPhone notification still went
 * nowhere: the value was in the environment but not as a key Node could read,
 * so signing the provider token threw, the throw escaped the whole dispatch,
 * and the log row stayed at "attempted" with nothing to say why. A form
 * field decides what a PEM's line breaks become — spaces, a literal "\n",
 * nothing — and none of that changes the key between the markers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  getApnsCredentialProblem,
  getApnsCredentials,
  normalizeKey,
  prepare,
  resetApnsCache,
  sendApnsAlert,
} from '../../../server/services/push/apns';

function p8(): string {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey as unknown as string;
}

function signs(pem: string): boolean {
  try {
    jwt.sign({}, pem, { algorithm: 'ES256', issuer: 'TEAM123456', keyid: 'ABC123DEFG' });
    return true;
  } catch {
    return false;
  }
}

const ENV_KEYS = [
  'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID', 'APNS_PRIVATE_KEY', 'APNS_PRIVATE_KEY_BASE64',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function useKey(value: string, variable: 'APNS_PRIVATE_KEY' | 'APNS_PRIVATE_KEY_BASE64' = 'APNS_PRIVATE_KEY') {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.APNS_KEY_ID = 'ABC123DEFG';
  process.env.APNS_TEAM_ID = 'TEAM123456';
  process.env.APNS_BUNDLE_ID = 'com.webyar.ai';
  process.env[variable] = value;
  resetApnsCache();
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetApnsCache();
});

describe('APNs key — every shape a pasted key arrives in', () => {
  const pem = p8();
  const body = pem.split('\n').filter((line) => line && !line.startsWith('-----')).join('');
  const shapes: Record<string, string> = {
    'the file as it is': pem,
    'Windows line endings': pem.replace(/\n/g, '\r\n'),
    'line breaks written as \\n': pem.replace(/\n/g, '\\n'),
    'line breaks turned into spaces': pem.trim().replace(/\n/g, ' '),
    'line breaks dropped': pem.trim().replace(/\n/g, ''),
    'still in its quotes': `"${pem}"`,
    'base64 of the file': Buffer.from(pem).toString('base64'),
    'base64 of the file, wrapped at 76': Buffer.from(pem).toString('base64').replace(/(.{76})/g, '$1\n'),
    'the body alone, without its marker lines': body,
  };

  for (const [shape, value] of Object.entries(shapes)) {
    it(`signs from ${shape}`, () => {
      // Signing is the one test that matters: it is what threw in production.
      expect(signs(normalizeKey(value))).toBe(true);
    });
  }

  it('is configured from a key whose line breaks became spaces', () => {
    useKey(pem.trim().replace(/\n/g, ' '));
    expect(getApnsCredentials()).not.toBeNull();
    expect(getApnsCredentialProblem()).toBeNull();
  });

  it('is configured from base64 of the file in the _BASE64 variable', () => {
    useKey(Buffer.from(pem).toString('base64'), 'APNS_PRIVATE_KEY_BASE64');
    expect(getApnsCredentials()).not.toBeNull();
  });
});

describe('APNs key — set, but not a key', () => {
  it('says so, rather than calling it missing', () => {
    useKey('-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n');
    expect(getApnsCredentials()).toBeNull();
    expect(getApnsCredentialProblem()).toBe('invalid_key');
  });

  it('refuses a key that is not the EC key Apple issues', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    useKey(privateKey as unknown as string);
    expect(getApnsCredentialProblem()).toBe('invalid_key');
  });

  it('is simply not configured when nothing is set — not a problem', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    resetApnsCache();
    expect(getApnsCredentials()).toBeNull();
    expect(getApnsCredentialProblem()).toBeNull();
  });

  it('answers a send with an outcome, never a throw', async () => {
    useKey('-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n');
    await expect(sendApnsAlert({ token: 'abc', title: 't', body: 'b', data: {} }))
      .resolves.toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('APNs request — a build that throws is an outcome', () => {
  it('turns the throw into a failed send the dispatch can log and move past', () => {
    const outcome = prepare(() => {
      throw new Error('secretOrPrivateKey must be an asymmetric key when using ES256');
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'request_failed: secretOrPrivateKey must be an asymmetric key when using ES256',
    });
  });
});
