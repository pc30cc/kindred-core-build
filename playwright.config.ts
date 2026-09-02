import { defineConfig, devices } from '@playwright/test';

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
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8080',
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    },
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
