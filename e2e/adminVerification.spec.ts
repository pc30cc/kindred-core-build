import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generic Verification Core — Super Admin page, real-browser acceptance.
 *
 * Two modes:
 *  - Default (E2E_FULL_STACK unset): only the unauthenticated boundary,
 *    against whatever stack is already running on baseURL. This is the
 *    original, always-cheap check.
 *  - E2E_FULL_STACK=1: playwright.config.ts's globalSetup
 *    (e2e/harness/setupFullStack.ts) boots a real, disposable Postgres +
 *    PostgREST + Express stack and seeds two real sessions (a platform
 *    Super Admin and a workspace owner/admin who is NOT a platform admin).
 *    This file then drives real Chromium against the real rendered app for
 *    every authenticated scenario. No module is mocked in that stack.
 */

const RUNTIME_FILE = path.join(__dirname, 'harness', '.runtime.json');
const fullStack = process.env.E2E_FULL_STACK === '1';

interface Runtime {
  ports: { postgrest: number; express: number; proxy: number };
  superAdmin: { userId: string; token: string };
  workspaceAdmin: { userId: string; token: string; workspaceId: string };
}

function loadRuntime(): Runtime {
  if (!existsSync(RUNTIME_FILE)) {
    throw new Error(`${RUNTIME_FILE} missing — globalSetup did not run (is E2E_FULL_STACK=1 set?)`);
  }
  return JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'));
}

async function withSiteDefault(page: Page, locale: 'en' | 'fa' | 'tr') {
  await page.route('**/runtime-config.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.__APP_RUNTIME_CONFIG__ = { apiBaseUrl: "", defaultLocale: "${locale}" };`,
    });
  });
}

async function seedSessionCookie(context: BrowserContext, token: string, port: number) {
  await context.addCookies([
    {
      name: 'gs_session',
      value: token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  void port;
}

test.describe('admin verification page — authorization boundary (no seeded session required)', () => {
  test('is not reachable without a session', async ({ page }) => {
    await withSiteDefault(page, 'en');
    await page.goto('/admin/verification', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});

test.describe('admin verification page — authenticated (E2E_FULL_STACK=1)', () => {
  test.skip(!fullStack, 'requires E2E_FULL_STACK=1 (real Postgres + PostgREST + Express harness)');

  let runtime: Runtime;
  let db: Pool;

  test.beforeAll(() => {
    runtime = loadRuntime();
    db = new Pool({ connectionString: process.env.E2E_PG_SUPERUSER_DSN?.replace(/\/[^/]*$/, `/${process.env.E2E_DB_NAME || 'gv_e2e_stack'}`) || `postgres://app_test:app_test@127.0.0.1:5432/${process.env.E2E_DB_NAME || 'gv_e2e_stack'}` });
  });

  test.afterAll(async () => {
    await db.end();
  });

  test('a workspace owner/admin (not a platform admin) is redirected away, not shown the page', async ({ page, context }) => {
    await withSiteDefault(page, 'en');
    await seedSessionCookie(context, runtime.workspaceAdmin.token, runtime.ports.proxy);
    await page.goto('/admin/verification', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/app/, { timeout: 10_000 });
    expect(page.url()).not.toContain('/admin/verification');
  });

  test('a platform Super Admin can reach the page and it renders real overview data', async ({ page, context }) => {
    await withSiteDefault(page, 'en');
    await seedSessionCookie(context, runtime.superAdmin.token, runtime.ports.proxy);
    await page.goto('/admin/verification', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Verification & OTP' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Dormant — no consumer enabled')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Purposes' })).toBeVisible();
  });

  for (const [locale, dir] of [['fa', 'rtl'], ['tr', 'ltr'], ['en', 'ltr']] as const) {
    test(`renders with dir="${dir}" for site default locale ${locale}`, async ({ page, context }) => {
      await withSiteDefault(page, locale);
      await seedSessionCookie(context, runtime.superAdmin.token, runtime.ports.proxy);
      await page.goto('/admin/verification', { waitUntil: 'domcontentloaded' });
      const heading = locale === 'fa' ? 'تأیید هویت و رمز یکبار مصرف' : locale === 'tr' ? 'Doğrulama ve OTP' : 'Verification & OTP';
      await page.waitForSelector(`h1:has-text("${heading}")`, { timeout: 15_000 }).catch(() => {});
      const container = page.locator('h1').first().locator('xpath=ancestor::div[@dir][1]');
      await expect(container).toHaveAttribute('dir', dir, { timeout: 15_000 });
    });
  }

  // The 5 scenarios below share ONE page/session rather than each doing
  // their own page.goto — every mount fires 3+ real /api/admin/* GETs
  // (overview, audit, template preview), and adminRateLimiter (30/min/IP,
  // server/middleware/security.ts) is real, correct, and NOT weakened for
  // this suite; four separate full reloads was enough admin traffic from
  // one IP to trip it. Reusing the page cuts that traffic to what an
  // actual admin session touching 4 purposes back-to-back would generate.
  test('editing a purpose (baseline/gates, weakening, tightening+audit, revision conflict, reset), then preview + no-secret-leak checks on the same session', async ({ page, context }) => {
    await withSiteDefault(page, 'en');
    await seedSessionCookie(context, runtime.superAdmin.token, runtime.ports.proxy);
    await page.goto('/admin/verification', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Verification & OTP' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: 'Purposes' }).click();

    // 1. Baseline + gates are exposed.
    await page.getByRole('row', { name: /Signup — Email/ }).getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Activation gates')).toBeVisible();
    await expect(page.getByText(/Purpose baseline:/).first()).toBeVisible();

    // 2. A weakening submission is rejected VISIBLY, Save disabled, no round-trip.
    await page.getByLabel('OTP length (digits)').fill('1');
    await expect(page.getByText(/Cannot save: .* value\(s\) would weaken this purpose/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // 3. A valid tightening submission saves, bumps revision, appears in the audit log.
    await page.getByRole('row', { name: /Password reset/ }).getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const resendCooldown = page.getByLabel('Resend cooldown (seconds)');
    const currentCooldown = await resendCooldown.inputValue();
    await resendCooldown.fill(String(Number(currentCooldown) + 5));
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });

    await page.getByRole('tab', { name: 'Audit history' }).click();
    await expect(page.getByRole('row', { name: /Password reset/ }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Update').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Purposes' }).click();

    // 4. A stale expectedRevision is rejected as a visible revision conflict.
    await page.getByRole('row', { name: /Change email/ }).getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // Out-of-band mutation via a raw DB bump of `revision` while the dialog
    // is open, simulating a second admin's concurrent change — the open
    // dialog still holds the now-stale revision it loaded with.
    await db.query(`UPDATE public.verification_purpose_settings SET revision = revision + 1 WHERE purpose = 'change_email'`);
    const changeEmailCooldown = page.getByLabel('Resend cooldown (seconds)');
    const currentChangeEmailCooldown = await changeEmailCooldown.inputValue();
    await changeEmailCooldown.fill(String(Number(currentChangeEmailCooldown) + 5));
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Someone else changed these settings. Reload and try again.')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // 5. Reset restores platform defaults and turns admin_enabled back off.
    await page.getByRole('row', { name: /Change phone/ }).getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /Reset to defaults/ }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });

    const { rows } = await db.query(`SELECT admin_enabled FROM public.verification_purpose_settings WHERE purpose = 'change_phone'`);
    expect(rows[0].admin_enabled).toBe(false);

    // 6. Notification preview is sandboxed, no secrets leak, zero provider
    // calls — checked on the SAME page/session (no new page.goto) for the
    // same adminRateLimiter budget reason documented above.
    await page.getByRole('tab', { name: 'Notification preview' }).click();
    await expect(page.getByText('Test code shown: 123456')).toBeVisible({ timeout: 10_000 });
    const iframe = page.locator('iframe[title*="Sandboxed"]');
    await expect(iframe).toHaveAttribute('sandbox', '');

    const bodyHtml = await page.content();
    expect(bodyHtml).not.toContain('SERVICE_ROLE');
    expect(bodyHtml).not.toContain(runtime.superAdmin.token);

    const cookies = await context.cookies();
    for (const c of cookies) {
      if (c.name === 'gs_session') continue;
      expect(c.value).not.toContain(runtime.superAdmin.token);
    }

    const storageDump = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }));
    const serialized = JSON.stringify(storageDump);
    expect(serialized).not.toContain(runtime.superAdmin.token);
    expect(serialized.toUpperCase()).not.toContain('SERVICE_ROLE');

    const { rows: challenges } = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    expect(challenges[0].n).toBe(0);
  });
});
