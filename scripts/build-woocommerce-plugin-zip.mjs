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
import { cpSync, mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_SLUG = 'webyar-woocommerce';
const PLUGIN_SRC = join(ROOT, 'plugins', PLUGIN_SLUG);
const OUT_DIR = join(ROOT, 'public', 'downloads');
const OUT_FILE = join(OUT_DIR, `${PLUGIN_SLUG}.zip`);
const MANIFEST_FILE = join(OUT_DIR, `${PLUGIN_SLUG}.json`);

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

/**
 * What the installed plugin reads to learn a newer build exists.
 *
 * Generated from the plugin header in the SAME run that packages the zip, so
 * the advertised version can never drift from the archive beside it — which
 * is the one way a hand-maintained manifest always eventually fails, by
 * promising an update the download does not contain.
 *
 * `package` is written as a path-only URL on purpose: the plugin refuses any
 * download host other than the Web Yar URL its admin configured, and Web Yar
 * is self-hostable, so this file cannot know the host it will be served from.
 * The plugin resolves it against its own configured base.
 */
function readHeader(field, source) {
  const match = source.match(new RegExp(`^\\s*\\*\\s*${field}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

function writeManifest() {
  const source = readFileSync(join(PLUGIN_SRC, `${PLUGIN_SLUG}.php`), 'utf8');
  const version = readHeader('Version', source);
  if (!/^[0-9]+(\.[0-9]+){0,3}$/.test(version)) {
    throw new Error(`Could not read a usable Version from the plugin header (got ${JSON.stringify(version)})`);
  }

  let changelog = '';
  let changelogFa = '';
  const readme = join(PLUGIN_SRC, 'readme.txt');
  if (existsSync(readme)) {
    const section = readFileSync(readme, 'utf8').split(/^==\s*Changelog\s*==$/m)[1];
    if (section) changelog = section.split(/^==/m)[0].trim();
    const sectionFa = readFileSync(readme, 'utf8').split(/^==\s*Changelog fa_IR\s*==$/m)[1];
    if (sectionFa) changelogFa = sectionFa.split(/^==/m)[0].trim();
  }

  const manifest = {
    slug: PLUGIN_SLUG,
    version,
    // Path only — the plugin resolves it against its configured Web Yar URL.
    package: `/downloads/${PLUGIN_SLUG}.zip`,
    requires: readHeader('Requires at least', source) || '6.0',
    requires_php: readHeader('Requires PHP', source) || '7.4',
    tested: readHeader('WC tested up to', source) || '',
    homepage: readHeader('Plugin URI', source) || 'https://webyar.ai',
    description: readHeader('Description', source),
    changelog,
    changelog_fa: changelogFa,
    last_updated: new Date().toISOString(),
  };

  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`✅ Update manifest written: ${MANIFEST_FILE.replace(ROOT + '/', '')} (v${version})`);
}

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
    writeManifest();
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

main();
