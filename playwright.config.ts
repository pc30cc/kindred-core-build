import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a Chromium that actually exists on this machine. CI installs the
 * browser that matches the pinned Playwright version; sandboxes and self-host
 * runners often carry a different build number, and Playwright would otherwise
 * fail with "Executable doesn't exist". PLAYWRIGHT_CHROMIUM_PATH always wins.
 */
function resolveChromium(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (explicit) return explicit;
  const root = '/opt/ms-playwright';
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    const candidate = path.join(root, dir, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * WORKSPACE INVITATIONS v5.1 — Section F real-browser E2E.
 *
 * Runs against the already-running self-hosted stack (Vite dev server on
 * :8080 proxying /api to Express). No mocks, no component harness.
 *
 * The invited-user flows that need a seeded pending invitation run only when
 * `E2E_INVITE_SEED=1` and a disposable backend is pointed at by the stack —
 * they are never executed against a production database.
 */
/**
 * E2E_FULL_STACK=1 boots a real, disposable Postgres + PostgREST + Express
 * stack (e2e/harness/setupFullStack.ts) so authenticated scenarios (Super
 * Admin, workspace owner/admin) can run against real sessions instead of
 * only the unauthenticated boundary. Off by default so the existing
 * "already-running dev stack on :8080" specs (e2e/invitations.spec.ts) are
 * unaffected.
 */
const fullStack = process.env.E2E_FULL_STACK === '1';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: fullStack ? path.join(__dirname, 'e2e/harness/setupFullStack.ts') : undefined,
  globalTeardown: fullStack ? path.join(__dirname, 'e2e/harness/teardownFullStack.ts') : undefined,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8080',
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      executablePath: resolveChromium(),
    },
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
