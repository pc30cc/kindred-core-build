/**
 * Canonical contract for a stored workspace widget domain.
 *
 * The origin resolver probes an INDEXED generated column, so the API must
 * never store a value that column cannot reduce to a plain hostname.
 */
import { describe, it, expect } from 'vitest';
import { parseWorkspaceDomainInput } from '../../../server/utils/workspaceDomainInput.js';

function ok(input: string) {
  const r = parseWorkspaceDomainInput(input);
  expect(r.ok, `${input} should be accepted: ${(r as any).message}`).toBe(true);
  return (r as any).domain as string;
}

function rejected(input: string, code: string) {
  const r = parseWorkspaceDomainInput(input);
  expect(r.ok, `${input} should be rejected`).toBe(false);
  expect((r as any).code).toBe(code);
}

describe('parseWorkspaceDomainInput', () => {
  it('canonicalizes accepted forms to a bare lowercase hostname', () => {
    expect(ok('Example.com')).toBe('example.com');
    expect(ok(' example.com ')).toBe('example.com');
    expect(ok('https://example.com')).toBe('example.com');
    expect(ok('http://WWW.Example.com/')).toBe('example.com');
    expect(ok('shop.example.co.uk')).toBe('shop.example.co.uk');
  });

  it('converts internationalized domains to punycode', () => {
    expect(ok('مثال.com')).toBe('xn--mgbh0fb.com');
    expect(ok('https://füße.de')).toBe('xn--fe-gia9i.de');
  });

  it('rejects wildcards — subdomains are a per-workspace switch', () => {
    rejected('*.example.com', 'WILDCARD_NOT_ALLOWED');
    rejected('ex*ample.com', 'WILDCARD_NOT_ALLOWED');
  });

  it('rejects non-http schemes and embedded credentials', () => {
    rejected('ftp://example.com', 'INVALID_SCHEME');
    rejected('javascript://example.com', 'INVALID_SCHEME');
    rejected('user:pass@example.com', 'USERINFO_NOT_ALLOWED');
    rejected('user@example.com', 'USERINFO_NOT_ALLOWED');
  });

  it('rejects paths, query strings and fragments', () => {
    rejected('example.com/widget', 'PATH_NOT_ALLOWED');
    rejected('example.com?a=1', 'PATH_NOT_ALLOWED');
    rejected('example.com#x', 'PATH_NOT_ALLOWED');
  });

  it('rejects ports and IP literals', () => {
    rejected('example.com:8080', 'PORT_NOT_ALLOWED');
    rejected('[::1]', 'PORT_NOT_ALLOWED');
    rejected('192.168.1.10', 'IP_NOT_ALLOWED');
    rejected('8.8.8.8', 'IP_NOT_ALLOWED');
  });

  it('rejects localhost', () => {
    rejected('localhost', 'LOCALHOST_NOT_ALLOWED');
    rejected('app.localhost', 'LOCALHOST_NOT_ALLOWED');
  });

  it('rejects misplaced dots, whitespace and single-label values', () => {
    rejected('.example.com', 'MALFORMED');
    rejected('example.com.', 'MALFORMED');
    rejected('exa..mple.com', 'MALFORMED');
    rejected('exa mple.com', 'WHITESPACE');
    rejected('example', 'MALFORMED');
    rejected('example.c', 'MALFORMED');
    rejected('', 'EMPTY');
  });

  it('every accepted value survives the database normalization expression', () => {
    const dbNormalize = (v: string) =>
      v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[:/?#].*$/, '').replace(/^www\./, '');
    for (const input of ['Example.com', 'https://www.Shop.example.com/', 'مثال.com']) {
      const stored = ok(input);
      expect(dbNormalize(stored)).toBe(stored);
    }
  });
});
