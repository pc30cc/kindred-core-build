/**
 * C7 / C9 — production defaults must be safe even when an env var is missing.
 *
 * C7: the server image sets NODE_ENV=production; independently, the session
 *     cookie is Secure unless the process is explicitly local, and the widget
 *     identity verification code is only echoed behind an explicit opt-in.
 * C9: docker-compose's Centrifugo has no public default secrets, no admin UI,
 *     no `*` origin default, and is published on loopback only.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { setSessionCookie } from '../../../server/services/auth/sessions';

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({}) }));

const read = (p: string) => readFileSync(p, 'utf8');

function cookieSecure(): unknown {
  let opts: Record<string, unknown> = {};
  setSessionCookie(
    { cookie: (_n, _v, o) => { opts = o; }, clearCookie: () => undefined },
    'tok',
    new Date(Date.now() + 60_000),
  );
  return opts.secure;
}

describe('C7 — session cookie is Secure by default', () => {
  const env = { NODE_ENV: process.env.NODE_ENV, APP_BASE_URL: process.env.APP_BASE_URL };
  afterEach(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is Secure when NODE_ENV is missing', () => {
    delete process.env.NODE_ENV;
    delete process.env.APP_BASE_URL;
    expect(cookieSecure()).toBe(true);
  });

  it('is Secure for an unknown NODE_ENV with a public base URL', () => {
    process.env.NODE_ENV = 'staging';
    process.env.APP_BASE_URL = 'https://app.example.com';
    expect(cookieSecure()).toBe(true);
  });

  it('is Secure in production even with a localhost base URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_BASE_URL = 'http://localhost:5173';
    expect(cookieSecure()).toBe(true);
  });

  it('is not Secure for explicit local dev (NODE_ENV=development)', () => {
    process.env.NODE_ENV = 'development';
    expect(cookieSecure()).toBe(false);
  });

  it('is not Secure when NODE_ENV is unset but the app is on http://localhost', () => {
    delete process.env.NODE_ENV;
    process.env.APP_BASE_URL = 'http://localhost:5173';
    expect(cookieSecure()).toBe(false);
  });
});

describe('C7 — widget identity dev_token is opt-in only', () => {
  const src = read('server/routes/widgetIdentity.ts');

  it('is gated on WIDGET_IDENTITY_DEV_TOKEN=1 and never in production', () => {
    expect(src).toContain("process.env.WIDGET_IDENTITY_DEV_TOKEN === '1' && process.env.NODE_ENV !== 'production'");
    expect(src).toContain('...(isWidgetIdentityDevTokenEnabled() ? { dev_token: result.rawToken } : {})');
    expect(src).not.toMatch(/const isDev = process\.env\.NODE_ENV !== 'production'/);
  });
});

describe('C7 — Dockerfile.server runs with NODE_ENV=production', () => {
  const df = read('Dockerfile.server');
  it('sets NODE_ENV=production after the dependency install', () => {
    const envIdx = df.indexOf('ENV NODE_ENV=production');
    expect(envIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeGreaterThan(df.indexOf('RUN npm install'));
    expect(envIdx).toBeLessThan(df.indexOf('CMD '));
  });
});

describe('C9 — docker-compose Centrifugo has no public defaults', () => {
  const compose = read('docker-compose.yml');
  const svc = compose.slice(compose.indexOf('  centrifugo:\n'), compose.indexOf('  # ────', compose.indexOf('  centrifugo:\n')));
  const active = svc.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('has no default secrets', () => {
    expect(active).not.toMatch(/please-change-me|changeme/i);
    expect(active).toContain('${CENTRIFUGO_TOKEN_HMAC_SECRET:?');
    expect(active).toContain('${CENTRIFUGO_API_KEY:?');
  });

  it('does not enable the admin UI', () => {
    expect(active).not.toContain('--admin');
    expect(active).not.toMatch(/CENTRIFUGO_ADMIN/);
  });

  it('requires explicit allowed origins (no `*` default)', () => {
    expect(active).toContain('${CENTRIFUGO_ALLOWED_ORIGINS:?');
    expect(active).not.toMatch(/CENTRIFUGO_ALLOWED_ORIGINS:-\*/);
  });

  it('publishes the port on loopback only', () => {
    expect(active).toContain('"127.0.0.1:${CENTRIFUGO_PORT:-8000}:8000"');
    expect(active).not.toMatch(/-\s*"\$\{CENTRIFUGO_PORT:-8000\}:8000"/);
  });

  it('documents the required variables in .env.docker.example', () => {
    const env = read('.env.docker.example');
    for (const k of ['CENTRIFUGO_TOKEN_HMAC_SECRET=', 'CENTRIFUGO_API_KEY=', 'CENTRIFUGO_ALLOWED_ORIGINS=']) {
      expect(env).toContain(k);
    }
  });
});
