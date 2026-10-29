/**
 * Canonical contract for a stored workspace widget domain.
 *
 * The origin resolver probes an INDEXED generated column, so the API must
 * never store a value that column cannot reduce to a plain hostname.
 */
import { describe, it, expect } from 'vitest';
import { parseWorkspaceDomainInput, registrableDomain } from '../../../server/utils/workspaceDomainInput.js';

function ok(input: string) {
  const r = parseWorkspaceDomainInput(input);
  expect(r.ok, `${input} should be accepted: ${r.ok === false ? r.message : ''}`).toBe(true);
  return r.ok === false ? '' : r.domain;
}

function rejected(input: string, code: string) {
  const r = parseWorkspaceDomainInput(input);
  expect(r.ok, `${input} should be rejected`).toBe(false);
  expect(r.ok === false ? r.code : null).toBe(code);
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

  it('rejects a public suffix (the private part of the list too), never a site under one', () => {
    // A wildcard rule's name (x.kawasaki.jp) is a suffix too; in punycode or Unicode, any case.
    for (const suffix of ['com.tr', 'co.ir', 'https://www.CO.UK/', 'vercel.app', 'myshopify.com', 'github.io', 'ایران.ir', 'XN--MGBA3A4F16A.IR', 'x.kawasaki.jp']) {
      rejected(suffix, 'MALFORMED');
    }
    expect(ok('My-Shop.com.tr')).toBe('my-shop.com.tr');
    expect(ok('bakery.co.ir')).toBe('bakery.co.ir');
    expect(ok('shop.vercel.app')).toBe('shop.vercel.app');
    expect(ok('a.b.github.io')).toBe('a.b.github.io');
    expect(ok('فروشگاه.ایران.ir')).toBe('xn--mgbtj4c7ad63e.xn--mgba3a4f16a.ir');
    expect(ok('city.kawasaki.jp')).toBe('city.kawasaki.jp');
    // The base of a wildcard rule (*.paywhirl.com) is a site; the name under it is a suffix.
    expect(ok('paywhirl.com')).toBe('paywhirl.com');
    expect(ok('https://www.Uberspace.de/')).toBe('uberspace.de');
    rejected('x.paywhirl.com', 'MALFORMED');
    expect(ok('a.x.paywhirl.com')).toBe('a.x.paywhirl.com');
    // Every leading www. goes before the check, as the row's normalize steps strip them.
    for (const suffix of ['www.www.www.com.tr', 'WWW.www.WWW.co.ir', 'www.www.www.github.io', 'www.www.www.www.vercel.app']) {
      rejected(suffix, 'MALFORMED');
    }
    // A TLD the list does not know, as before.
    expect(ok('shop.example')).toBe('shop.example');
    expect(ok('Printer.Local')).toBe('printer.local');
  });

  it('registrableDomain: the site a host belongs to, null for a public suffix', () => {
    expect(registrableDomain('a.b.shop.com.tr')).toBe('shop.com.tr');
    expect(registrableDomain('a.b.github.io')).toBe('b.github.io');
    expect(registrableDomain('x.y.ninisite.com')).toBe('ninisite.com');
    expect(registrableDomain('shop.xn--mgba3a4f16a.ir')).toBe('shop.xn--mgba3a4f16a.ir');
    expect(registrableDomain('a.shop.example')).toBe('shop.example');
    expect(registrableDomain('a.printer.local')).toBe('printer.local');
    expect(registrableDomain('paywhirl.com')).toBe('paywhirl.com');
    expect(registrableDomain('a.b.paywhirl.com')).toBe('a.b.paywhirl.com');
    for (const suffix of ['com.tr', 'github.io', 'xn--mgba3a4f16a.ir', 'x.kawasaki.jp', 'x.paywhirl.com', 'com', 'example', 'local']) {
      expect(registrableDomain(suffix), suffix).toBeNull();
    }
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
