import { test, expect, type Page } from '@playwright/test';

/**
 * Section F — real browser coverage for the invitation surfaces.
 *
 * These specs drive Chromium against the running self-hosted stack. They
 * assert the language contract (fa/tr/en, RTL/LTR, no raw keys, no English
 * flash), the v5.1 token hygiene rules and the authorization gate on the
 * management surface. Scenarios that require a seeded pending invitation are
 * grouped under `E2E_INVITE_SEED` so they never touch a production database.
 */

type Locale = 'en' | 'fa' | 'tr';

const EXPECTED_DIR: Record<Locale, 'rtl' | 'ltr'> = { en: 'ltr', fa: 'rtl', tr: 'ltr' };

/** Serves a deployment runtime-config with the given configured site default. */
async function withSiteDefault(page: Page, locale: Locale) {
  await page.route('**/runtime-config.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.__APP_RUNTIME_CONFIG__ = { apiBaseUrl: "", defaultLocale: "${locale}" };`,
    });
  });
}

/** No raw translation key (`a.b.c`) may be rendered anywhere on the page. */
async function expectNoRawKeys(page: Page) {
  const text = await page.locator('body').innerText();
  const rawKey = text.match(/\b(?:invite|invitations|common|auth)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/);
  expect(rawKey, `raw translation key rendered: ${rawKey?.[0]}`).toBeNull();
}

for (const locale of ['fa', 'tr', 'en'] as Locale[]) {
  test.describe(`invite page — ${locale}`, () => {
    test('configured site default is active on first render with the right direction', async ({ page }) => {
      await withSiteDefault(page, locale);
      // A browser language that contradicts the configured default must NOT win.
      await page.context().setExtraHTTPHeaders({ 'Accept-Language': locale === 'en' ? 'fa-IR,fa' : 'en-US,en' });
      await page.goto('/invite', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body :text-matches(".+")');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('html')).toHaveAttribute('dir', EXPECTED_DIR[locale]);
    });

    test('an unusable invitation shows a localized error, never a code or key', async ({ page }) => {
      await withSiteDefault(page, locale);
      await page.goto('/invite#token=deadbeefdeadbeefdeadbeefdeadbeef', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await expectNoRawKeys(page);
      const body = await page.locator('body').innerText();
      expect(body).not.toContain('INVITATION_NOT_FOUND');
      expect(body.trim().length).toBeGreaterThan(10);
    });

    test('the fragment token is erased and never persisted or exposed', async ({ page }) => {
      await withSiteDefault(page, locale);
      const secret = 'e2e-secret-token-abcdef0123456789';
      await page.goto(`/invite#token=${secret}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);

      expect(page.url()).not.toContain(secret);
      expect(page.url()).not.toContain('#token');

      const leaked = await page.evaluate((needle) => {
        const dump = (s: Storage) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`).join('|');
        return {
          local: dump(localStorage).includes(needle),
          session: dump(sessionStorage).includes(needle),
          cookie: document.cookie.includes(needle),
          dom: document.documentElement.outerHTML.includes(needle),
        };
      }, secret);
      expect(leaked).toEqual({ local: false, session: false, cookie: false, dom: false });
    });
  });
}

test.describe('invitation management authorization', () => {
  test('the management surface is not reachable without a session', async ({ page }) => {
    await withSiteDefault(page, 'fa');
    await page.goto('/app/w/e2e-probe/settings/team-departments', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    // Unauthenticated visitors are bounced to the first-party login surface.
    expect(page.url()).toMatch(/\/auth\/login|\/login/);

  });
});
