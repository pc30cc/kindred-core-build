/**
 * Core ↔ Channels credential boundary.
 *
 * The regression these lock down: a 401 used to mean either "wrong secret" or
 * "a proxy ate the Authorization header", with no way to tell them apart. The
 * Worker reported the first cause unconditionally, so an operator with a
 * perfectly correct secret was told it did not match.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  INTERNAL_SECRET_HEADER,
  constantTimeEquals,
  internalSecretFingerprint,
  presentedInternalSecret,
  requireInternalService,
} from '../../../server/lib/internalAuth.js';

const SECRET = 'a'.repeat(64);

function res() {
  const out: any = { statusCode: 200, body: null };
  out.status = (code: number) => { out.statusCode = code; return out; };
  out.json = (payload: unknown) => { out.body = payload; return out; };
  return out;
}

function req(headers: Record<string, string>, secret: string | undefined = SECRET) {
  return { headers, serverConfig: { coreInternalSecret: secret } } as any;
}

describe('presented credential transports', () => {
  it('accepts the Authorization bearer', () => {
    expect(presentedInternalSecret(req({ authorization: `Bearer ${SECRET}` }))).toBe(SECRET);
  });

  it('accepts the dedicated header when a proxy rewrote Authorization', () => {
    const r = req({ authorization: 'Basic cHJveHk6Y3JlZA==', [INTERNAL_SECRET_HEADER]: SECRET });
    expect(presentedInternalSecret(r)).toBe(SECRET);
  });

  it('returns null when no credential survived', () => {
    expect(presentedInternalSecret(req({}))).toBeNull();
  });
});

describe('requireInternalService failure modes are distinguishable', () => {
  it('authorizes a matching secret over either header', () => {
    for (const headers of [
      { authorization: `Bearer ${SECRET}` },
      { [INTERNAL_SECRET_HEADER]: SECRET },
    ]) {
      const r = res();
      expect(requireInternalService(req(headers), r)).toBe(true);
      expect(r.statusCode).toBe(200);
    }
  });

  it('reports a stripped header as missing_credential, not a mismatch', () => {
    const r = res();
    expect(requireInternalService(req({}), r)).toBe(false);
    expect(r.statusCode).toBe(401);
    expect(r.body.reason).toBe('missing_credential');
  });

  it('reports a genuinely different value as secret_mismatch', () => {
    const r = res();
    expect(requireInternalService(req({ authorization: `Bearer ${'b'.repeat(64)}` }), r)).toBe(false);
    expect(r.statusCode).toBe(401);
    expect(r.body.reason).toBe('secret_mismatch');
  });

  it('fails closed when Core has no secret configured', () => {
    const r = res();
    expect(requireInternalService(req({ authorization: `Bearer ${SECRET}` }, undefined), r)).toBe(false);
    expect(r.statusCode).toBe(503);
    expect(r.body.reason).toBe('not_configured');
  });

  it('never leaks the secret in a failure body', () => {
    const r = res();
    requireInternalService(req({ authorization: `Bearer ${'b'.repeat(64)}` }), r);
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
  });
});

describe('fingerprints', () => {
  it('is stable, short and non-reversible', () => {
    const fp = internalSecretFingerprint(SECRET)!;
    expect(fp).toHaveLength(12);
    expect(fp).toBe(internalSecretFingerprint(` ${SECRET} `));
    expect(fp).not.toContain(SECRET);
  });

  it('differs for different secrets and is null when unset', () => {
    expect(internalSecretFingerprint(SECRET)).not.toBe(internalSecretFingerprint('b'.repeat(64)));
    expect(internalSecretFingerprint('')).toBeNull();
  });

  it('the Worker derives the fingerprint identically to Core', () => {
    const worker = readFileSync(resolve(process.cwd(), 'worker/channels/index.ts'), 'utf8');
    expect(worker).toContain('`core-internal-secret:${secret}`');
    expect(worker).toContain(".slice(0, 12)");
  });
});

describe('constant-time comparison', () => {
  it('rejects length mismatches and non-strings without throwing', () => {
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals(null, 'abc')).toBe(false);
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
  });
});

describe('callers send both transports', () => {
  const worker = readFileSync(resolve(process.cwd(), 'worker/channels/index.ts'), 'utf8');
  const gateway = readFileSync(resolve(process.cwd(), 'channels/server.ts'), 'utf8');

  it('worker and gateway both send X-Core-Internal-Secret alongside the bearer', () => {
    for (const source of [worker, gateway]) {
      expect(source).toContain("'X-Core-Internal-Secret'");
      expect(source).toContain('Authorization: `Bearer ${');
    }
  });

  it('worker consults the diagnostic endpoint before blaming the secret', () => {
    expect(worker).toContain('/internal/channels/auth-diagnostic');
    expect(worker).toContain('fingerprint_matches');
  });
});
