#!/usr/bin/env node
/**
 * Packages plugins/webyar-woocommerce/ into a WordPress-installable ZIP at
 * public/downloads/webyar-woocommerce.zip, served statically by nginx (same
 * mechanism as public/widget/*) and downloaded from Settings → Commerce
 * (src/pages/app/settings/CommercePage.tsx) before a store is connected.
 *
 * Excludes dev-only content that must never ship to a WordPress site:
 * vendor/ (Composer, PHPUnit only), tests/, composer.json/.lock,
 * phpunit.xml.dist, .gitignore.
 *
 * Shells out to the system `zip` binary rather than adding an npm
 * dependency — available in this repo's Alpine build images (see
 * Dockerfile / Dockerfile.frontend, `apk add --no-cache zip`) and on
 * virtually every Linux/macOS dev machine.
 *
 * Run:  node scripts/build-woocommerce-plugin-zip.mjs
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_SLUG = 'webyar-woocommerce';
const PLUGIN_SRC = join(ROOT, 'plugins', PLUGIN_SLUG);
const OUT_DIR = join(ROOT, 'public', 'downloads');
const OUT_FILE = join(OUT_DIR, `${PLUGIN_SLUG}.zip`);

// Files/dirs to ship — everything else in plugins/webyar-woocommerce/ is
// dev-only tooling (vendor/, tests/, composer.*, phpunit.xml.dist, .gitignore).
const SHIP = [
  `${PLUGIN_SLUG}.php`,
  'uninstall.php',
  'readme.txt',
  'src',
  'languages',
  'assets',
];

function assertZipAvailable() {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      "`zip` is not installed. Install it (e.g. `apt-get install zip` / `apk add zip` / `brew install zip`) and re-run — " +
      'this build step packages the WordPress plugin for download from Settings → Commerce.',
    );
  }
}

function main() {
  if (!existsSync(PLUGIN_SRC)) {
    throw new Error(`Plugin source not found at ${PLUGIN_SRC}`);
  }
  assertZipAvailable();

  const stageRoot = mkdtempSync(join(tmpdir(), 'webyar-wc-zip-'));
  const stagePluginDir = join(stageRoot, PLUGIN_SLUG);
  mkdirSync(stagePluginDir, { recursive: true });

  try {
    for (const entry of SHIP) {
      const src = join(PLUGIN_SRC, entry);
      if (!existsSync(src)) {
        // languages/ and assets/ may legitimately be empty/absent.
        if (entry === 'languages' || entry === 'assets') continue;
        throw new Error(`Expected plugin file/dir missing: ${src}`);
      }
      cpSync(src, join(stagePluginDir, entry), { recursive: true });
    }

    mkdirSync(OUT_DIR, { recursive: true });
    rmSync(OUT_FILE, { force: true });

    // -X: no extra file attributes (deterministic-ish across platforms).
    // -r: recursive. Run from stageRoot so the zip's top-level entry is
    // exactly "webyar-woocommerce/" — required for WordPress's
    // Plugins → Add New → Upload Plugin to recognize it.
    execFileSync('zip', ['-r', '-X', OUT_FILE, PLUGIN_SLUG], { cwd: stageRoot, stdio: 'inherit' });

    if (!existsSync(OUT_FILE)) {
      throw new Error(`zip reported success but ${OUT_FILE} was not created`);
    }
    console.log(`✅ WordPress plugin packaged: ${OUT_FILE.replace(ROOT + '/', '')}`);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

main();
