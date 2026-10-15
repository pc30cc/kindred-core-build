/**
 * Keys renamed to brand-neutral names (src/lib/mobileSession.ts, the native
 * shell's Keychain token): a build that ships the Iranian kit (here, `both`)
 * still finds a token kept under the old key and moves it; nobody is logged
 * out by the rename.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/native', () => ({ isNativePlatform: () => true }));

const store = new Map<string, string>();
const plugin = {
  get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
  set: vi.fn(async ({ key, value }: { key: string; value: string }) => void store.set(key, value)),
  remove: vi.fn(async ({ key }: { key: string }) => void store.delete(key)),
};

beforeEach(() => {
  vi.resetModules();
  store.clear();
  (window as unknown as { Capacitor: unknown }).Capacitor = { Plugins: { SecureStorage: plugin } };
});

describe('the native session token', () => {
  it('moves a token from the old key to the new one, once', async () => {
    store.set('webyar.session.token', 'tok-1');
    const { hydrateMobileSession } = await import('@/lib/mobileSession');
    expect(await hydrateMobileSession()).toBe('tok-1');
    expect(store.get('app.session.token')).toBe('tok-1');
    expect(store.has('webyar.session.token')).toBe(false);
  });

  it('prefers the new key and clears both on sign-out', async () => {
    store.set('app.session.token', 'tok-new');
    store.set('webyar.session.token', 'tok-old');
    const { hydrateMobileSession, clearMobileSessionToken } = await import('@/lib/mobileSession');
    expect(await hydrateMobileSession()).toBe('tok-new');
    await clearMobileSessionToken();
    expect(store.size).toBe(0);
  });
});
