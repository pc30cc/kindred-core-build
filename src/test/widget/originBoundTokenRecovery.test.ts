/**
 * Origin-bound widget session tokens — recovery contract.
 *
 * A widget token minted for https://site-a.com must never work from
 * https://site-b.com (server-side ORIGIN_MISMATCH stays intact). The LOADER
 * side of that contract is what this file pins down: when the current
 * credential is structurally unusable for the current origin, the widget
 * must DISCARD it and bootstrap a brand-new origin-bound token from the
 * CURRENT browser origin — never migrate the old token across origins, and
 * never turn the failure into a bootstrap storm.
 *
 * public/widget/{loader,runtime}.js are monolithic browser IIFEs with no vm
 * harness in this repo, so — like every other loader/runtime test here —
 * these are structural assertions on the shipped source.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const loader = fs.readFileSync(path.resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
const runtime = fs.readFileSync(path.resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');

describe('runtime.js — unusable credentials trigger a fresh origin-bound bootstrap', () => {
  it('treats ORIGIN_MISMATCH and expired_beyond_grace as HARD (discard-then-bootstrap) failures', () => {
    expect(runtime).toContain("var hard = code === 'ORIGIN_MISMATCH' || code === 'expired_beyond_grace';");
    // ...and they are recoverable, not silently fatal.
    expect(runtime).toContain('var refreshable = hard ||');
    expect(runtime).toContain('return retryAfterRecovery(hard);');
  });

  it('still refreshes the ordinary token failures', () => {
    for (const code of ['TOKEN_EXPIRED', 'INVALID_TOKEN', 'MISSING_TOKEN']) {
      expect(runtime).toContain(`code === '${code}'`);
    }
  });

  it('a hard failure discards the token instead of refreshing it', () => {
    expect(runtime).toContain('if (opts && opts.discardToken) {');
    expect(runtime).toContain('return recoverSession(true);');
    // The soft path is still refresh-first.
    expect(runtime).toContain('return refresh().then(function (t) { return t; }, function () { return recoverSession(false); });');
  });

  it('bounds recovery to a single retry per request — no loops', () => {
    expect(runtime).toContain('var recoveryRetries = 0;');
    expect(runtime).toContain('var MAX_RECOVERY_RETRIES = 1;');
    expect(runtime).toContain('if (recoveryRetries >= MAX_RECOVERY_RETRIES) return Promise.resolve(r);');
    expect(runtime).toContain('recoveryRetries += 1;');
  });
});

describe('loader.js — the shared token bus mints from the CURRENT origin only', () => {
  it('bootstrap always sends the live browser origin', () => {
    expect(loader).toContain("JSON.stringify({ workspace_id: cfg.workspaceId, origin: window.location.origin })");
  });

  it('exposes discard(), and hard recovery discards before bootstrapping', () => {
    expect(loader).toContain('bus.discard = function ()');
    expect(loader).toContain('var hard = !!(opts && opts.discardToken);');
    expect(loader).toContain('bus.discard();');
    expect(loader).toContain('start = bus.bootstrap({ force: true });');
  });

  it('caps bootstraps in a rolling window even when forced', () => {
    expect(loader).toContain('var BOOTSTRAP_WINDOW_MS = 60000;');
    expect(loader).toContain('var MAX_BOOTSTRAPS_PER_WINDOW = 4;');
    expect(loader).toContain('if (bootstrapsInWindow >= MAX_BOOTSTRAPS_PER_WINDOW) return Promise.resolve(null);');
    // The ceiling is checked BEFORE the force-bypassed cooldown.
    const ceiling = loader.indexOf('if (bootstrapsInWindow >= MAX_BOOTSTRAPS_PER_WINDOW)');
    const cooldown = loader.indexOf('if (!force && now - lastBootstrapAt < BOOTSTRAP_COOLDOWN_MS)');
    expect(ceiling).toBeGreaterThan(-1);
    expect(cooldown).toBeGreaterThan(ceiling);
  });

  it('never reuses a token across origins — recovery re-bootstraps, it does not re-sign', () => {
    expect(loader).not.toMatch(/migrate[A-Za-z]*Token/);
    expect(loader).not.toContain('previousOrigin');
  });
});
