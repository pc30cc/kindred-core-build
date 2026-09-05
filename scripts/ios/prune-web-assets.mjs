#!/usr/bin/env node
/**
 * Removes WEB-ONLY assets from `dist/` before `npx cap sync ios` copies it
 * into `ios/App/App/public/`.
 *
 * The embeddable chat/call widget bundles (`/widget/*`, `/call-widget/*`) are
 * only ever loaded by third-party websites through the public CDN — they are
 * dead weight (and confusing extra files) inside the native app bundle. The
 * same applies to `robots.txt` / `sitemap.xml`, which mean nothing in an app.
 *
 * This never touches the deployed web build: it runs only in the iOS sync
 * chain (`npm run ios:sync` / `npm run ios:prepare`), after `npm run build`.
 * Re-run `npm run build` to get the widget assets back into `dist/` for a web
 * deploy.
 */
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const dist = resolve(root, 'dist');

if (!existsSync(dist)) {
  console.error('[ios] dist/ not found — run `npm run build` before syncing iOS.');
  process.exit(1);
}

const removed = [];

for (const rel of ['widget', 'call-widget', 'robots.txt', 'sitemap.xml']) {
  const target = resolve(dist, rel);
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
  removed.push(rel);
}

// Hash manifests written by scripts/widget-hash.js & call-widget-hash.js.
for (const file of readdirSync(dist)) {
  if (/^(widget|call-widget).*\.(json|txt)$/.test(file)) {
    rmSync(resolve(dist, file), { force: true });
    removed.push(file);
  }
}

console.log(
  removed.length
    ? `[ios] pruned web-only assets from dist/: ${removed.join(', ')}`
    : '[ios] no web-only assets to prune',
);
