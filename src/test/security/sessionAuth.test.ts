import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  setSessionCookie,
  clearSessionCookie,
  verifyOriginForMutation,
  SESSION_COOKIE_NAME,
} from '../../../server/services/auth/sessions';

function mockRes() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
}

describe('sessions.ts — cookie configuration', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('setSessionCookie sets an HttpOnly cookie under the expected name', () => {
    const res = mockRes();
    setSessionCookie(res, 'raw-token-value', new Date(Date.now() + 60_000));
    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, value, options] = res.cookie.mock.calls[0];
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(value).toBe('raw-token-value');
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe('/');
    expect(typeof options.maxAge).toBe('number');
    expect(options.maxAge).toBeGreaterThan(0);
  });

  it('sets Secure in production', () => {
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    setSessionCookie(res, 'raw-token-value', new Date(Date.now() + 60_000));
    const options = res.cookie.mock.calls[0][2];
    expect(options.secure).toBe(true);
  });

  it('does not force Secure outside production (so local http dev still works)', () => {
    process.env.NODE_ENV = 'development';
    const res = mockRes();
    setSessionCookie(res, 'raw-token-value', new Date(Date.now() + 60_000));
    const options = res.cookie.mock.calls[0][2];
    expect(options.secure).toBe(false);
  });

  it('clearSessionCookie clears the cookie under the same name used to set it', () => {
    const res = mockRes();
    clearSessionCookie(res);
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
    expect(res.clearCookie.mock.calls[0][0]).toBe(SESSION_COOKIE_NAME);
  });
});

describe('sessions.ts — verifyOriginForMutation (CSRF defense-in-depth)', () => {
  it('allows a request with no Origin header (nothing to check against)', () => {
    expect(verifyOriginForMutation({ headers: {} }, ['https://app.example.com'])).toBe(true);
  });

  it('allows a matching same-site Origin', () => {
    const req = { headers: { origin: 'https://app.example.com' } };
    expect(verifyOriginForMutation(req, ['https://app.example.com'])).toBe(true);
  });

  it('rejects a cross-site Origin not in the allow-list', () => {
    const req = { headers: { origin: 'https://evil.example.com' } };
    expect(verifyOriginForMutation(req, ['https://app.example.com'])).toBe(false);
  });

  it('allows any Origin when the operator explicitly configured a wildcard', () => {
    const req = { headers: { origin: 'https://anything.example.com' } };
    expect(verifyOriginForMutation(req, ['*'])).toBe(true);
  });

  it('rejects when corsOrigins is empty (no origin is trusted)', () => {
    const req = { headers: { origin: 'https://app.example.com' } };
    expect(verifyOriginForMutation(req, [])).toBe(false);
  });
});
