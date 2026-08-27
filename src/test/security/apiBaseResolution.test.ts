import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveApiBase } from '@/lib/apiBase';

describe('resolveApiBase', () => {
  it('falls back to same origin when VITE_API_BASE_URL is absent', () => {
    expect(resolveApiBase(undefined)).toBe('');
    expect(resolveApiBase('')).toBe('');
    expect(resolveApiBase('   ')).toBe('');
    // stringified misconfiguration must never reach fetch()
    expect(resolveApiBase('undefined')).toBe('');
  });

  it('same-origin base produces valid auth paths (never undefined/api/...)', () => {
    const base = resolveApiBase(undefined);
    expect(`${base}/api/auth/login`).toBe('/api/auth/login');
    expect(`${base}/api/auth-email/send-reset`).toBe('/api/auth-email/send-reset');
  });

  it('keeps an explicitly configured absolute API base', () => {
    const base = resolveApiBase('https://api.example.com');
    expect(`${base}/api/auth/login`).toBe('https://api.example.com/api/auth/login');
  });

  it('normalizes trailing slashes so no double slash is produced', () => {
    expect(`${resolveApiBase('https://api.example.com/')}/api/auth/login`).toBe(
      'https://api.example.com/api/auth/login',
    );
    expect(`${resolveApiBase('https://api.example.com///')}/api/auth-email/send-reset`).toBe(
      'https://api.example.com/api/auth-email/send-reset',
    );
  });

  it('accepts an API base configured with a trailing /api path', () => {
    expect(`${resolveApiBase('https://api.example.com/api')}/api/auth/login`).toBe(
      'https://api.example.com/api/auth/login',
    );
    expect(`${resolveApiBase('https://api.example.com/api/')}/api/widget-settings/platform/config`).toBe(
      'https://api.example.com/api/widget-settings/platform/config',
    );
  });
});

describe('auth email API transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('sends the reset request to the resolved base with credentials included', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { sendResetEmail } = await import('@/lib/auth-email-api');
    await sendResetEmail('user@example.com', 'fa');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).endsWith('/api/auth-email/send-reset')).toBe(true);
    expect(String(url)).not.toContain('undefined');
    expect(init.credentials).toBe('include');
  });
});
