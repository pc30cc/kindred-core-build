/**
 * The sign-in pages' `?redirect=` (src/lib/inAppRedirect.ts): react-router-dom
 * 6 sends `/\evil.example` to pushState, which a browser reads as
 * `//evil.example` and the router then opens with location.assign
 * (GHSA-wrjc-x8rr-h8h6, fixed only in react-router 7.18). Only a path on this
 * page's own scheme and host passes.
 */
import { describe, it, expect } from 'vitest';
import { inAppRedirect } from '@/lib/inAppRedirect';

const WEB = 'https://app.webyar.ai/auth/login?redirect=x';
const IOS = 'capacitor://localhost/auth/login';
const ANDROID = 'https://localhost/auth/login';

describe('inAppRedirect', () => {
  it('keeps a path inside the app, with its query and hash', () => {
    expect(inAppRedirect('/app', '/app', WEB)).toBe('/app');
    expect(inAppRedirect('/app/inbox?c=42#m-7', '/app', WEB)).toBe('/app/inbox?c=42#m-7');
    expect(inAppRedirect('/invite', '/app', IOS)).toBe('/invite');
    expect(inAppRedirect('/app/settings', '/app', ANDROID)).toBe('/app/settings');
  });

  it('falls back when there is nothing to go to', () => {
    expect(inAppRedirect(null, '/app', WEB)).toBe('/app');
    expect(inAppRedirect(undefined, '/app', WEB)).toBe('/app');
    expect(inAppRedirect('', '/app', WEB)).toBe('/app');
  });

  it('never leaves the site', () => {
    for (const raw of [
      '/\\evil.example/x',
      '/\\/evil.example',
      '//evil.example/x',
      '/\t/evil.example/x',
      '/\n/evil.example',
      '/.//evil.example',
      'https://evil.example/x',
      '\\\\evil.example',
      'javascript:alert(1)',
      'evil.example',
    ]) {
      expect(inAppRedirect(raw, '/app', WEB), JSON.stringify(raw)).toBe('/app');
    }
    // A backslash after the first slash is a path character in the iOS
    // shell's capacitor:// URL, so it stays on that page.
    expect(new URL(inAppRedirect('/\\evil.example', '/app', IOS), IOS).host).toBe('localhost');
  });

  it('reads the page address by default', () => {
    expect(inAppRedirect('/app/inbox', '/app')).toBe('/app/inbox');
    expect(inAppRedirect('/\\evil.example', '/app')).toBe('/app');
  });
});
