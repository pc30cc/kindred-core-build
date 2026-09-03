/**
 * Generic Verification Core Super Admin UI — template preview iframe must
 * stay a fully locked-down sandbox. The preview renders HTML built from
 * the same templates a real send would use, so it must never be able to
 * run scripts, reach cookies/storage, navigate the parent, submit a form,
 * or open a popup — an empty `sandbox` attribute (no allow-* tokens at
 * all) is the only value that guarantees that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Generic Verification Core admin UI — template preview iframe sandbox', () => {
  const src = readFileSync('src/pages/admin/VerificationPage.tsx', 'utf8');

  it('renders exactly one iframe, with an explicit empty sandbox attribute', () => {
    const iframeMatches = src.match(/<iframe\b[^>]*\/>/g) ?? [];
    expect(iframeMatches).toHaveLength(1);
    expect(iframeMatches[0]).toMatch(/\bsandbox=""/);
  });

  it('never grants allow-scripts', () => {
    expect(src).not.toMatch(/allow-scripts/);
  });

  it('never grants allow-same-origin', () => {
    expect(src).not.toMatch(/allow-same-origin/);
  });

  it('never grants allow-top-navigation, allow-forms, or allow-popups', () => {
    expect(src).not.toMatch(/allow-top-navigation/);
    expect(src).not.toMatch(/allow-forms/);
    expect(src).not.toMatch(/allow-popups/);
  });

  it('the iframe title is localized, not a hardcoded English string', () => {
    expect(src).not.toMatch(/title="email-preview"/);
    expect(src).toMatch(/title=\{t\('admin\.verification\.preview\.iframeTitle'/);
  });
});
