/**
 * One source, two iPhone apps: WebYar (the `Webyar` target, exactly as it
 * was) and RESPOK (the `Respok` target, BRAND_RESPOK), installable side by
 * side — the same split as the Mac app (src/test/apps/desktopBrands.test.ts).
 *
 * These checks keep the pieces that name a brand in step, so a new line of
 * copy, a new target setting or a new stored identifier cannot leave RESPOK
 * saying "Webyar", talking to a WebYar host, or move WebYar's own values
 * (which would sign every WebYar phone out). There is no Xcode here: what can
 * be read from the project spec and the sources is read; the build itself is
 * .github/workflows/ios.yml's.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const APP = 'ios/Webyar';
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
/** Swift with its comments removed: this code explains at length what it does NOT do. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const WEBYAR = /webyar|web yar|وب[‌ ]?یار|وبیار|وب\\u\{200C\}یار/i;

function swiftFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(p);
    return entry.name.endsWith('.swift') ? [p] : [];
  });
}

interface XcodeTarget {
  type: string;
  platform: string;
  dependencies: unknown[];
  sources: (string | { path: string; buildPhase?: string; excludes?: string[] })[];
  info: { path: string; properties: Record<string, unknown> };
  entitlements: { path: string; properties: Record<string, unknown> };
  settings: { base: Record<string, string | undefined>; configs?: Record<string, Record<string, string>> };
}

const project = parseYaml(read(`${APP}/project.yml`)) as {
  targets: Record<string, XcodeTarget>;
  schemes: Record<string, { build: { targets: Record<string, unknown> }; test?: { targets: string[] } }>;
};
const webyar = project.targets.Webyar;
const respok = project.targets.Respok;
const sourcePaths = (t: XcodeTarget) => t.sources.map((s) => (typeof s === 'string' ? { path: s } : s));

describe('the Respok target', () => {
  it('builds RESPOK as its own app, beside WebYar', () => {
    expect(respok.type).toBe('application');
    expect(respok.platform).toBe('iOS');
    expect(respok.settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe('com.respok.app');
    // RESPOK.app: the name under the icon's fallback, CFBundleName and the
    // default User-Agent ("RESPOK/<build> CFNetwork/…").
    expect(respok.settings.base.PRODUCT_NAME).toBe('RESPOK');
    // $(inherited) keeps DEBUG in Debug builds.
    expect(respok.settings.base.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toBe('$(inherited) BRAND_RESPOK');
    expect(respok.info.properties.CFBundleDisplayName).toBe('RESPOK');
    expect(JSON.stringify(respok.info.properties)).not.toMatch(WEBYAR);
    expect(project.schemes.Respok.build.targets.Respok).toBe('all');
    // WebYar's target is untouched.
    expect(webyar.settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe('com.webyar.ai');
    expect(webyar.settings.base.PRODUCT_NAME).toBeUndefined();
    expect(webyar.settings.base.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toBeUndefined();
    expect(webyar.info.properties.CFBundleDisplayName).toBe('Webyar');
  });

  it('writes its own Info.plist and entitlements, beside WebYar\'s, where git ignores them', () => {
    expect(respok.info.path).not.toBe(webyar.info.path);
    expect(respok.entitlements.path).not.toBe(webyar.entitlements.path);
    const ignored = read('.gitignore');
    expect(ignored).toContain('ios/Webyar/Generated/');
    for (const p of [respok.info.path, respok.entitlements.path, webyar.info.path, webyar.entitlements.path]) {
      expect(p.startsWith('Generated/'), p).toBe(true);
    }
  });

  it('has WebYar\'s Info.plist, entitlements, packages and settings, with RESPOK\'s name', () => {
    expect(respok.dependencies).toEqual(webyar.dependencies);
    expect(respok.entitlements.properties).toEqual(webyar.entitlements.properties);
    expect(respok.settings.configs).toEqual(webyar.settings.configs);
    const rename = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/Webyar/g, 'RESPOK'));
    expect(respok.info.properties).toEqual(rename(webyar.info.properties));
    const { PRODUCT_NAME: _n, PRODUCT_BUNDLE_IDENTIFIER: _r, SWIFT_ACTIVE_COMPILATION_CONDITIONS: _c, ...respokRest } = respok.settings.base;
    const { PRODUCT_BUNDLE_IDENTIFIER: _w, ...webyarRest } = webyar.settings.base;
    expect(respokRest).toEqual(webyarRest);
  });

  it('shares every Swift file and resource, and swaps WebYar\'s art and home-screen wording for its own', () => {
    const w = sourcePaths(webyar);
    const r = sourcePaths(respok);
    for (const s of w) expect(r.map((x) => x.path)).toContain(s.path);
    expect(r.find((s) => s.path === 'Sources')?.excludes ?? []).toEqual([]);
    const resources = r.find((s) => s.path === 'Resources')!;
    expect(resources.buildPhase).toBe('resources');
    expect(resources.excludes?.sort()).toEqual(['*.lproj/InfoPlist.strings', 'Assets.xcassets']);
    expect(r).toContainEqual({ path: 'Brands/Respok', buildPhase: 'resources' });
    expect(w.map((s) => s.path)).not.toContain('Brands/Respok');
  });

  it('keeps the tests on WebYar\'s build, where `@testable import Webyar` points', () => {
    for (const name of ['WebyarTests', 'WebyarUITests']) {
      expect(project.targets[name].dependencies).toEqual([{ target: 'Webyar' }]);
    }
    expect(project.schemes.Respok.test).toBeUndefined();
  });
});

describe('the two asset catalogs', () => {
  const CATALOGS = { Webyar: `${APP}/Resources/Assets.xcassets`, Respok: `${APP}/Brands/Respok/Assets.xcassets` };
  const sets = (catalog: string) =>
    readdirSync(path.join(root, catalog), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

  it('hold the same sets, so the shared code finds every one in either app', () => {
    expect(sets(CATALOGS.Respok)).toEqual(sets(CATALOGS.Webyar));
    // Every set the code or the Info.plist names by string.
    const named = new Set<string>();
    for (const f of swiftFiles(`${APP}/Sources`)) {
      for (const m of code(read(f)).matchAll(/\b(?:Color|Image|UIImage|UIColor)\(\s*(?:named:\s*)?"([A-Za-z][\w-]*)"/g)) named.add(m[1]);
    }
    const launch = respok.info.properties.UILaunchScreen as Record<string, string>;
    named.add(launch.UIColorName);
    named.add(launch.UIImageName);
    named.add(respok.settings.base.ASSETCATALOG_COMPILER_APPICON_NAME!);
    named.add(respok.settings.base.ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME!);
    expect([...named].sort()).toEqual(['AccentColor', 'AppIcon', 'BrandLogo', 'BrandMark', 'LaunchBackground', 'LaunchLoader']);
    for (const [brand, catalog] of Object.entries(CATALOGS)) {
      for (const name of named) {
        expect(sets(catalog).some((s) => s.replace(/\.\w+$/, '') === name), `${brand} has no ${name}`).toBe(true);
      }
    }
  });

  it('draw the mark from the brand kit\'s vector symbol', () => {
    for (const catalog of Object.values(CATALOGS)) {
      const set = `${catalog}/BrandMark.imageset`;
      const contents = JSON.parse(read(`${set}/Contents.json`));
      expect(contents.properties['preserves-vector-representation']).toBe(true);
      expect(contents.images).toHaveLength(1);
      expect(contents.images[0].filename).toMatch(/\.pdf$/);
      expect(readFileSync(path.join(root, set, contents.images[0].filename)).subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('keep the interface\'s accent the same blue in both (the UI theme, not the brand art)', () => {
    expect(read(`${CATALOGS.Respok}/AccentColor.colorset/Contents.json`)).toBe(read(`${CATALOGS.Webyar}/AccentColor.colorset/Contents.json`));
    expect(read(`${CATALOGS.Respok}/LaunchBackground.colorset/Contents.json`)).toBe(read(`${CATALOGS.Webyar}/LaunchBackground.colorset/Contents.json`));
  });

  it('nothing RESPOK bundles of its own names WebYar', () => {
    const walk = (dir: string): string[] =>
      readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
      );
    for (const f of walk(`${APP}/Brands/Respok`).filter((f) => /\.(json|strings)$/.test(f))) {
      expect(read(f), f).not.toMatch(WEBYAR);
    }
  });
});

describe('AppBrand', () => {
  const brand = code(read(`${APP}/Sources/Core/Config/AppBrand.swift`));
  const [, respokBlock, webyarBlock] = brand.match(/enum AppBrand \{\s*#if BRAND_RESPOK([\s\S]*?)#else([\s\S]*?)#endif/) ?? [];
  const value = (block: string, name: string) => block.match(new RegExp(`static let ${name}(?:: [\\w?]+)? = "?([^"\\n]+?)"?\\s*\\n`))?.[1];

  it('keeps every value WebYar already stores on phones, byte for byte', () => {
    // Changing one signs every WebYar operator out or throws their caches away.
    expect(value(webyarBlock, 'id')).toBe('webyar'); // and so the mail reader's webyar-attachment: / webyar-inline:
    expect(value(webyarBlock, 'keychainService')).toBe('com.webyar.ai.session');
    expect(value(webyarBlock, 'logSubsystem')).toBe('com.webyar.ai');
    expect(value(webyarBlock, 'cacheFolder')).toBe('Webyar');
    expect(value(webyarBlock, 'imageCacheFolder')).toBe('webyar-images');
    expect(value(webyarBlock, 'tempPrefix')).toBe('webyar');
    expect(value(webyarBlock, 'realtimeName')).toBe('webyar-ios');
    expect(value(webyarBlock, 'jalaliDates')).toBe('true');
    expect(value(webyarBlock, 'wordmark')).toBe(read(`${APP}/Sources/Localization/Strings.swift`).match(/static let brandWordmark = "([^"]+)"/)?.[1]);
    expect(value(webyarBlock, 'wordmarkSuffix')).toBe('AI');
  });

  it('gives RESPOK its own, none of them WebYar\'s', () => {
    expect(value(respokBlock, 'id')).toBe('respok');
    expect(value(respokBlock, 'keychainService')).toBe('com.respok.app.session');
    expect(value(respokBlock, 'logSubsystem')).toBe('com.respok.app');
    expect(value(respokBlock, 'cacheFolder')).toBe('Respok');
    expect(value(respokBlock, 'imageCacheFolder')).toBe('respok-images');
    expect(value(respokBlock, 'realtimeName')).toBe('respok-ios');
    expect(value(respokBlock, 'wordmark')).toBe('RESPOK');
    expect(value(respokBlock, 'wordmarkSuffix')).toBe('nil');
    expect(value(respokBlock, 'jalaliDates')).toBe('false');
    for (const line of respokBlock.split('\n').filter((l) => l.includes('static let'))) expect(line).not.toMatch(WEBYAR);
  });

  it('is where those values are read from, not literals scattered through the app', () => {
    const uses: Record<string, string> = {
      'Core/Storage/TokenStore.swift': 'AppBrand.keychainService',
      'Core/Cache/CachePolicy.swift': 'AppBrand.cacheFolder',
      'DesignSystem/Components/RemoteImage.swift': 'AppBrand.imageCacheFolder',
      'Core/Realtime/Realtime.swift': 'AppBrand.realtimeName',
      'Core/Cache/AttachmentStore.swift': 'AppBrand.tempPrefix',
      'Core/Networking/APIClient.swift': 'AppBrand.tempPrefix',
      'DesignSystem/Typeface.swift': 'AppBrand.logSubsystem',
      'Features/Email/EmailReader.swift': 'AppBrand.id',
    };
    for (const [file, use] of Object.entries(uses)) expect(code(read(`${APP}/Sources/${file}`)), file).toContain(use);
    for (const f of swiftFiles(`${APP}/Sources`)) {
      if (/AppBrand\.swift$|SampleAPI\.swift$|Localization\/(Strings|SupportStrings)\.swift$/.test(f)) continue;
      expect(code(read(f)), f).not.toMatch(/"(com\.webyar\.ai[^"]*|webyar-images|webyar-ios|Webyar|webyar-[^"]*\\\()"/);
    }
  });

  it('keeps the notification categories the server sends, in both apps', () => {
    const push = read(`${APP}/Sources/Core/Push/PushController.swift`);
    for (const id of ['WEBYAR_MESSAGE', 'WEBYAR_MENTION', 'WEBYAR_TEAM', 'WEBYAR_EMAIL']) {
      expect(push).toContain(`identifier: "${id}"`);
    }
  });

  it('dates Persian in the Persian calendar for WebYar only', () => {
    const language = code(read(`${APP}/Sources/Localization/Language.swift`));
    expect(language).toContain('case .fa: Locale(identifier: AppBrand.jalaliDates ? "fa_IR" : "fa_IR@calendar=gregorian")');
    // The one explicit Persian calendar asks the brand too.
    for (const f of swiftFiles(`${APP}/Sources`)) {
      for (const line of code(read(f)).split('\n').filter((l) => /\.persian\b/.test(l))) {
        expect(line, f).toContain('AppBrand.jalaliDates');
      }
    }
  });
});

describe('BrandStr', () => {
  const brandStr = read(`${APP}/Sources/Localization/BrandStr.swift`);
  const tables: Record<string, string> = {
    Str: read(`${APP}/Sources/Localization/Strings.swift`),
    SupportStr: read(`${APP}/Sources/Localization/SupportStrings.swift`),
  };
  const overlay = JSON.parse(read('windows-native/src/Webyar.Core/Localization/strings.respok.json')) as Record<string, Record<string, string>>;
  const unescape = (s: string) => s.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));

  /** Every function of a table whose WebYar wording names the product. */
  const branded = Object.entries(tables).flatMap(([table, swift]) =>
    [...swift.matchAll(/static func (\w+)\(_ l: Language\) -> String \{([\s\S]*?)\n {4}\}/g)]
      .filter(([, , body]) => WEBYAR.test(unescape(body)))
      .map(([, name]) => ({ table, name })),
  );
  /** The RESPOK branch of a BrandStr function, language → literal (or the WebYar call it keeps). */
  const respokCases = (name: string) => {
    const fn = brandStr.match(new RegExp(`static func ${name}\\(_ l: Language\\) -> String \\{([\\s\\S]*?)\\n {4}\\}`))?.[1] ?? '';
    const [, respokBranch = '', webyarBranch = ''] = fn.match(/#if BRAND_RESPOK([\s\S]*?)#else([\s\S]*?)#endif/) ?? [];
    const cases: Record<string, string> = {};
    for (const m of respokBranch.matchAll(/case \.(\w+): return (?:"(.*)"|(.*))$/gm)) cases[m[1]] = m[2] ?? `=${m[3]}`;
    return { cases, webyarBranch: webyarBranch.trim() };
  };

  it('finds the product-naming lines to check', () => {
    expect(branded.map((b) => b.name).sort()).toEqual(
      ['appName', 'greetingBody', 'pushDeniedTitle', 'pushPresenceFooter', 'pushPrimerBody', 'signOutConfirm'],
    );
  });

  it('has a RESPOK line for every line that names WebYar, in every language, and WebYar\'s own otherwise', () => {
    for (const { table, name } of branded) {
      if (name === 'appName') {
        expect(brandStr).toMatch(/static func appName[\s\S]*?#if BRAND_RESPOK\s*return AppBrand\.name\s*#else\s*return Str\.appName\(l\)/);
        continue;
      }
      const { cases, webyarBranch } = respokCases(name);
      expect(webyarBranch, name).toBe(`return ${table}.${name}(l)`);
      for (const l of ['en', 'fa', 'tr', 'ar']) {
        const text = cases[l];
        expect(text, `${name}.${l}`).toBeDefined();
        const original = unescape(tables[table].match(new RegExp(`static func ${name}\\(_ l: Language\\) -> String \\{([\\s\\S]*?)\\n {4}\\}`))![1]
          .match(new RegExp(`case (?:\\.\\w+, )*\\.${l}(?:, \\.\\w+)*: "(.*)"`))![1]);
        if (text.startsWith('=')) {
          // Kept as WebYar's: only where WebYar's line does not name the product.
          expect(text, `${name}.${l}`).toBe(`=${table}.${name}(l)`);
          expect(original, `${name}.${l} names WebYar`).not.toMatch(WEBYAR);
          continue;
        }
        expect(text, `${name}.${l}`).not.toMatch(WEBYAR);
        expect(text, `${name}.${l}`).toContain('RESPOK');
        // The desktop apps' wording where they have the line (en, fa, tr).
        if (overlay[l]?.[name] !== undefined) expect(text, `${name}.${l}`).toBe(overlay[l][name]);
      }
    }
  });

  it('no other table of copy names the product (it would need a RESPOK line here)', () => {
    for (const f of swiftFiles(`${APP}/Sources/Localization`)) {
      if (/\/(BrandStr|Strings|SupportStrings)\.swift$/.test(f)) continue;
      for (const m of code(read(f)).matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
        expect(unescape(m[1]), f).not.toMatch(WEBYAR);
      }
    }
  });

  it('uses Turkish suffixes that agree with RESPOK', () => {
    expect(respokCases('signOutConfirm').cases.tr).toBe("RESPOK'tan çıkılsın mı?");
    expect(brandStr).not.toMatch(/RESPOK['’](ı|ın|dan)\b/);
  });

  it('is the only way the views reach those lines', () => {
    // A view calling Str.signOutConfirm directly would say "Webyar" in RESPOK.
    const names = branded.map((b) => `${b.table}\\.${b.name}`).concat('Str\\.brandWordmark');
    const direct = new RegExp(`(?<![A-Za-z])(${names.join('|')})\\b`);
    const offenders = swiftFiles(`${APP}/Sources`)
      .filter((f) => !/Localization\/(BrandStr|Strings|SupportStrings)\.swift$/.test(f))
      .filter((f) => direct.test(code(read(f))));
    expect(offenders).toEqual([]);
    // And Strings.swift stays a table of plain literals for the Android generator:
    // no brand branches in it.
    expect(tables.Str).not.toContain('BRAND_RESPOK');
    expect(tables.Str).not.toContain('AppBrand');
  });
});

describe('the RESPOK footer and loader', () => {
  it('signs RESPOK with its logo, and WebYar with its wordmark as before', () => {
    const footer = code(read(`${APP}/Sources/DesignSystem/Components/BrandFooter.swift`));
    expect(footer).toContain('Image("BrandLogo")');
    expect(footer).toContain('Text(verbatim: BrandStr.brandWordmark)');
    expect(footer).toContain('if let suffix = AppBrand.wordmarkSuffix');
    // Each catalog's BrandLogo is its own kit's logo, light and reversed (dark).
    for (const dir of ['Brands/Respok/Assets.xcassets', 'Resources/Assets.xcassets']) {
      const logo = JSON.parse(read(`${APP}/${dir}/BrandLogo.imageset/Contents.json`));
      expect(logo.images.map((i: { filename: string }) => i.filename)).toEqual(['brandlogo.pdf', 'brandlogo-dark.pdf']);
    }
  });

  it('sign in and password reset wear each brand\'s own colours', () => {
    const footer = code(read(`${APP}/Sources/DesignSystem/Components/BrandFooter.swift`));
    expect(footer).toContain('enum AuthPalette');
    const login = code(read(`${APP}/Sources/Features/Auth/LoginView.swift`));
    expect(login).toContain('isAuth: true');
    expect(login).toContain('.foregroundStyle(AuthPalette.link)');
    const reset = code(read(`${APP}/Sources/Features/Auth/PasswordResetView.swift`));
    expect(reset.match(/isAuth: true/g)?.length).toBe(2);
  });

  it('draws the launch image in each brand\'s own catalog', () => {
    expect(existsSync(path.join(root, APP, 'Brands/Respok/Assets.xcassets/LaunchLoader.imageset/Contents.json'))).toBe(true);
    const renderer = read('scripts/ios/render-launch-loader.py');
    expect(renderer).toContain("'Brands', 'Respok', 'Assets.xcassets', 'LaunchLoader.imageset'");
    expect(renderer).toContain("'Resources', 'Assets.xcassets', 'LaunchLoader.imageset'");
  });
});
