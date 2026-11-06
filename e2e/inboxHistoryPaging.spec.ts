import { test, expect, type BrowserContext } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Inbox thread's history, page by page, in a real browser against the
 * real stack (E2E_FULL_STACK=1: e2e/harness/setupFullStack.ts — Postgres
 * with the whole chain, PostgREST, the unmodified Express server, the built
 * panel). Audit 2026-11-06, section 4: the server always handed back
 * `older`, but the panel never asked for it, so a thread past one page could
 * never show its start.
 *
 *   · a 250-message thread opens on its newest 100 (`limit=100`);
 *   · "Load earlier messages" adds the page before, keeping the reader's
 *     place, until the first message, then goes away;
 *   · a new message and a refresh (the tab coming back) keep every page
 *     loaded, and show the new one.
 */

const RUNTIME_FILE = path.join(__dirname, 'harness', '.runtime.json');
const fullStack = process.env.E2E_FULL_STACK === '1';
const PG_SUPERUSER_DSN = process.env.E2E_PG_SUPERUSER_DSN || 'postgres://app_test:app_test@127.0.0.1:5432/postgres';
const DB_NAME = process.env.E2E_DB_NAME || 'gv_e2e_stack';

interface Runtime {
  ports: { express: number; proxy: number };
  workspaceAdmin: { userId: string; token: string; workspaceId: string };
}

function loadRuntime(): Runtime {
  if (!existsSync(RUNTIME_FILE)) throw new Error(`${RUNTIME_FILE} missing — globalSetup did not run (is E2E_FULL_STACK=1 set?)`);
  return JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'));
}

async function seedSessionCookie(context: BrowserContext, token: string) {
  await context.addCookies([{ name: 'gs_session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
}

const body = (n: number) => `history-${String(n).padStart(3, '0')}`;

test.describe('Inbox thread history paging (real stack)', () => {
  test.skip(!fullStack, 'needs E2E_FULL_STACK=1');

  test('newest 100 first, earlier pages on request to the first message, kept across a new message and a refresh', async ({ page, context }) => {
    const rt = loadRuntime();
    const db = new Pool({ connectionString: PG_SUPERUSER_DSN.replace(/\/[^/]*$/, `/${DB_NAME}`), max: 1 });
    const cid = randomUUID();
    try {
      await db.query(`INSERT INTO public.conversations (id, workspace_id, status) VALUES ($1, $2, 'open')`, [cid, rt.workspaceAdmin.workspaceId]);
      await db.query(
        `INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, created_at, seen_at)
         SELECT $1, CASE WHEN g % 2 = 0 THEN 'contact' ELSE 'agent' END::public.sender_type,
                CASE WHEN g % 2 = 0 THEN NULL ELSE $2::uuid END,
                'history-' || lpad(g::text, 3, '0'), now() - make_interval(secs => 1000 - g), now()
           FROM generate_series(0, 249) g`,
        [cid, rt.workspaceAdmin.userId],
      );

      await page.route('**/runtime-config.js', (route) => route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'window.__APP_RUNTIME_CONFIG__ = { apiBaseUrl: "", defaultLocale: "en" };',
      }));
      await seedSessionCookie(context, rt.workspaceAdmin.token);
      const reads: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'GET' && new RegExp(`/api/conversations/${cid}/messages`).test(r.url())) reads.push(r.url());
      });

      await page.goto(`/app/inbox?c=${cid}`, { waitUntil: 'domcontentloaded' });
      const log = page.locator('[data-inbox="messages"]');
      await expect(log.getByText(body(249), { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(log.getByText(body(150), { exact: true })).toBeAttached();
      await expect(log.getByText(body(149), { exact: true })).toHaveCount(0);
      expect(reads[0]).toContain('limit=100');

      const more = page.locator('[data-inbox="load-older"] button');
      // The reader goes up to the oldest message shown, then asks for more.
      await log.getByText(body(150), { exact: true }).scrollIntoViewIfNeeded();
      const before = await log.getByText(body(150), { exact: true }).boundingBox();
      await more.click();
      await expect(log.getByText(body(50), { exact: true })).toBeAttached();
      await expect(log.getByText(body(49), { exact: true })).toHaveCount(0);
      // Its place is kept: the message it was reading has not moved off screen.
      const after = await log.getByText(body(150), { exact: true }).boundingBox();
      expect(before && after).toBeTruthy();
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(60);
      expect(reads.some((u) => u.includes('before=') && u.includes('limit=100'))).toBe(true);

      await more.click();
      await expect(log.getByText(body(0), { exact: true })).toBeAttached();
      await expect(page.locator('[data-inbox="load-older"]')).toHaveCount(0);

      // A new message, and the tab coming back: every page stays, the new one shows.
      await db.query(
        `INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'contact', 'history-new')`,
        [cid],
      );
      const readsBefore = reads.length;
      // React Query (v5) hears the tab coming back as `visibilitychange` on window.
      await page.evaluate(() => { window.dispatchEvent(new Event('visibilitychange')); });
      await expect(log.getByText('history-new', { exact: true })).toBeAttached({ timeout: 15_000 });
      expect(reads.length).toBeGreaterThan(readsBefore);
      await expect(log.getByText(body(0), { exact: true })).toBeAttached();
      await expect(log.getByText(body(120), { exact: true })).toBeAttached();
      const shown = await log.locator('text=/^history-\\d{3}$/').count();
      expect(shown).toBe(250);
    } finally {
      await db.query(`DELETE FROM public.conversations WHERE id = $1`, [cid]).catch(() => undefined);
      await db.end();
    }
  });
});
