/**
 * robots.txt redirect policy: same-origin always, plus the single safe
 * HTTP -> HTTPS upgrade on the identical host. Everything else is refused.
 */
import { describe, it, expect } from 'vitest';
import { isRobotsRedirectAllowed } from '../../../server/services/ai-agent/crawler/robots.js';

const allow = (root: string, candidate: string) => {
  const r = new URL(root);
  return isRobotsRedirectAllowed(candidate, r, r.origin);
};

describe('robots redirect policy', () => {
  it('allows same-origin', () => {
    expect(allow('https://ex.com', 'https://ex.com/robots.txt')).toBe(true);
  });
  it('allows the http -> https upgrade on the same host', () => {
    expect(allow('http://ex.com', 'https://ex.com/robots.txt')).toBe(true);
    expect(allow('http://ex.com:80', 'https://ex.com:443/robots.txt')).toBe(true);
  });
  it('refuses the https -> http downgrade', () => {
    expect(allow('https://ex.com', 'http://ex.com/robots.txt')).toBe(false);
  });
  it('refuses cross-host and subdomain hops', () => {
    expect(allow('http://ex.com', 'https://evil.com/robots.txt')).toBe(false);
    expect(allow('http://ex.com', 'https://www.ex.com/robots.txt')).toBe(false);
    expect(allow('https://ex.com', 'https://ex.com.evil.com/robots.txt')).toBe(false);
  });
  it('refuses non-default ports on the upgrade path', () => {
    expect(allow('http://ex.com', 'https://ex.com:8443/robots.txt')).toBe(false);
    expect(allow('http://ex.com:8080', 'https://ex.com/robots.txt')).toBe(false);
  });
  it('refuses non-http schemes and garbage', () => {
    expect(allow('http://ex.com', 'file:///etc/passwd')).toBe(false);
    expect(allow('http://ex.com', 'not a url')).toBe(false);
  });
});
