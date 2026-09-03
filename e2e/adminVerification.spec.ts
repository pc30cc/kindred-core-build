import { test, expect, type Page } from '@playwright/test';

/**
 * Generic Verification Core Super Admin page — real-browser authorization
 * boundary. Mirrors the exact pattern already proven in e2e/invitations.spec.ts:
 * no seeded session, drive Chromium against the running self-hosted stack,
 * and assert the unauthenticated redirect.
 *
 * KNOWN GAP (documented, not silently skipped): the authenticated
 * interactive scenarios called for in this pass — a real Super Admin
 * session exercising overview/editing/reset/revision-conflict/policy-
 * weakening-validation/audit-display/sandboxed-preview, a workspace
 * owner/admin session receiving 403, and fa/tr/en RTL/LTR checks on the
 * authenticated page — were NOT implemented in this round. They require
 * booting a full authenticated dev+backend stack (seeded profiles,
 * sessions, and a platform-admin role) and this repository has no existing
 * seed/login harness for Playwright to build on (e2e/invitations.spec.ts
 * itself only covers the unauthenticated case). Building that harness from
 * scratch was judged out of scope for the time invested in this pass; the
 * equivalent behavior is instead proven by the real-Postgres + real-Express
 * integration suite (src/test/integration/genericVerificationAdminSettings.pg.test.ts),
 * which exercises the identical HTTP → Zod → service → RPC → database path
 * end to end, just not through an actual browser.
 */

async function withSiteDefault(page: Page, locale: 'en' | 'fa' | 'tr') {
  await page.route('**/runtime-config.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.__APP_RUNTIME_CONFIG__ = { apiBaseUrl: "", defaultLocale: "${locale}" };`,
    });
  });
}

test.describe('admin verification page — authorization boundary', () => {
  test('is not reachable without a session', async ({ page }) => {
    await withSiteDefault(page, 'en');
    await page.goto('/admin/verification', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    expect(page.url()).toMatch(/\/auth\/login|\/login/);
  });

  test('the unauthenticated redirect never exposes a secret in the URL', async ({ page }) => {
    await withSiteDefault(page, 'en');
    await page.goto('/admin/verification', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    expect(page.url()).not.toMatch(/pepper/i);
    expect(page.url()).not.toMatch(/service[_-]?role/i);
  });
});
