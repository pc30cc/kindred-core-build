/**
 * One source, two Android apps: WebYar and RESPOK, the `webyar` and `respok`
 * product flavors of android/app/build.gradle.kts. These checks keep the
 * pieces that name a brand in step, so a new line of copy, a new icon density
 * or a new CI step cannot leave RESPOK's app saying "Webyar", wearing WebYar's
 * icon, signed with WebYar's key or untested.
 *
 * RESPOK's APK must not contain WebYar's name at all, so everything that names
 * WebYar lives in WebYar's own flavor (android/app/src/webyar, its block of
 * the build script) and the shared code (src/main, package com.platform.app)
 * names neither brand. android/tools/check-brand-neutral.sh proves that for
 * the sources and for the built APK (CI runs it on both); the app's own unit
 * tests prove the rest inside each build (src/test/.../BrandStrTest.kt,
 * AppBrandRulesTest.kt, each flavor's AppBrandTest.kt and RESPOK's
 * BrandCopyTest.kt). The desktop apps' counterpart is desktopBrands.test.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_APP_BRANDS } from '../../../shared/nativeAppBrands';

const root = path.resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

const APP = 'android/app';
const MAIN = `${APP}/src/main`;
const WEBYAR_SRC = `${APP}/src/webyar`;
const RESPOK = `${APP}/src/respok`;
const PKG = 'kotlin/com/platform/app';
const KOTLIN = `${MAIN}/${PKG}`;

/** WebYar in any spelling (shared/nativeAppBrands.ts): not the Turkish "Web yardım". */
const WEBYAR = /[Ww][Ee][Bb] ?[Yy][Aa][Rr](?!\p{Ll})|وب[‌ ]?یار|وبیار/u;

const gradle = read(`${APP}/build.gradle.kts`);

/** The body of `create("<name>") { … }` in the build script, braces balanced. */
function block(source: string, opener: string): string {
  const start = source.indexOf(opener);
  expect(start, `${opener} is missing`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${opener} never closes`);
}

/** Every file under a folder. */
function files(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(path.join(root, dir))) return out;
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

const kotlinFiles = (dir: string) => files(dir).filter((f) => f.endsWith('.kt'));

/** `fun name(l: Language): String` functions of a string table. */
const functionNames = (source: string) => new Set([...source.matchAll(/fun (\w+)\(l: Language\)/g)].map((m) => m[1]));

/** The string literals on a file's code lines (comment lines skipped). */
function literals(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .flatMap((line) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
}

describe('the two flavors', () => {
  const flavors = {
    iran: block(gradle, 'create("webyar")'),
    international: block(gradle, 'create("respok")'),
  } as const;

  it('build each brand as its own app, as Super Admin names it', () => {
    for (const [edition, body] of Object.entries(flavors) as [keyof typeof flavors, string][]) {
      const brand = NATIVE_APP_BRANDS[edition];
      expect(gradle).toContain(`create("${brand.androidFlavor}")`);
      expect(body).toContain(`applicationId = "${brand.androidPackage}"`);
      expect(body).toContain('dimension = "brand"');
    }
    // One code package for both, named after neither: it is in every APK
    // (R, BuildConfig, the ProGuard rules and the Room schema name it).
    expect(gradle).toMatch(/namespace = "com\.platform\.app"/);
    expect(existsSync(path.join(root, `${APP}/schemas/com.platform.app.core.cache.CacheDatabase/1.json`))).toBe(true);
  });

  it('give WebYar exactly what it shipped with, and RESPOK its own', () => {
    const w = flavors.iran;
    expect(w).toContain('literal("https://api.webyar.ai")');
    expect(w).toContain('"DEFAULT_LANGUAGE", literal("fa")');
    expect(w).toContain('"JALALI_DATES", "true"');
    expect(w).toContain('releaseInt("webyar.versionCode", "WEBYAR_VERSION_CODE") ?: 1');
    expect(w).toContain('firebase("webyar", "WEBYAR")');

    const r = flavors.international;
    expect(r).toContain('literal("https://api.respok.app")');
    expect(r).toContain('"DEFAULT_LANGUAGE", literal("en")');
    expect(r).toContain('"JALALI_DATES", "false"');
    expect(r).toContain('releaseInt("respok.versionCode", "RESPOK_VERSION_CODE")');
    expect(r).toContain('firebase("respok", "RESPOK")');
    // RESPOK never names WebYar: no host, no Firebase names, no storage names.
    expect(r).not.toMatch(/webyar/i);
  });

  it("keep WebYar's names on the phone, and give RESPOK neutral ones", () => {
    // Renaming one of WebYar's signs every operator out, drops their cache or
    // leaves their notification settings on a channel nothing posts to.
    const shipped: Record<string, [string, string]> = {
      STORE_NAME: ['webyar', 'settings'],
      KEY_ALIAS: ['com.webyar.ai.session', 'app.session'],
      CACHE_DATABASE: ['webyar-cache.db', 'cache.db'],
      PUSH_PREFS: ['webyar.firebase', 'push.firebase'],
      PROMO_PREFS: ['webyar.promotions', 'promotions'],
      CHANNEL_MESSAGES: ['webyar_messages', 'messages'],
      CHANNEL_CALLS: ['webyar_calls', 'calls'],
      CALL_ACTION_PREFIX: ['com.webyar.ai.call', 'app.call'],
    };
    for (const [field, [iran, international]] of Object.entries(shipped)) {
      expect(flavors.iran).toContain(`buildConfigField("String", "${field}", literal("${iran}"))`);
      expect(flavors.international).toContain(`buildConfigField("String", "${field}", literal("${international}"))`);
    }
    expect(flavors.iran).toContain('manifestPlaceholders["messagesChannel"] = "webyar_messages"');
    expect(flavors.international).toContain('manifestPlaceholders["messagesChannel"] = "messages"');
    // The channel the server names in every push is the flavor's.
    expect(read(`${MAIN}/AndroidManifest.xml`)).toContain('android:value="${messagesChannel}"');
  });

  it('sign each brand with its own key, never the other', () => {
    for (const name of ['KEYSTORE', 'KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) {
      expect(gradle).toContain(`System.getenv("\${env}_${name}")`);
    }
    expect(flavors.iran).toContain('signingConfig = releaseKey("webyar", "WEBYAR")');
    expect(flavors.iran).not.toContain('respok');
    expect(flavors.international).toContain('signingConfig = releaseKey("respok", "RESPOK")');
    // A build type's key would win over both flavors' keys.
    const release = block(gradle, 'release {');
    expect(release).not.toMatch(/^\s*signingConfig\s*=/m);
  });

  it('are both declared by the baseline profile producer', () => {
    const producer = read('android/baselineprofile/build.gradle.kts');
    for (const brand of Object.values(NATIVE_APP_BRANDS)) {
      const body = block(producer, `create("${brand.androidFlavor}")`);
      expect(body).toContain(`testInstrumentationRunnerArguments["targetAppId"] = "${brand.androidPackage}"`);
    }
  });
});

describe('the launcher entry', () => {
  it("keeps WebYar's home-screen icons: its old component name, as an alias, in WebYar's build only", () => {
    const main = read(`${MAIN}/AndroidManifest.xml`);
    expect(main).not.toContain('android.intent.category.LAUNCHER');
    const webyar = read(`${WEBYAR_SRC}/AndroidManifest.xml`);
    expect(webyar).toMatch(/<activity-alias\s+android:name="com\.webyar\.ai\.MainActivity"\s+android:targetActivity="com\.platform\.app\.MainActivity"/);
    expect(webyar).toContain('android.intent.category.LAUNCHER');
    // The target is declared before the alias (older Android requires it).
    expect(webyar.indexOf('<activity android:name="com.platform.app.MainActivity"')).toBeLessThan(webyar.indexOf('<activity-alias'));
    const respok = read(`${RESPOK}/AndroidManifest.xml`);
    expect(respok).toContain('<activity android:name="com.platform.app.MainActivity">');
    expect(respok).toContain('android.intent.category.LAUNCHER');
    expect(respok).not.toMatch(WEBYAR);
  });
});

describe('the brand art', () => {
  const mipmaps = readdirSync(path.join(root, `${WEBYAR_SRC}/res`)).filter((d) => d.startsWith('mipmap-'));

  it('is each flavor\'s own, none of it in src/main', () => {
    expect(readdirSync(path.join(root, `${MAIN}/res`)).filter((d) => d.startsWith('mipmap-'))).toEqual([]);
    for (const icon of ['ic_launcher_background', 'ic_launcher_foreground', 'ic_launcher_monochrome', 'ic_stat_brand']) {
      expect(existsSync(path.join(root, `${MAIN}/res/drawable/${icon}.xml`)), icon).toBe(false);
    }
    expect(existsSync(path.join(root, `${MAIN}/res/values/strings.xml`))).toBe(false);
    expect(existsSync(path.join(root, `${MAIN}/ic_launcher-playstore.png`))).toBe(false);
    expect(existsSync(path.join(root, `${WEBYAR_SRC}/ic_launcher-playstore.png`))).toBe(true);
    expect(existsSync(path.join(root, `${RESPOK}/ic_launcher-playstore.png`))).toBe(true);
  });

  it('covers every launcher icon in both flavors, at every density', () => {
    expect(mipmaps.length).toBeGreaterThanOrEqual(6);
    for (const dir of mipmaps) {
      for (const file of readdirSync(path.join(root, `${WEBYAR_SRC}/res/${dir}`))) {
        expect(existsSync(path.join(root, `${RESPOK}/res/${dir}/${file}`)), `RESPOK has no ${dir}/${file}`).toBe(true);
      }
    }
    for (const dir of readdirSync(path.join(root, `${RESPOK}/res`)).filter((d) => d.startsWith('mipmap-'))) {
      for (const file of readdirSync(path.join(root, `${RESPOK}/res/${dir}`))) {
        expect(existsSync(path.join(root, `${WEBYAR_SRC}/res/${dir}/${file}`)), `WebYar has no ${dir}/${file}`).toBe(true);
      }
    }
    expect(existsSync(path.join(root, `${WEBYAR_SRC}/res/drawable/ic_stat_brand.xml`))).toBe(true);
    expect(existsSync(path.join(root, `${RESPOK}/res/drawable/ic_stat_brand.xml`))).toBe(true);
  });

  it('names every layer the adaptive icons use', () => {
    for (const [dir, colors] of [
      [`${WEBYAR_SRC}/res`, `${WEBYAR_SRC}/res/values/colors.xml`],
      [`${RESPOK}/res`, `${RESPOK}/res/values/ic_launcher_background.xml`],
    ] as const) {
      for (const icon of ['ic_launcher', 'ic_launcher_round']) {
        const xml = read(`${dir}/mipmap-anydpi-v26/${icon}.xml`);
        for (const [, type, name] of xml.matchAll(/@(drawable|color|mipmap)\/(\w+)/g)) {
          const found =
            type === 'color'
              ? read(colors).includes(`name="${name}"`)
              : existsSync(path.join(root, `${dir}/drawable/${name}.xml`)) ||
                existsSync(path.join(root, `${MAIN}/res/drawable/${name}.xml`));
          expect(found, `${dir} ${icon}: @${type}/${name}`).toBe(true);
        }
      }
    }
  });

  it('gives each its name and launch colours', () => {
    expect(read(`${RESPOK}/res/values/strings.xml`)).toMatch(/<string name="app_name">RESPOK<\/string>/);
    expect(read(`${WEBYAR_SRC}/res/values/strings.xml`)).toMatch(/<string name="app_name">Webyar<\/string>/);
    for (const name of ['brand_deep', 'brand_bright', 'brand_deep_clear']) {
      expect(read(`${WEBYAR_SRC}/res/values/colors.xml`)).toContain(`name="${name}"`);
      expect(read(`${RESPOK}/res/values/colors.xml`)).toContain(`name="${name}"`);
      expect(read(`${MAIN}/res/values/colors.xml`)).not.toContain(`name="${name}"`);
    }
    expect(read(`${RESPOK}/res/values/colors.xml`)).toMatch(/name="brand_bright">#FFFF5A3C</);
    expect(read(`${WEBYAR_SRC}/res/values/colors.xml`)).toMatch(/name="brand_bright">#FF16C7A8</);
    // The loader drawable takes its colours from those, so one copy serves both brands.
    expect(read(`${MAIN}/res/drawable/launch_loader.xml`)).not.toMatch(/android:(stroke|fill)?[Cc]olor="#/);
  });
});

describe('copy that names the product', () => {
  const webyarCopy = read(`${WEBYAR_SRC}/${PKG}/i18n/BrandCopy.kt`);
  const respokCopy = read(`${RESPOK}/${PKG}/i18n/BrandCopy.kt`);
  const brandStr = read(`${KOTLIN}/i18n/BrandStr.kt`);
  const tables = ['Strings.kt', 'StringsManual.kt', 'StringsAndroid.kt', 'StringsInsights.kt', 'StringsEmail.kt'];

  it('is in no shared table: each flavor has its own BrandCopy, behind BrandStr', () => {
    for (const table of tables) {
      expect(read(`${KOTLIN}/i18n/${table}`), table).not.toMatch(WEBYAR);
    }
    const lines = functionNames(brandStr);
    expect(lines.size).toBe(7);
    expect([...functionNames(webyarCopy)].sort()).toEqual([...lines].sort());
    expect([...functionNames(respokCopy)].sort()).toEqual([...lines].sort());
    for (const name of lines) expect(brandStr).toContain(`fun ${name}(l: Language): String = BrandCopy.${name}(l)`);
  });

  it("has RESPOK's wording that never names WebYar", () => {
    expect(respokCopy).not.toMatch(WEBYAR);
    for (const text of literals(respokCopy)) {
      // The one line Turkish words without a name is the iOS app's own.
      if (text.startsWith('Web konsolu')) continue;
      expect(text).toMatch(/RESPOK/);
    }
    // The desktop apps' words (strings.respok.json), Turkish suffixes included.
    const desktop = JSON.parse(read('windows-native/src/Webyar.Core/Localization/strings.respok.json')) as Record<string, Record<string, string>>;
    for (const key of ['pushPrimerBody', 'pushDeniedTitle', 'signOutConfirm']) {
      for (const lang of ['en', 'fa', 'tr']) expect(literals(respokCopy)).toContain(desktop[lang][key]);
    }
  });

  it('is shown only through BrandStr', () => {
    const direct = /(?<![A-Za-z])(BrandCopy|StrBrand)\.\w+\(/;
    for (const file of kotlinFiles(KOTLIN)) {
      if (file.endsWith('/i18n/BrandStr.kt')) continue;
      read(file)
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
        .forEach((line) => expect(line, `${file} shows a flavor's copy directly`).not.toMatch(direct));
    }
  });
});

describe('the shared code names neither brand', () => {
  it('in any file under src/main, src/debug or src/release (names, code, comments)', () => {
    for (const dir of [MAIN, `${APP}/src/debug`, `${APP}/src/release`, RESPOK]) {
      for (const file of files(dir)) {
        expect(file, 'file name').not.toMatch(WEBYAR);
        if (/\.(png|ttf|jpg|webp)$/.test(file)) continue;
        expect(read(file), file).not.toMatch(WEBYAR);
      }
    }
  });

  it('is checked by the script CI runs, which agrees', () => {
    const out = execFileSync('bash', ['android/tools/check-brand-neutral.sh'], { cwd: root, encoding: 'utf8' });
    expect(out).toContain('Sources: brand-neutral');
  });
});

describe('CI builds and tests both brands', () => {
  const ci = read('.github/workflows/android.yml');
  const shots = read('.github/workflows/android-screenshots.yml');

  it('on every run', () => {
    for (const task of [
      ':app:assembleWebyarDebug',
      ':app:assembleRespokDebug',
      ':app:testWebyarDebugUnitTest',
      ':app:testRespokDebugUnitTest',
      ':app:lintWebyarDebug',
      ':app:lintRespokDebug',
      ':app:assembleWebyarMinified',
      ':app:assembleRespokMinified',
    ]) {
      expect(ci).toContain(task);
    }
  });

  it("and checks RESPOK's sources and APKs for WebYar's name", () => {
    expect(ci).toContain('run: tools/check-brand-neutral.sh\n');
    expect(ci).toContain('tools/check-brand-neutral.sh --apk-only app/build/outputs/apk/respok/debug/');
    expect(ci).toContain('tools/check-brand-neutral.sh --apk-only app/build/outputs/apk/respok/minified/');
    expect(ci).not.toMatch(/check-brand-neutral\.sh[^\n]*apk\/webyar/);
  });

  it('with no task name from before the flavors, which would no longer exist', () => {
    // What runs, not what the comments say about the names from before.
    const steps = (yaml: string) => yaml.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    for (const workflow of [steps(ci), steps(shots)]) {
      expect(workflow).not.toMatch(/(?<![A-Za-z])(assembleDebug|testDebugUnitTest|lintDebug|compileDebugKotlin|recordRoborazziDebug)\b/);
      expect(workflow).not.toMatch(/apk\/minified|(?<![A-Za-z])debugRuntimeClasspath|ksp\/debug|buildConfig\/debug/);
    }
    expect(shots).toContain(':app:testWebyarDebugUnitTest');
    expect(shots).toContain("--tests 'com.platform.app.screenshots.*'");
    expect(shots).toContain('roborazzi/webyar');
  });
});
