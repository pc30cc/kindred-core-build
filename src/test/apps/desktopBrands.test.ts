/**
 * One source, two desktop apps per platform: WebYar and RESPOK
 * (windows-native/Directory.Build.props, macos/project.yml). These checks keep
 * the pieces that name a brand in step, so a new line of copy, a new target
 * setting or a moved feed cannot leave RESPOK saying "Webyar" or updating
 * from WebYar's feed. (The Windows Core tests prove the same inside each
 * build: windows-native/tests/Webyar.Core.Tests/BrandTests.cs.)
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { NATIVE_APP_BRANDS, pointsAtWebyar } from '../../../shared/nativeAppBrands';

const root = path.resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, Record<string, string>>;

const WEBYAR = /webyar|web yar|وب[‌ ]?یار|وبیار/i;

const SHARED = 'windows-native/src/Webyar.Core/Localization/strings.json';
const SHARED_RESPOK = 'windows-native/src/Webyar.Core/Localization/strings.respok.json';
const MAC = ['macos/Webyar/Resources/mac-strings.json', 'macos/Webyar/Resources/calls-strings.json', 'macos/Webyar/Resources/email-strings.json'];
const MAC_RESPOK = 'macos/Brands/Respok/mac-strings.respok.json';

function merged(files: string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const f of files) for (const [lang, lines] of Object.entries(json(f))) Object.assign((out[lang] ??= {}), lines);
  return out;
}

/** Every line that names WebYar must have RESPOK's wording, which never names WebYar. */
function expectCovered(base: Record<string, Record<string, string>>, overlay: Record<string, Record<string, string>>) {
  for (const [lang, lines] of Object.entries(base)) {
    for (const [key, text] of Object.entries(lines)) {
      if (!WEBYAR.test(text)) continue;
      expect(overlay[lang]?.[key], `${lang}.${key} names WebYar and has no RESPOK wording`).toBeTruthy();
    }
  }
  for (const [lang, lines] of Object.entries(overlay)) {
    for (const [key, text] of Object.entries(lines)) {
      expect(base[lang]?.[key], `${lang}.${key} is not a line of the base table`).toBeDefined();
      expect(WEBYAR.test(text), `${lang}.${key}: ${text}`).toBe(false);
      expect(text).toMatch(/RESPOK/);
    }
  }
}

describe('RESPOK wording', () => {
  it('covers every line of the shared table (Windows and Mac) that names WebYar', () => {
    expectCovered(json(SHARED), json(SHARED_RESPOK));
  });

  it('covers every Mac-only line that names WebYar', () => {
    expectCovered(merged(MAC), json(MAC_RESPOK));
  });

  it('never lets a Windows sentence replace a Mac one', () => {
    // The Mac lays strings.respok.json first, then mac-strings.respok.json
    // (Strings.swift): a key the Mac words itself must be worded for RESPOK by the Mac overlay.
    const mac = merged(MAC);
    const macRespok = json(MAC_RESPOK);
    for (const [lang, lines] of Object.entries(json(SHARED_RESPOK))) {
      for (const key of Object.keys(lines)) {
        if (mac[lang]?.[key] !== undefined) expect(macRespok[lang]?.[key], `${lang}.${key}`).toBeDefined();
      }
    }
  });

  it('uses Turkish suffixes that agree with RESPOK', () => {
    const tr = json(SHARED_RESPOK).tr;
    expect(tr.trayOpen).toBe("RESPOK'u aç");
    expect(tr.signOutConfirm).toBe("RESPOK'tan çıkılsın mı?");
    expect(tr.updateRequiredBody.startsWith("RESPOK'un ")).toBe(true);
    for (const text of Object.values(tr)) expect(text).not.toMatch(/RESPOK['’](ı|ın|dan)\b/);
  });
});

/** The parts of an XcodeGen target these checks read (macos/project.yml). */
interface XcodeTarget {
  dependencies: unknown[];
  sources: (string | { path: string })[];
  info: { properties: Record<string, unknown> };
  entitlements: { properties: Record<string, unknown> };
  settings: { base: Record<string, string | undefined> };
}

describe('the Mac targets', () => {
  const project = parseYaml(read('macos/project.yml')) as {
    targets: Record<string, XcodeTarget>;
    schemes: Record<string, { build: { targets: Record<string, unknown> } }>;
  };
  const webyar = project.targets.Webyar;
  const respok = project.targets.Respok;

  it('builds RESPOK as its own app', () => {
    expect(respok.settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe('com.respok.mac');
    expect(respok.settings.base.PRODUCT_NAME).toBe('RESPOK');
    expect(respok.settings.base.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toMatch(/\bBRAND_RESPOK\b/);
    expect(respok.info.properties.CFBundleDisplayName).toBe('RESPOK');
    expect(JSON.stringify(respok.info.properties)).not.toMatch(WEBYAR);
    expect(project.schemes.Respok.build.targets.Respok).toBe('all');
    // WebYar's target is untouched.
    expect(webyar.settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe('com.webyar.mac');
    expect(webyar.settings.base.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toBeUndefined();
  });

  it('shares every source, package and entitlement with WebYar', () => {
    expect(respok.dependencies).toEqual(webyar.dependencies);
    expect(respok.entitlements.properties).toEqual(webyar.entitlements.properties);
    const paths = (t: XcodeTarget) => t.sources.map((s) => (typeof s === 'string' ? s : s.path));
    for (const p of paths(webyar)) expect(paths(respok)).toContain(p);
    for (const p of [SHARED_RESPOK, MAC_RESPOK]) {
      expect(paths(respok)).toContain(path.relative('macos', p));
      expect(paths(webyar)).not.toContain(path.relative('macos', p));
    }
  });

  it('has RESPOK icons from the brand kit', () => {
    const set = 'macos/Brands/Respok/Assets.xcassets/AppIcon.appiconset';
    const contents = JSON.parse(read(`${set}/Contents.json`)) as { images: { filename: string }[] };
    expect(contents.images).toHaveLength(10);
    for (const image of contents.images) expect(existsSync(path.join(root, set, image.filename)), image.filename).toBe(true);
    expect(existsSync(path.join(root, 'macos/Brands/Respok/Assets.xcassets/BrandMark.imageset/brandmark.png'))).toBe(true);
  });
});

describe('feeds and downloads agree everywhere', () => {
  const brandCs = read('windows-native/src/Webyar.Core/Config/Brand.cs');
  const [respokCs, webyarCs] = brandCs.split('#if BRAND_RESPOK')[1].split('#endif')[0].split('#else');
  const brandSh = read('macos/scripts/brand.sh');
  const sync = read('deploy/app-downloads/sync-downloads.sh');
  const workflows = read('.github/workflows/desktop-native.yml') + read('.github/workflows/macos.yml');
  const csConst = (block: string, name: string) => block.match(new RegExp(`${name} = "([^"]+)"`))?.[1];

  it('Windows: the server default, the app build and CI name the same repository per brand', () => {
    for (const [edition, block] of [['iran', webyarCs], ['international', respokCs]] as const) {
      const repo = csConst(block, 'ReleasesRepo')!;
      expect(NATIVE_APP_BRANDS[edition].windowsFeedUrl).toBe(`https://github.com/${repo}/releases/latest/download`);
      expect(workflows).toContain(`repo: ${repo}`);
      expect(sync).toContain(`${repo} ${NATIVE_APP_BRANDS[edition].windowsSetupFile}`);
      expect(csConst(block, 'SetupName') + '.exe').toBe(NATIVE_APP_BRANDS[edition].windowsSetupFile);
    }
    expect(csConst(respokCs, 'ApiOrigin')).toBe('https://api.respok.app');
    expect(csConst(respokCs, 'SiteFeed')).toBe('https://app.respok.app/downloads/windows');
    expect(csConst(webyarCs, 'ApiOrigin')).toBe('https://api.webyar.ai');
    expect(csConst(webyarCs, 'SiteFeed')).toBe('https://app.webyar.ai/downloads/windows');
  });

  it('Mac: the server default appcast is where the scripts and CI publish', () => {
    expect(brandSh).toContain('FEED_REPO=pc30cc/mac-os');
    expect(NATIVE_APP_BRANDS.iran.macAppcastUrl).toBe('https://raw.githubusercontent.com/pc30cc/mac-os/main/appcast.xml');
    expect(brandSh).toMatch(/FEED_REPO=pc30cc\/respok-releases[\s\S]*FEED_SUBDIR=mac/);
    expect(NATIVE_APP_BRANDS.international.macAppcastUrl).toBe('https://raw.githubusercontent.com/pc30cc/respok-releases/main/mac/appcast.xml');
    for (const edition of ['iran', 'international'] as const) expect(sync).toContain(NATIVE_APP_BRANDS[edition].macAppcastUrl);
    expect(workflows).toContain('feed_repo: pc30cc/respok-releases');
  });

  it('each site serves its own brand\'s installer, DMG and zips (Android\'s too), and never the other brand\'s', () => {
    const nginx = read('deploy/app-downloads/nginx.conf');
    const traefik = read('deploy/app-downloads/traefik-app-downloads.yaml');
    for (const [edition, host] of [['iran', 'app.webyar.ai'], ['international', 'app.respok.app']] as const) {
      const brand = NATIVE_APP_BRANDS[edition];
      // The sync script's brand line ends with the file prefix it names the files with and the
      // site whose APK it zips.
      const line = sync.match(new RegExp(`^\\w+ \\S+ ${brand.windowsSetupFile} \\S+ (\\S+) (\\S+)$`, 'm'));
      const prefix = line?.[1];
      expect(prefix, brand.name).toBeDefined();
      expect(line?.[2]).toBe(host);
      expect(brand.windowsSetupFile).toBe(`${prefix}-Setup.exe`);
      expect(brand.windowsDownloadFile).toBe(`${prefix}-Windows.zip`);
      expect(brand.macDownloadFile).toBe(`${prefix}-Mac.zip`);
      expect(nginx).toMatch(new RegExp(`^\\s*${host.replace(/\./g, '\\.')}\\s+${edition === 'iran' ? 'webyar' : 'respok'};`, 'm'));
      // Traefik sends this host's zips, old links and update feed to the mirror, and no other brand's.
      const hostRules = traefik.split('\n').filter((l) => l.includes(`Host(\`${host}\`)`));
      const rules = hostRules.filter((l) => l.includes('PathRegexp'));
      expect(rules).toHaveLength(2);
      // The other brand's file names on this host (e.g. the frontend's Webyar-Android.apk on
      // app.respok.app) are sent to app-downloads, which has none for this host: 404.
      const foreign = hostRules.filter((l) => !l.includes('PathRegexp'));
      expect(foreign).toHaveLength(2);
      for (const rule of foreign) expect(rule).toContain(`PathPrefix(\`/downloads/${edition === 'iran' ? 'RESPOK-' : 'Webyar-'}\`)`);
      for (const rule of rules) {
        expect(rule).toContain(`${prefix}-(Windows|Mac|Android)`);
        expect(rule).toContain(`${prefix}-Setup`);
        expect(rule).toContain('windows/(releases');
        expect(rule).not.toContain(edition === 'iran' ? 'RESPOK-' : 'Webyar-');
      }
    }
    expect(nginx).toContain('-(Windows|Mac|Android)(-[0-9][A-Za-z0-9.\\-]*)?\\.zip)$');
    // The installer and the DMG are served as they are, not redirected to their zips.
    expect(nginx).toContain('-Setup(-[0-9][A-Za-z0-9.\\-]*)?\\.exe)$');
    expect(nginx).toContain('-Mac(-[0-9][A-Za-z0-9.\\-]*)?\\.dmg)$');
    expect(nginx).not.toContain('return 302');
    expect(nginx).toContain('absolute_redirect off;');
    // The mirror keeps them, and zips each brand's APK after checking its sha256.
    expect(sync).toContain('ln -sfn "$exe" "$FILES/$4-Setup.exe"');
    expect(sync).toContain('ln -sfn "$dmg" "$FILES/$3-Mac.dmg"');
    expect(sync).toContain('ln -sfn "$zip" "$FILES/$3-Android.zip"');
    expect(sync).toContain('sha256sum');
  });

  it('nothing of RESPOK points at WebYar', () => {
    expect(Object.values(NATIVE_APP_BRANDS.international).some(pointsAtWebyar)).toBe(false);
    expect(respokCs).not.toMatch(/webyar/i);
  });

  it('Windows icons exist for both brands under the same names', () => {
    for (const brand of ['Webyar', 'Respok'])
      for (const f of ['icon.png', 'app.ico', 'app-calls.ico'])
        expect(existsSync(path.join(root, 'windows-native/src/Webyar.App/Assets/Brand', brand, f)), `${brand}/${f}`).toBe(true);
  });
});
