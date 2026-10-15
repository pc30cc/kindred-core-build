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
 * Deterministic: sorted entries, one fixed file date per version, no extra
 * attributes — the same source always yields the same bytes.
 *
 * Releases are signed (see scripts/plugin-release-signature.mjs): connected
 * WHMCS installs update themselves only when public/downloads/
 * webyar-whmcs.json.sig is an Ed25519 signature of webyar-whmcs.json by the
 * release key whose public half is built into the addon (lib/Updater.php
 * UPDATE_PUBLIC_KEY, the same key as OpenCart). The manifest is signed on the
 * release host, never here. Once a version is signed its archive is frozen:
 * a rebuild keeps the committed, signed files (and warns if the source now
 * differs — bump Version::ADDON and sign again). A new, unsigned version
 * builds normally; installs simply do not pick it up until it is signed.
 * WEBYAR_WHMCS_REBUILD=1 forces a fresh build of a signed version.
 *
 * Shells out to the system `zip` binary like the WooCommerce packager (no
 * npm dependency).
 *
 * Two editions from the same source (scripts/build/pluginEdition.mjs), as
 * the client build's brand asks (scripts/build/brand.mjs):
 *   iran   → public/downloads/webyar-whmcs.{zip,json}   (as always)
 *   respok → public/downloads/respok-whmcs.{zip,json}   (modules/addons/respok,
 *            X-Platform-* headers, RESPOK texts and icon)
 *   both   → both.
 * WHMCS rule both keep: the addon folder modules/addons/<name>/ IS the module
 * name, and holds <name>.php whose functions are <name>_config, _activate,
 * _deactivate, _upgrade, _output.
 *
 * Run:  node scripts/build-whmcs-addon-zip.mjs
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixedTimeFor, readPublicKey, sha256File, signedManifest, verifyManifest } from './plugin-release-signature.mjs';
import { resolveBuildBrand } from './build/brand.mjs';
import { EDITION_CODE, pluginEditionsFor, transformTreeToRespok } from './build/pluginEdition.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'webyar-whmcs';
const SRC = join(ROOT, 'plugins', SLUG);
const ADDON = join(SRC, 'modules', 'addons', 'webyar');
const OUT_DIR = join(ROOT, 'public', 'downloads');

/** The package slug (archive and manifest names) and the WHMCS module name of an edition. */
export function whmcsNames(edition) {
  return { slug: `${EDITION_CODE[edition]}-whmcs`, module: EDITION_CODE[edition] };
}

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

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/** Stages the addon (as the edition) and zips it deterministically; returns the zip path. */
function buildZip(stage, version, edition) {
  const { slug, module } = whmcsNames(edition);
  const target = join(stage, 'modules', 'addons', 'webyar');
  mkdirSync(dirname(target), { recursive: true });
  cpSync(ADDON, target, { recursive: true });
  cpSync(join(SRC, 'INSTALL.txt'), join(stage, 'INSTALL.txt'));
  // The International edition: the same staged files, renamed and rewritten.
  if (edition === 'respok') transformTreeToRespok(stage);
  if (!existsSync(join(stage, 'modules', 'addons', module, `${module}.php`))) throw new Error(`staged addon has no modules/addons/${module}/${module}.php`);

  const time = fixedTimeFor(version);
  const files = listFiles(stage).map((f) => relative(stage, f));
  for (const f of files) utimesSync(join(stage, f), time, time);
  const zip = join(stage, '..', `${slug}.zip`);
  // -X: no extra attributes; -D: no directory entries (the updater creates
  // parents itself); explicit sorted list: stable entry order.
  execFileSync('zip', ['-X', '-q', '-D', zip, ...files], { cwd: stage, stdio: 'inherit' });
  if (!existsSync(zip)) throw new Error(`zip reported success but ${zip} was not created`);
  return zip;
}

/**
 * Packages one edition into `outDir` (<slug>.zip + <slug>.json); returns
 * what it wrote or kept. Exported for the tests, which build into a temp dir.
 */
export function packageWhmcs({ edition = 'iran', outDir = OUT_DIR, log = console } = {}) {
  if (!existsSync(join(ADDON, 'webyar.php'))) throw new Error(`Addon source not found at ${ADDON}`);
  assertZipAvailable();
  const version = addonVersion();
  const { slug, module } = whmcsNames(edition);
  const outFile = join(outDir, `${slug}.zip`);
  const manifestFile = join(outDir, `${slug}.json`);
  const sigFile = `${manifestFile}.sig`;

  const work = mkdtempSync(join(tmpdir(), 'webyar-whmcs-zip-'));
  try {
    const stage = join(work, 'stage');
    mkdirSync(stage);
    const built = buildZip(stage, version, edition);
    const publicKey = readPublicKey(join(stage, 'modules', 'addons', module, 'lib', 'Updater.php'));
    const fresh = sha256File(built);

    const signed = signedManifest(manifestFile, publicKey);
    const frozen = signed?.version === version
      && sha256File(outFile) === signed.sha256
      && !process.env.WEBYAR_WHMCS_REBUILD;

    if (frozen) {
      // The signed release is what installs verify and install: keep it byte for byte.
      if (fresh !== signed.sha256) {
        log.warn(`[whmcs] ${slug} ${version} is signed and frozen; the source now builds a different archive — bump Version::ADDON and sign the new manifest to release it.`);
      }
      log.log(`✅ WHMCS addon: kept signed ${slug} v${version} (${signed.sha256.slice(0, 12)}…)`);
      return { slug, version, zip: outFile, manifest: manifestFile, kept: true };
    }

    mkdirSync(outDir, { recursive: true });
    cpSync(built, outFile);
    const bytes = readFileSync(outFile);
    // Field set and names are what every addon since 1.2.0 validates, so an
    // install still running the unsigned-era updater can take this release.
    const body = `${JSON.stringify({
      slug,
      version,
      package: `/downloads/${slug}.zip`,
      sha256: fresh,
      size: bytes.length,
      requires_whmcs: '8.0',
      requires_php: '7.2',
    }, null, 2)}\n`;
    writeFileSync(manifestFile, body, 'utf8');
    if (!existsSync(sigFile) || !verifyManifest(Buffer.from(body), readFileSync(sigFile, 'utf8'), publicKey)) {
      // A stale signature would make installs report "signature invalid"
      // instead of the truth: this version is not signed yet.
      rmSync(sigFile, { force: true });
      log.warn(`[whmcs] ${slug}.json is not signed for v${version}: connected WHMCS installs will not auto-update to it until the manifest is signed on the release host (see scripts/plugin-release-signature.mjs).`);
    }
    log.log(`✅ WHMCS addon packaged: ${outFile.replace(ROOT + '/', '')} (v${version}, ${fresh.slice(0, 12)}…)`);
    return { slug, version, zip: outFile, manifest: manifestFile, kept: false };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  for (const edition of pluginEditionsFor(resolveBuildBrand(process.env))) packageWhmcs({ edition });
}
