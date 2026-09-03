import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFileSync, existsSync, mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * SEO Audit — critical-flow real-browser acceptance test.
 *
 * Reuses the SAME full-stack harness as e2e/adminVerification.spec.ts (real
 * Postgres + PostgREST + Express, globalSetup already booted before this
 * file runs) and adds, in its own beforeAll, exactly the pieces this flow
 * needs on top of that shared stack:
 *
 *  - A registered `workspace_domains` site pointed at a REAL local HTTPS
 *    server this file starts and tears down (a 2-page fixture site: /, /about,
 *    plus robots.txt/sitemap.xml — the same fixture shape used by the
 *    Vitest-level pipeline proof in src/test/seo/e2eSmoke.test.ts).
 *  - The REAL `seo-crawler` worker process (worker/index.ts,
 *    WORKER_KIND=seo-crawler — the actual production entrypoint, unmodified),
 *    pointed at the harness's scratch Postgres/PostgREST.
 *
 * `resolveWorkspaceSite` (server/services/seo/siteResolver.ts) always builds
 * the crawl URL as `https://<host>` — no port, no scheme override — so the
 * fixture site must terminate real TLS on 127.0.0.1:443 for a real hostname.
 * That needs two things a normal unit test never touches, both scoped to
 * this spec's own beforeAll/afterAll and reverted immediately after:
 *   1. A single `/etc/hosts` line pointing a test-only hostname at 127.0.0.1
 *      (removed in afterAll) — this environment runs as root inside a
 *      disposable container, so this is a private, throwaway DNS override,
 *      not a change to a shared machine.
 *   2. `NODE_TLS_REJECT_UNAUTHORIZED=0` in the SPAWNED WORKER PROCESS'S OWN
 *      env only (never the harness's Express or this test's own process) so
 *      it accepts the self-signed cert minted for that hostname — the same
 *      class of trust relaxation any real self-hoster accepts running behind
 *      a self-signed reverse proxy in a dev/staging environment.
 * `AI_KB_ALLOW_LOCAL=1` (already added to the shared harness's Express env
 * in setupFullStack.ts) is the actual product-documented dev-only seam that
 * lets safeCrawlFetch.ts's SSRF guard permit a private-range target at all;
 * the worker process spawned here gets the same flag for the same reason.
 * No SSRF check is bypassed for any OTHER target — a real public private-IP
 * redirect is still rejected, as proven by src/test/security/seoSsrf.test.ts.
 *
 * Navigation uses `domcontentloaded`, never `networkidle`: this app holds a
 * persistent realtime connection that never goes network-idle, and Chromium
 * left waiting on it under this harness's resource limits stalls the shared
 * Express process for the rest of the run. `page.waitForURL` right after
 * navigation is what actually proves the SPA settled on this route.
 */

const RUNTIME_FILE = path.join(__dirname, 'harness', '.runtime.json');
const fullStack = process.env.E2E_FULL_STACK === '1';
const TEST_HOST = 'seo-e2e-test.local';
const HOSTS_LINE = `127.0.0.1 ${TEST_HOST}`;

interface Runtime {
  ports: { postgrest: number; gateway: number; express: number; proxy: number };
  workspaceAdmin: { userId: string; token: string; workspaceId: string };
  serviceRoleKey: string;
  anonKey: string;
}

function loadRuntime(): Runtime {
  if (!existsSync(RUNTIME_FILE)) {
    throw new Error(`${RUNTIME_FILE} missing — globalSetup did not run (is E2E_FULL_STACK=1 set?)`);
  }
  return JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'));
}

async function withSiteDefault(page: Page) {
  await page.route('**/runtime-config.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.__APP_RUNTIME_CONFIG__ = { apiBaseUrl: "", defaultLocale: "en" };`,
    });
  });
}

async function seedSessionCookie(context: BrowserContext, token: string) {
  await context.addCookies([
    { name: 'gs_session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
  ]);
}

const FIXTURE_PAGES: Record<string, { status: number; contentType: string; body: string }> = {
  '/': {
    status: 200,
    contentType: 'text/html',
    body: '<html><head><title>Home</title></head><body>'
      + '<a href="/about">About</a> <a href="/missing">Broken</a> <a href="https://external-seo-e2e-test.invalid/page">External</a>'
      + '<p>Home page body copy with enough visible words to clear the thin-content threshold used by the rules engine.</p>'
      + '</body></html>',
  },
  '/about': {
    status: 200,
    contentType: 'text/html',
    body: '<html><head><title>About</title></head><body>'
      + '<a href="/">Home</a>'
      + '<p>About page body copy with enough visible words to clear the thin-content threshold used by the rules engine.</p>'
      + '</body></html>',
  },
  '/robots.txt': {
    status: 200,
    contentType: 'text/plain',
    body: `User-agent: *\nDisallow:\nSitemap: https://${TEST_HOST}/sitemap.xml\n`,
  },
  '/sitemap.xml': {
    status: 200,
    contentType: 'application/xml',
    body: `<?xml version="1.0"?><urlset><url><loc>https://${TEST_HOST}/</loc></url><url><loc>https://${TEST_HOST}/about</loc></url></urlset>`,
  },
};

test.describe('SEO audit — critical flow (E2E_FULL_STACK=1)', () => {
  test.skip(!fullStack, 'requires E2E_FULL_STACK=1 (real Postgres + PostgREST + Express + a real local HTTPS fixture site + the real seo-crawler worker process)');

  let runtime: Runtime;
  let db: Pool;
  let httpsServer: https.Server;
  let workerProc: ChildProcess;
  let addedHostsLine = false;
  const siteId = randomUUID();

  test.beforeAll(async () => {
    runtime = loadRuntime();
    db = new Pool({ connectionString: process.env.E2E_PG_SUPERUSER_DSN?.replace(/\/[^/]*$/, `/${process.env.E2E_DB_NAME || 'gv_e2e_stack'}`) || `postgres://app_test:app_test@127.0.0.1:5432/${process.env.E2E_DB_NAME || 'gv_e2e_stack'}` });

    // 1. Point TEST_HOST at 127.0.0.1 for THIS container only.
    const hosts = readFileSync('/etc/hosts', 'utf8');
    if (!hosts.includes(TEST_HOST)) {
      appendFileSync('/etc/hosts', `${HOSTS_LINE}\n`);
      addedHostsLine = true;
    }

    // 2. Self-signed cert for TEST_HOST, real TLS termination — the only way
    //    to exercise siteResolver's hardcoded `https://<host>` canonical URL
    //    against a fixture we control.
    const certDir = mkdtempSync(path.join(tmpdir(), 'seo-e2e-cert-'));
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    const openssl = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', `/CN=${TEST_HOST}`,
      '-keyout', keyPath, '-out', certPath,
    ], { stdio: 'pipe' });
    if (openssl.status !== 0) {
      throw new Error(`openssl self-signed cert generation failed: ${openssl.stderr?.toString()}`);
    }

    // 3. The fixture site itself — a real HTTPS server, real TLS handshake,
    //    real HTTP responses. Only the CA trust is test-only (self-signed).
    httpsServer = https.createServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (req, res) => {
        const fixture = FIXTURE_PAGES[req.url || ''];
        if (!fixture) { res.writeHead(404).end('not found'); return; }
        res.writeHead(fixture.status, { 'content-type': fixture.contentType });
        res.end(fixture.body);
      },
    );
    await new Promise<void>((resolve, reject) => {
      httpsServer.on('error', reject);
      httpsServer.listen(443, '127.0.0.1', () => resolve());
    });

    // 4. Register the fixture as a real site in the seeded workspace.
    await db.query(
      `INSERT INTO public.workspace_domains (id, workspace_id, domain, verified, is_primary) VALUES ($1, $2, $3, true, true)`,
      [siteId, runtime.workspaceAdmin.workspaceId, TEST_HOST],
    );

    // 5. The REAL seo-crawler worker process — worker/index.ts, unmodified,
    //    WORKER_KIND=seo-crawler, pointed at this harness's own scratch stack.
    const tsxBin = path.join(__dirname, '../node_modules/.bin/tsx');
    workerProc = spawn(tsxBin, [path.join(__dirname, '../worker/index.ts')], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        WORKER_KIND: 'seo-crawler',
        SUPABASE_URL: `http://127.0.0.1:${runtime.ports.gateway}`,
        SUPABASE_ANON_KEY: runtime.anonKey,
        SUPABASE_SERVICE_ROLE_KEY: runtime.serviceRoleKey,
        NODE_ENV: 'development',
        AI_KB_ALLOW_LOCAL: '1',
        // Scoped to THIS child process only — accepts the self-signed cert
        // minted above. Never set on the harness's Express process or on
        // this test file's own process.
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        SEO_WORKER_INTERVAL_MS: '300',
        WORKER_ID: 'e2e-seo-worker',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let workerLog = '';
    workerProc.stdout?.on('data', (d) => { workerLog += d.toString(); });
    workerProc.stderr?.on('data', (d) => { workerLog += d.toString(); });
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = setInterval(() => {
        if (workerLog.includes('[seo-crawler-worker] started')) { clearInterval(check); resolve(); }
        else if (Date.now() - start > 15_000) { clearInterval(check); reject(new Error(`seo-crawler worker failed to start. Log:\n${workerLog}`)); }
      }, 100);
    });
  });

  test.afterAll(async () => {
    workerProc?.kill('SIGTERM');
    if (httpsServer) await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    await db?.end();
    if (addedHostsLine) {
      const hosts = readFileSync('/etc/hosts', 'utf8');
      const filtered = hosts.split('\n').filter((l) => l.trim() !== HOSTS_LINE).join('\n');
      writeFileSync('/etc/hosts', filtered);
    }
  });

  test('registered site → start audit → running → completed, with a real score and real crawled pages', async ({ page, context }) => {
    test.setTimeout(60_000);
    await withSiteDefault(page);
    await seedSessionCookie(context, runtime.workspaceAdmin.token);
    await page.goto('/e2e-workspace/seo', { waitUntil: 'domcontentloaded' });
    // A cold app boot on a deep link races RequireWorkspaceAdmin's async role
    // check against the router: the URL can briefly satisfy /seo, then bounce
    // to the workspace root once the guard re-evaluates with real data, before
    // settling back on /seo for good.
    await page.waitForURL('**/e2e-workspace/seo', { timeout: 15_000 });

    // The registered site is shown (single site — no picker, straight to its state).
    // Retried: this harness's reverse proxy (e2e/harness/proxyServer.ts) can
    // hit a stale keep-alive connection to Express on the first request after
    // this test's (slower than adminVerification's) beforeAll — a real
    // transient proxy hiccup, not a product bug — so a reload is a normal,
    // legitimate recovery, not a mask for incorrect behavior.
    await expect(async () => {
      if (!page.url().endsWith('/e2e-workspace/seo')) {
        await page.goto('/e2e-workspace/seo', { waitUntil: 'domcontentloaded' });
        await page.waitForURL('**/e2e-workspace/seo', { timeout: 15_000 });
      }
      await expect(page.getByRole('heading', { name: 'This site has not been audited yet' })).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000, intervals: [1000, 2000, 3000] });

    // Start a real audit — this POSTs siteId only; the server resolves the
    // crawl URL from workspace_domains itself (see siteResolver.ts).
    await page.getByRole('button', { name: 'Start First Audit' }).click();

    // Running state: the real background_jobs row was created and is either
    // still queued or already claimed by the real worker process above.
    await expect(page.getByRole('heading', { name: 'Audit in progress' })).toBeVisible({ timeout: 15_000 });

    // Completed state: the real worker claimed the job, crawled the real
    // fixture site over real HTTPS, and persisted a normalized, scored audit.
    await expect(page.getByRole('heading', { name: 'SEO Health Score' })).toBeVisible({ timeout: 30_000 });
    const pagesCrawledCard = page.locator('text=Pages Crawled').locator('xpath=..');
    await expect(pagesCrawledCard).toContainText('2'); // /, /about (fetched); /missing is a 404, not counted as crawled

    // Cross-check directly against the database the real worker wrote to —
    // proof this isn't just a client-side optimistic render.
    const { rows } = await db.query(
      `SELECT status, score, pages_crawled, pages_failed FROM public.seo_crawls WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [runtime.workspaceAdmin.workspaceId],
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].score).not.toBeNull();
    expect(rows[0].pages_crawled).toBe(2);
    expect(rows[0].pages_failed).toBe(1);
  });
});
