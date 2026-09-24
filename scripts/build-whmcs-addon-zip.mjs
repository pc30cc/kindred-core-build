#!/usr/bin/env node
/**
 * Packages plugins/webyar-whmcs/ into an installable archive at
 * public/downloads/webyar-whmcs.zip, served statically by nginx (the same
 * `location ^~ /downloads/` block as the WooCommerce plugin) and offered from
 * Settings → Plugins → WHMCS.
 *
 * The archive mirrors the WHMCS directory layout, so it is extracted straight
 * into the WHMCS root:
 *
 *   modules/addons/webyar/…   the addon
 *   INSTALL.txt               the short install guide
 *
 * Dev-only content never ships: tests/, composer.*, phpunit.xml.dist,
 * vendor/, .gitignore.
 *
 * Shells out to the system `zip` binary like the WooCommerce packager (no
 * npm dependency). `-X` + a fixed file order keeps the archive reproducible
 * apart from zip's own timestamps.
 *
 * Run:  node scripts/build-whmcs-addon-zip.mjs
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'webyar-whmcs';
const SRC = join(ROOT, 'plugins', SLUG);
const ADDON = join(SRC, 'modules', 'addons', 'webyar');
const OUT_DIR = join(ROOT, 'public', 'downloads');
const OUT_FILE = join(OUT_DIR, `${SLUG}.zip`);
const MANIFEST_FILE = join(OUT_DIR, `${SLUG}.json`);

function addonVersion() {
  const source = readFileSync(join(ADDON, 'lib', 'Version.php'), 'utf8');
  const match = source.match(/const ADDON = '([0-9]+(?:\.[0-9]+){1,3})';/);
  if (!match) throw new Error('Could not read Version::ADDON from lib/Version.php');
  return match[1];
}

function assertZipAvailable() {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
  } catch {
    throw new Error('`zip` is not installed (apt-get install zip / apk add zip / brew install zip).');
  }
}

function main() {
  if (!existsSync(join(ADDON, 'webyar.php'))) throw new Error(`Addon source not found at ${ADDON}`);
  assertZipAvailable();
  const version = addonVersion();

  const stage = mkdtempSync(join(tmpdir(), 'webyar-whmcs-zip-'));
  try {
    const target = join(stage, 'modules', 'addons', 'webyar');
    mkdirSync(dirname(target), { recursive: true });
    cpSync(ADDON, target, { recursive: true });
    cpSync(join(SRC, 'INSTALL.txt'), join(stage, 'INSTALL.txt'));

    mkdirSync(OUT_DIR, { recursive: true });
    rmSync(OUT_FILE, { force: true });
    execFileSync('zip', ['-r', '-X', '-q', OUT_FILE, 'INSTALL.txt', 'modules'], { cwd: stage, stdio: 'inherit' });
    if (!existsSync(OUT_FILE)) throw new Error(`zip reported success but ${OUT_FILE} was not created`);

    writeFileSync(MANIFEST_FILE, `${JSON.stringify({
      slug: SLUG,
      version,
      package: `/downloads/${SLUG}.zip`,
      sha256: createHash('sha256').update(readFileSync(OUT_FILE)).digest('hex'),
      size: readFileSync(OUT_FILE).length,
      requires_whmcs: '8.0',
      requires_php: '7.2',
      last_updated: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    console.log(`✅ WHMCS addon packaged: ${OUT_FILE.replace(ROOT + '/', '')} (v${version})`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main();
