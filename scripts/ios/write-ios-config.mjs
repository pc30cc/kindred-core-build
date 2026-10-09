/**
 * Generates the iPhone app's compile-time configuration, for both of its
 * brands: WebYar (the `Webyar` target) and RESPOK (the `Respok` target,
 * BRAND_RESPOK). One file comes out, ios/Webyar/Sources/Core/Networking/
 * GeneratedConfig.swift, with each brand's values under `#if BRAND_RESPOK`.
 *
 * Each brand has its own config file and its own platform, and the two never
 * meet:
 *
 *   webyar   config/mobile-runtime.json           asks api.webyar.ai
 *   respok   config/mobile-runtime.respok.json    asks api.respok.app
 *
 * A brand's answer is written back to that brand's file only, so a RESPOK run
 * can never rewrite WebYar's bootstrap (or the other way round). And RESPOK's
 * API origin is only ever one of its own hosts (respok.app or a subdomain of
 * it), its support link never a WebYar one — the same rules the app applies
 * at runtime (AppBrand.ownsOrigin, AppBrand.accepts). A RESPOK platform that
 * answers otherwise (its database was cloned from WebYar's) is ignored, and a
 * RESPOK file that says otherwise fails the run.
 *
 * WHERE A BRAND'S ORIGIN COMES FROM, in order:
 *
 *   1. `MOBILE_API_BASE_URL` / `IOS_API_BASE_URL` — an explicit override, for
 *      building against a staging backend. It applies to the brand named with
 *      `--brand` (WebYar when none is named) and is never written back.
 *   2. **The platform itself.** The brand's config file names a host to ask,
 *      and `GET /api/platform/origins` there answers with whatever
 *      `platform_domains.api_base_url` currently says (Super Admin →
 *      Branding). When the answer differs, it wins and is written back into
 *      that file, so the file becomes a cache of the last known answer rather
 *      than a second source of truth.
 *   3. The file as it stands — for an offline build, or a machine that cannot
 *      reach the platform.
 *
 * This matters because the rest of the system already works this way: see
 * `server/services/platformOrigins.ts`, whose rule is that domains must not be
 * baked into build artifacts. A signed app still needs one origin compiled in
 * to make its first request — it cannot ask the API where the API is — but
 * that value is a bootstrap, and the app replaces it with the platform's
 * answer on its first launch.
 *
 * The output is committed so a fresh clone builds in Xcode without having to
 * run node first; re-run `npm run ios:config` to pick up a move.
 *
 *   node scripts/ios/write-ios-config.mjs                  both brands, each asks its platform
 *   node scripts/ios/write-ios-config.mjs --brand=respok   asks RESPOK's platform only; WebYar's
 *                                                          values are taken from its file as they stand
 *   node scripts/ios/write-ios-config.mjs --offline        asks nobody: both files as they stand
 *   node scripts/ios/write-ios-config.mjs --offline --check
 *                                                          fails if GeneratedConfig.swift is not
 *                                                          what the two files say (writes nothing)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outPath = resolve(root, 'ios/Webyar/Sources/Core/Networking/GeneratedConfig.swift');

/** The two brands, in the order the Swift file lists them. */
const everyHost = () => true;
const BRANDS = {
  webyar: {
    name: 'WebYar',
    cfgPath: resolve(root, 'config/mobile-runtime.json'),
    ownsOrigin: everyHost,
    acceptsLink: everyHost,
  },
  respok: {
    name: 'RESPOK',
    cfgPath: resolve(root, 'config/mobile-runtime.respok.json'),
    // Its API only on its own hosts, whatever names WebYar has had (AppBrand.ownsOrigin).
    ownsOrigin: (host) => host === 'respok.app' || host.endsWith('.respok.app'),
    // Its links never on a WebYar host (AppBrand.accepts).
    acceptsLink: (host) => !host.includes('webyar'),
  },
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const brandArg = (() => {
  const at = args.findIndex((a) => a === '--brand' || a.startsWith('--brand='));
  if (at === -1) return null;
  const value = args[at].includes('=') ? args[at].split('=')[1] : args[at + 1];
  if (!Object.hasOwn(BRANDS, value)) {
    throw new Error(`[ios-config] --brand must be one of ${Object.keys(BRANDS).join(', ')}, not "${value}"`);
  }
  return value;
})();
const offline = flag('offline') || flag('check');
const check = flag('check');

/**
 * A link, not a base: a support URL legitimately carries a path. `asOrigin`
 * would flatten `https://app.example.com/help` to the bare site root.
 */
function asLink(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.href.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

/** Origin only, https only — a base URL with a path breaks every request. */
function asOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Asks the platform where it lives. Never fatal: a build with no network, or
 * against a host that has not deployed this route yet, falls back to the file.
 */
async function askPlatform(origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${origin}/api/platform/origins`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One brand's values: from its file, its platform (when asked) and the override. */
async function resolveBrand(id) {
  const brand = BRANDS[id];
  const { cfgPath } = brand;
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const refresh = !offline && (brandArg === null || brandArg === id);
  const overrideFor = brandArg ?? 'webyar';
  const override =
    overrideFor === id ? (process.env.MOBILE_API_BASE_URL || process.env.IOS_API_BASE_URL || '').trim() : '';

  let apiBaseUrl = (override || cfg.apiBaseUrl || '').trim();
  let supportUrl = (cfg.supportUrl || '').trim();
  const file = cfgPath.replace(root + '/', '');
  /** An origin this brand may make its API, and a link it may open (see BRANDS). */
  const host = (url) => new URL(url).hostname.toLowerCase();
  const owned = (url) => brand.ownsOrigin(host(url));
  const allowed = (url) => brand.acceptsLink(host(url));

  if (refresh && !override && asOrigin(apiBaseUrl)) {
    const answer = await askPlatform(asOrigin(apiBaseUrl));
    const resolved = asOrigin(answer?.apiBaseUrl);
    if (resolved && !owned(resolved)) {
      console.log(`[ios-config] ${brand.name}: the platform says ${resolved}, not one of this brand's hosts — ignored`);
    } else if (resolved && resolved !== apiBaseUrl) {
      console.log(`[ios-config] ${brand.name}: platform_domains says ${resolved} (was ${apiBaseUrl}) — following it`);
      apiBaseUrl = resolved;
      cfg.apiBaseUrl = resolved;
      writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    } else if (!answer) {
      console.log(`[ios-config] ${brand.name}: could not reach ${apiBaseUrl} — using ${file} as it stands`);
    }
    // The platform's answer wins, exactly as it does for the API origin above.
    //
    // This used to read `if (help && !supportUrl)`, which inverted the rule: a
    // value already sitting in the config file blocked the platform from ever
    // correcting it, so a support link written once outlived the domain it
    // pointed at. It also appended `/contact` — a route this app has never
    // served. The server resolves the whole URL now (help centre if one is
    // set, otherwise `<public>/help`, which is a real route), so there is one
    // answer and no client invents its own path.
    const resolvedSupport = asLink(answer?.supportUrl);
    if (resolvedSupport && !allowed(resolvedSupport)) {
      console.log(`[ios-config] ${brand.name}: the platform's support link ${resolvedSupport} is not this brand's — ignored`);
    } else if (resolvedSupport && resolvedSupport !== supportUrl) {
      console.log(
        `[ios-config] ${brand.name}: platform says support is ${resolvedSupport}` +
          `${supportUrl ? ` (was ${supportUrl})` : ''} — following it`,
      );
      supportUrl = resolvedSupport;
      cfg.supportUrl = resolvedSupport;
      writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    }
  }

  // An app bundle is signed and shipped; a wrong or empty base URL would only
  // surface as every request failing on a user's device. Fail the build instead.
  if (!/^https:\/\/[^/]+$/i.test(apiBaseUrl)) {
    throw new Error(
      `[ios-config] Refusing to generate ${brand.name}'s config with an invalid API base: "${apiBaseUrl}".\n` +
        `        Set it in ${file} or MOBILE_API_BASE_URL=https://api.example.com --brand=${id}`,
    );
  }
  if (!owned(apiBaseUrl)) {
    throw new Error(`[ios-config] ${brand.name}'s API origin must be one of its own hosts, not ${apiBaseUrl} (${file})`);
  }
  if (supportUrl && !allowed(supportUrl)) {
    throw new Error(`[ios-config] ${brand.name}'s support link must not be a WebYar page: ${supportUrl} (${file})`);
  }

  const defaultLocale = (cfg.defaultLocale || 'en').trim();
  const locale = ['en', 'fa', 'tr'].includes(defaultLocale) ? defaultLocale : 'en';
  return { apiBaseUrl, supportUrl, locale };
}

/** One brand's three constants, indented for the enum body. */
function block({ apiBaseUrl, supportUrl, locale }) {
  return `    /// Origin the app sends every API request to.
    static let apiBaseURL = URL(string: ${JSON.stringify(apiBaseUrl)})!

    /// Opened from Delete Account, for an owner who has to ask for help.
    static let supportURL = ${supportUrl ? `URL(string: ${JSON.stringify(supportUrl)})` : 'URL?.none'}

    /// Language a first launch starts in, before the operator picks one.
    static let defaultLanguage = Language.${locale}`;
}

const webyar = await resolveBrand('webyar');
const respok = await resolveBrand('respok');

const swift = `// GENERATED by scripts/ios/write-ios-config.mjs — do not edit by hand.
//
// Source of truth: platform_domains.api_base_url (Super Admin → Branding) of
// each brand's own platform, resolved at generation time: WebYar's from
// config/mobile-runtime.json, RESPOK's (BRAND_RESPOK, the \`Respok\` target)
// from config/mobile-runtime.respok.json. This is only the BOOTSTRAP the app
// uses for its very first request; see PlatformOrigin.swift, which replaces
// it with the platform's own answer and remembers that instead.

import Foundation

enum GeneratedConfig {
    #if BRAND_RESPOK
${block(respok)}
    #else
${block(webyar)}
    #endif
}
`;

if (check) {
  const current = readFileSync(outPath, 'utf8');
  if (current !== swift) {
    console.error(
      '[ios-config] GeneratedConfig.swift is not what config/mobile-runtime.json and ' +
        'config/mobile-runtime.respok.json say. Run: node scripts/ios/write-ios-config.mjs --offline',
    );
    process.exit(1);
  }
  console.log('[ios-config] GeneratedConfig.swift is in sync with both brands\' config files.');
} else {
  writeFileSync(outPath, swift, 'utf8');
  console.log(`[ios-config] WebYar ${webyar.apiBaseUrl}, RESPOK ${respok.apiBaseUrl} → ${outPath.replace(root + '/', '')}`);
}
