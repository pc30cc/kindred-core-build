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
 * Deterministic: sorted entries, one fixed file date per version, no extra
 * attributes.
 *
 * Releases are signed (see scripts/plugin-release-signature.mjs): installed
 * stores offer and install an update only when
 * public/downloads/webyar-woocommerce.json.sig is an Ed25519 signature of the
 * manifest by the release key whose public half is built into the plugin
 * (src/Support/Updater.php UPDATE_PUBLIC_KEY, the same key as OpenCart), and
 * the downloaded zip matches the manifest's signed sha256 and size. The
 * manifest is signed on the release host, never here. Once a version is
 * signed its archive is frozen: a rebuild keeps the committed, signed files
 * (and warns if the source now differs — bump the version and sign again).
 * A new, unsigned version builds normally; stores do not pick it up until it
 * is signed. WEBYAR_WOOCOMMERCE_REBUILD=1 forces a fresh build.
 *
 * Run:  node scripts/build-woocommerce-plugin-zip.mjs
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixedTimeFor, readPublicKey, sha256File, signedManifest, verifyManifest } from './plugin-release-signature.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_SLUG = 'webyar-woocommerce';
const PLUGIN_SRC = join(ROOT, 'plugins', PLUGIN_SLUG);
const OUT_DIR = join(ROOT, 'public', 'downloads');
const OUT_FILE = join(OUT_DIR, `${PLUGIN_SLUG}.zip`);
const MANIFEST_FILE = join(OUT_DIR, `${PLUGIN_SLUG}.json`);
const SIG_FILE = `${MANIFEST_FILE}.sig`;

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

function pluginVersion() {
  const version = readHeader('Version', readFileSync(join(PLUGIN_SRC, `${PLUGIN_SLUG}.php`), 'utf8'));
  if (!/^[0-9]+(\.[0-9]+){0,3}$/.test(version)) {
    throw new Error(`Could not read a usable Version from the plugin header (got ${JSON.stringify(version)})`);
  }
  return version;
}

/** The manifest body (exact bytes that get signed) for this zip. */
function manifestBody(version, sha256, size) {
  const previous = previousManifest();
  const source = readFileSync(join(PLUGIN_SRC, `${PLUGIN_SLUG}.php`), 'utf8');
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
    // What the plugin checks the downloaded archive against before WordPress
    // unpacks it; trusted only because the whole manifest is signed.
    sha256,
    size,
    requires: readHeader('Requires at least', source) || '6.0',
    requires_php: readHeader('Requires PHP', source) || '7.4',
    tested: readHeader('WC tested up to', source) || '',
    homepage: readHeader('Plugin URI', source) || 'https://webyar.ai',
    description: readHeader('Description', source),
    changelog,
    changelog_fa: changelogFa,
    // Kept from the previous manifest while the version is unchanged, so a
    // rebuild of the same source produces the same bytes.
    last_updated: previous?.version === version && previous.last_updated ? previous.last_updated : new Date().toISOString(),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function previousManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    return null;
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
  const version = pluginVersion();
  const publicKey = readPublicKey(join(PLUGIN_SRC, 'src', 'Support', 'Updater.php'));

  const work = mkdtempSync(join(tmpdir(), 'webyar-wc-zip-'));
  const stageRoot = join(work, 'stage');
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

    // -X: no extra file attributes; -D: no directory entries; a sorted
    // explicit list and one fixed date per version: same source, same bytes.
    // Run from stageRoot so every entry starts with "webyar-woocommerce/" —
    // required for WordPress's Plugins → Add New → Upload Plugin.
    const time = fixedTimeFor(version);
    const files = listFiles(stagePluginDir).map((f) => relative(stageRoot, f));
    for (const f of files) utimesSync(join(stageRoot, f), time, time);
    const built = join(work, `${PLUGIN_SLUG}.zip`);
    execFileSync('zip', ['-X', '-q', '-D', built, ...files], { cwd: stageRoot, stdio: 'inherit' });
    if (!existsSync(built)) {
      throw new Error(`zip reported success but ${built} was not created`);
    }
    const fresh = sha256File(built);

    const signed = signedManifest(MANIFEST_FILE, publicKey);
    const frozen = signed?.version === version
      && sha256File(OUT_FILE) === signed.sha256
      && !process.env.WEBYAR_WOOCOMMERCE_REBUILD;
    if (frozen) {
      // The signed release is what stores verify and install: keep it byte for byte.
      if (fresh !== signed.sha256) {
        console.warn(`[woocommerce] ${version} is signed and frozen; the source now builds a different zip — bump the plugin Version and sign the new manifest to release it.`);
      }
      console.log(`✅ WordPress plugin: kept signed v${version} (${signed.sha256.slice(0, 12)}…)`);
      return;
    }

    mkdirSync(OUT_DIR, { recursive: true });
    cpSync(built, OUT_FILE);
    const body = manifestBody(version, fresh, readFileSync(OUT_FILE).length);
    writeFileSync(MANIFEST_FILE, body, 'utf8');
    if (!existsSync(SIG_FILE) || !verifyManifest(Buffer.from(body), readFileSync(SIG_FILE, 'utf8'), publicKey)) {
      // A stale signature would make stores report "signature invalid"
      // instead of the truth: this version is not signed yet.
      rmSync(SIG_FILE, { force: true });
      console.warn(`[woocommerce] ${PLUGIN_SLUG}.json is not signed for v${version}: stores will not be offered this update until the manifest is signed on the release host (see scripts/plugin-release-signature.mjs).`);
    }
    console.log(`✅ WordPress plugin packaged: ${OUT_FILE.replace(ROOT + '/', '')} (v${version}, ${fresh.slice(0, 12)}…)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
