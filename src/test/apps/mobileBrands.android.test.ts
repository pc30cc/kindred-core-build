/**
 * One source, two Android apps: WebYar and RESPOK, the `webyar` and `respok`
 * product flavors of android/app/build.gradle.kts. These checks keep the
 * pieces that name a brand in step, so a new line of copy, a new icon density
 * or a new CI step cannot leave RESPOK's app saying "Webyar", wearing WebYar's
 * icon, signed with WebYar's key or untested. (The app's own unit tests prove
 * the same inside each build: src/test/.../BrandStrTest.kt, AppBrandRulesTest.kt
 * and each flavor's AppBrandTest.kt.) The desktop apps' counterpart is
 * desktopBrands.test.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_APP_BRANDS } from '../../../shared/nativeAppBrands';

const root = path.resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

const APP = 'android/app';
const MAIN = `${APP}/src/main`;
const RESPOK = `${APP}/src/respok`;
const KOTLIN = `${MAIN}/kotlin/com/webyar/ai`;

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

/** Every Kotlin file under a folder. */
function kotlinFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...kotlinFiles(p));
    else if (entry.name.endsWith('.kt')) out.push(p);
  }
  return out;
}

/** The string literals on a file's code lines (comment lines skipped). */
function literals(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .flatMap((line) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
}

/** `fun name(l: Language): String = when (l) { … }` functions of a string table, with their text. */
function stringFunctions(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = source.split(/\n\s*fun (\w+)\(/);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i], parts[i + 1]);
  return out;
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
    // One code package for both: R, BuildConfig, ProGuard rules and the Room schema name it.
    expect(gradle).toMatch(/namespace = "com\.webyar\.ai"/);
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
    // RESPOK never builds against WebYar: no WebYar host, no WebYar Firebase names.
    expect(r).not.toMatch(/webyar\.ai|WEBYAR_FIREBASE|webyar\.firebase/);
  });

  it('sign each brand with its own key, never the other', () => {
    expect(gradle).toContain('listOf("webyar" to "WEBYAR", "respok" to "RESPOK")');
    for (const name of ['KEYSTORE', 'KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) {
      expect(gradle).toContain(`System.getenv("\${env}_${name}")`);
    }
    expect(flavors.iran).toContain('signingConfigs.getByName("webyarRelease")');
    expect(flavors.iran).not.toContain('respokRelease');
    expect(flavors.international).toContain('signingConfigs.getByName("respokRelease")');
    expect(flavors.international).not.toContain('webyarRelease');
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

describe("RESPOK's resources", () => {
  const mipmaps = readdirSync(path.join(root, `${MAIN}/res`)).filter((d) => d.startsWith('mipmap-'));

  it('cover every launcher icon WebYar has, at every density', () => {
    expect(mipmaps.length).toBeGreaterThanOrEqual(6);
    for (const dir of mipmaps) {
      for (const file of readdirSync(path.join(root, `${MAIN}/res/${dir}`))) {
        expect(existsSync(path.join(root, `${RESPOK}/res/${dir}/${file}`)), `${dir}/${file} would show WebYar's`).toBe(true);
      }
    }
  });

  it('name every layer their adaptive icon uses', () => {
    for (const [dir, colors] of [
      [`${MAIN}/res`, `${MAIN}/res/values/colors.xml`],
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
    // The old icon's raster layers are gone: nothing references them any more.
    for (const dir of mipmaps) {
      expect(existsSync(path.join(root, `${MAIN}/res/${dir}/ic_launcher_background.png`))).toBe(false);
      expect(existsSync(path.join(root, `${MAIN}/res/${dir}/ic_launcher_monochrome.png`))).toBe(false);
    }
  });

  it('give it its name and launch colours', () => {
    expect(read(`${RESPOK}/res/values/strings.xml`)).toMatch(/<string name="app_name">RESPOK<\/string>/);
    expect(read(`${MAIN}/res/values/strings.xml`)).toMatch(/<string name="app_name">Webyar<\/string>/);
    for (const name of ['brand_deep', 'brand_bright', 'brand_deep_clear']) {
      expect(read(`${MAIN}/res/values/colors.xml`)).toContain(`name="${name}"`);
      expect(read(`${RESPOK}/res/values/colors.xml`)).toContain(`name="${name}"`);
    }
    expect(read(`${RESPOK}/res/values/colors.xml`)).toMatch(/name="brand_bright">#FFFF5A3C</);
    expect(read(`${MAIN}/res/values/colors.xml`)).toMatch(/name="brand_bright">#FF16C7A8</);
    // The loader drawable takes its colours from those, so one copy serves both brands.
    expect(read(`${MAIN}/res/drawable/launch_loader.xml`)).not.toMatch(/android:(stroke|fill)?[Cc]olor="#/);
  });

  it('let no WebYar string resource through', () => {
    const own = read(`${RESPOK}/res/values/strings.xml`);
    for (const dir of readdirSync(path.join(root, `${MAIN}/res`)).filter((d) => d.startsWith('values'))) {
      const file = path.join(root, `${MAIN}/res/${dir}/strings.xml`);
      if (!existsSync(file)) continue;
      for (const [, name, text] of readFileSync(file, 'utf8').matchAll(/<string name="(\w+)">([^<]*)</g)) {
        if (WEBYAR.test(text)) expect(own, `${dir}/${name}`).toContain(`name="${name}"`);
      }
    }
    for (const [, , text] of own.matchAll(/<string name="(\w+)">([^<]*)</g)) expect(text).not.toMatch(WEBYAR);
  });
});

describe('copy that names the product', () => {
  const brandStr = read(`${KOTLIN}/i18n/BrandStr.kt`);
  const brandObject = brandStr.split('internal object RespokStr')[0];
  const respokObject = brandStr.split('internal object RespokStr')[1];
  const branded = new Set([...brandObject.matchAll(/fun (\w+)\(l: Language\)/g)].map((m) => m[1]));
  const tables = ['Strings.kt', 'StringsManual.kt', 'StringsAndroid.kt', 'StringsInsights.kt', 'StringsEmail.kt'];

  it('is all in BrandStr', () => {
    for (const table of tables) {
      for (const [name, body] of stringFunctions(read(`${KOTLIN}/i18n/${table}`))) {
        if (literals(body).some((text) => WEBYAR.test(text))) {
          expect(branded.has(name), `${table}: ${name} names WebYar and RESPOK's build would show it`).toBe(true);
        }
      }
    }
  });

  it("has RESPOK's wording that never names WebYar", () => {
    const respok = new Set([...respokObject.matchAll(/fun (\w+)\(l: Language\)/g)].map((m) => m[1]));
    expect([...respok].sort()).toEqual([...branded].sort());
    for (const text of literals(respokObject)) {
      expect(text).not.toMatch(WEBYAR);
      expect(text).toMatch(/RESPOK/);
    }
    // The desktop apps' words (strings.respok.json), Turkish suffixes included.
    const desktop = JSON.parse(read('windows-native/src/Webyar.Core/Localization/strings.respok.json')) as Record<string, Record<string, string>>;
    for (const key of ['pushPrimerBody', 'pushDeniedTitle', 'signOutConfirm']) {
      for (const lang of ['en', 'fa', 'tr']) expect(literals(respokObject)).toContain(desktop[lang][key]);
    }
  });

  it('is shown only through BrandStr', () => {
    const direct = /(?<![A-Za-z])(Str\.(appName|pushPrimerBody|pushDeniedTitle|pushPresenceFooter|signOutConfirm)|StrManual\.brandWordmark|StrAndroid\.maintenanceTitle)\(/;
    for (const file of kotlinFiles(KOTLIN)) {
      if (file.endsWith('/i18n/BrandStr.kt')) continue;
      read(file)
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
        .forEach((line) => expect(line, `${file} shows WebYar's copy directly`).not.toMatch(direct));
    }
  });

  it('leaves only internal identifiers naming WebYar in the shipped code', () => {
    // Never shown to anyone, and the same in both apps on purpose: storage names (renaming
    // one signs every WebYar operator out or drops their cache), the notification channel
    // ids and call actions the server and the system know the app by, log tags, and names
    // that never leave the phone. Each app has its own sandbox, so sharing them is safe.
    const internal: Record<string, RegExp> = {
      'core/AppBrand.kt': /^WEBYAR$/,
      'core/Diag.kt': /^Webyar\.\$area$/,
      'core/cache/CacheDatabase.kt': /^webyar-cache\.db$/,
      'core/net/ApiClient.kt': /^WebyarApi$/,
      'core/push/CallNotifications.kt': /^(webyar_calls|com\.webyar\.ai\.call\.(ANSWER|SHOW|DECLINE))$/,
      'core/push/Notifications.kt': /^webyar_messages$/,
      'core/push/PushConfig.kt': /^webyar\.firebase$/,
      'core/storage/SecureStore.kt': /^(webyar|webyar\.secure|com\.webyar\.ai\.session)$/,
      'feature/email/EmailReader.kt': /^(webyar-attachment|inline\.webyar\.invalid)$/,
      'feature/promo/PromotionCenter.kt': /^webyar\.(promotions|noPromotions)$/,
      'feature/visitors/VisitorsMap.kt': /^webyar-\$\{template\.hashCode\(\)\}$/,
      'ui/nav/AppShell.kt': /^webyar\.tab$/,
    };
    const brandTables = ['i18n/Strings.kt', 'i18n/StringsManual.kt', 'i18n/StringsAndroid.kt'];
    for (const file of kotlinFiles(KOTLIN)) {
      const rel = path.relative(KOTLIN, file);
      if (brandTables.includes(rel)) continue; // WebYar's own copy, behind BrandStr (above)
      for (const text of literals(read(file))) {
        if (!WEBYAR.test(text)) continue;
        expect(internal[rel]?.test(text), `${rel}: "${text}" names WebYar; route it through BrandStr or AppBrand`).toBe(true);
      }
    }
    // The channel the server names in every push, in both apps.
    expect(read(`${MAIN}/AndroidManifest.xml`)).toContain('android:value="webyar_messages"');
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

  it('with no task name from before the flavors, which would no longer exist', () => {
    // What runs, not what the comments say about the names from before.
    const steps = (yaml: string) => yaml.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    for (const workflow of [steps(ci), steps(shots)]) {
      expect(workflow).not.toMatch(/(?<![A-Za-z])(assembleDebug|testDebugUnitTest|lintDebug|compileDebugKotlin|recordRoborazziDebug)\b/);
      expect(workflow).not.toMatch(/apk\/minified|(?<![A-Za-z])debugRuntimeClasspath|ksp\/debug|buildConfig\/debug/);
    }
    expect(shots).toContain(':app:testWebyarDebugUnitTest');
    expect(shots).toContain('roborazzi/webyar');
  });
});
