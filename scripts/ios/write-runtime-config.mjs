#!/usr/bin/env node
/**
 * Writes the NATIVE runtime configuration into `dist/runtime-config.js`
 * BEFORE `npx cap sync ios` copies `dist/` into `ios/App/App/public/`.
 *
 * Why this exists:
 *   The web deployment intentionally ships an EMPTY `apiBaseUrl` (the app
 *   talks to its own origin through the nginx `/api/` proxy). Inside the
 *   iOS shell the app's origin is `capacitor://localhost`, so an empty base
 *   means every API call fails. Because `cap sync` overwrites the iOS copy
 *   from `dist/` on every run, hand-editing
 *   `ios/App/App/public/runtime-config.js` is not durable — it gets reset.
 *
 * So the value is generated deterministically from
 * `config/mobile-runtime.json` (committed, single source of truth) with an
 * optional `MOBILE_API_BASE_URL` / `IOS_API_BASE_URL` env override, and this
 * script runs as part of `npm run ios:sync` / `npm run ios:prepare`.
 *
 * The generated file stays SAFE FOR THE WEB too: `apiBaseUrl` keeps the
 * web value (normally empty = same origin) and only the extra
 * `mobileApiBaseUrl` key is injected, which just the native runtime reads.
 * So the same `dist/` can still be deployed to the web after a sync.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const configPath = resolve(root, 'config/mobile-runtime.json');
const distPath = resolve(root, 'dist/runtime-config.js');

if (!existsSync(distPath)) {
  console.error(
    '[ios] dist/runtime-config.js not found — run `npm run build` before syncing iOS.',
  );
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const apiBaseUrl = (
  process.env.MOBILE_API_BASE_URL ||
  process.env.IOS_API_BASE_URL ||
  cfg.apiBaseUrl ||
  ''
).trim().replace(/\/+$/, '');

if (!/^https:\/\/[^/]+$/i.test(apiBaseUrl)) {
  console.error(
    `[ios] Refusing to build a native bundle with an invalid API base: "${apiBaseUrl}".\n` +
      '      Set it in config/mobile-runtime.json or MOBILE_API_BASE_URL=https://api.example.com',
  );
  process.exit(1);
}

const defaultLocale = (cfg.defaultLocale || 'fa').trim();
// Optional external links surfaced in the native Settings screen. Empty =
// the corresponding row is hidden in the app.
const appStoreUrl = (cfg.appStoreUrl || '').trim();
const supportUrl = (cfg.supportUrl || '').trim();

// Preserve whatever the WEB deployment configured (usually "" = same origin).
const webConfigPath = resolve(root, 'public/runtime-config.js');
const webSource = existsSync(webConfigPath) ? readFileSync(webConfigPath, 'utf8') : '';
// Only look INSIDE the assignment, so the commented example URLs above it
// can never be mistaken for the configured value.
const webAssignment = webSource.split('__APP_RUNTIME_CONFIG__')[1] ?? '';
const webApiBaseUrl = (webAssignment.match(/apiBaseUrl:\s*"([^"]*)"/)?.[1] ?? '').trim();

const contents = `/**
 * GENERATED for the native (Capacitor/iOS) bundle by
 * scripts/ios/write-runtime-config.mjs — do not edit by hand, and do not
 * edit ios/App/App/public/runtime-config.js (cap sync overwrites it).
 * Source of truth: config/mobile-runtime.json (or MOBILE_API_BASE_URL).
 */
window.__APP_RUNTIME_CONFIG__ = {
  apiBaseUrl: ${JSON.stringify(webApiBaseUrl)},
  mobileApiBaseUrl: ${JSON.stringify(apiBaseUrl)},
  defaultLocale: ${JSON.stringify(defaultLocale)},
  appStoreUrl: ${JSON.stringify(appStoreUrl)},
  supportUrl: ${JSON.stringify(supportUrl)},
};
`;

writeFileSync(distPath, contents, 'utf8');
console.log(`[ios] dist/runtime-config.js → apiBaseUrl=${apiBaseUrl}`);
