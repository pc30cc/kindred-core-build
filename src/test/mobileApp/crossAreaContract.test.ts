// @vitest-environment node
/**
 * One change, four areas, held to each other: the mobile app as a plan
 * feature with the sign-in screen's website link
 * (docs/operations/MOBILE_APP_PLAN.md) and colleague calls in the web panel
 * (docs/operations/TEAM_CALLS.md, "Web panel").
 *
 * Each area has its own tests: the server's push rule runs for real
 * (src/test/push/mobileAppPushGate.test.ts…), the iPhone's screens are read
 * from their Swift (src/test/ios/mobileAppLock.test.ts, signInScreen.test.ts),
 * the Android rules have JVM tests that run on a Gradle box, and the web
 * panel's call has its own (src/test/teamCalls). What none of them sees is
 * the other end of a name: the key the server resolves and the key each app
 * reads; a string iOS defines and the one Android shows; the website link's
 * rule written twice, once in Swift and once in Kotlin; the routes, bodies,
 * codes and realtime envelope the web client speaks and the server answers.
 * A name spelled two ways is an error nowhere — the app simply finds
 * nothing. So here each name is lifted from every side and held to the doc
 * and to the others.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAPABILITY_REGISTRY } from '../../../server/services/billing/capabilityRegistry';
import { resolveEffectiveEntitlements } from '../../../server/services/billing/effectiveEntitlements';
import { teamCallView, TEAM_CALL_LIVE_STATES, TEAM_CALL_TERMINAL_STATES } from '../../../server/services/calls/teamCall';

const read = (path: string) => readFileSync(path, 'utf8');

const PLAN_DOC = read('docs/operations/MOBILE_APP_PLAN.md');
const CALLS_DOC = read('docs/operations/TEAM_CALLS.md');

// Server
const PLAN_GATE = read('server/services/mobileApp/planGate.ts');
const RECIPIENTS = read('server/services/push/recipients.ts');
const TEAM_CALL_RING = read('server/services/push/teamCallRing.ts');
const CALL_RING = read('server/services/push/callRing.ts');
const TEAM_CALL_ROUTES = read('server/routes/teamCalls.ts');
const TEAM_CALL_LIFECYCLE = read('server/services/calls/teamCallLifecycle.ts');
const REALTIME_PUBLISH = read('server/services/realtime/publish.ts');
const REALTIME_TYPES = read('server/services/realtime/types.ts');
const REALTIME_ROUTES = read('server/routes/realtime.ts');
const MOBILE_SETTINGS = read('server/services/mobileApp/settings.ts');
const PLATFORM_ORIGINS = read('server/routes/platformOriginsPublic.ts');

// Web
const WEB_API = read('src/lib/team-calls-api.ts');
const WEB_CONTEXT = read('src/features/teamCalls/TeamCallContext.tsx');
const WEB_ERRORS = read('src/features/teamCalls/teamCallErrors.ts');
const WEB_DEVICE = read('src/features/teamCalls/deviceId.ts');
const WEB_PLAN_ACCESS = read('src/lib/planAccess.ts');
const WEB_CENTRIFUGO = read('src/realtime/providers/centrifugo.ts');
const WEB_SUPABASE = read('src/realtime/providers/supabase.ts');
const WEB_APP_ROUTES = read('src/App.tsx');

// iOS
const IOS = 'ios/Webyar/Sources';
const IOS_LOCK_MODEL = read(`${IOS}/Core/Models/MobileAppLock.swift`);
const IOS_LOCK_VIEW = read(`${IOS}/App/AppLock.swift`);
const IOS_STATE = read(`${IOS}/App/AppState.swift`);
const IOS_STRINGS = read(`${IOS}/Localization/Strings.swift`);
const IOS_SETTINGS_STRINGS = read(`${IOS}/Localization/SettingsStrings.swift`);
const IOS_SITE_LINKS = read(`${IOS}/Localization/SiteLinks.swift`);
const IOS_BRAND = read(`${IOS}/Core/Config/AppBrand.swift`);
const IOS_APP_CONFIG = read(`${IOS}/Core/Models/WebAnalytics.swift`);
const IOS_ORIGINS = read(`${IOS}/Core/Networking/PlatformOrigin.swift`);
const IOS_CALL_MANAGER = read(`${IOS}/Features/Calls/TeamCalls/CallManager.swift`);
const IOS_SITE_LINKS_TESTS = read('ios/Webyar/Tests/Core/SiteLinksTests.swift');
const IOS_PROJECT = read('ios/Webyar/project.yml');

// Android
const KT = 'android/app/src/main/kotlin/com/platform/app';
const ANDROID_LOCK_MODEL = read(`${KT}/core/model/MobileAppLock.kt`);
const ANDROID_LOCK_VIEW = read(`${KT}/feature/auth/AppLockOverlay.kt`);
const ANDROID_STRINGS = read(`${KT}/i18n/Strings.kt`);
const ANDROID_ONLY_STRINGS = read(`${KT}/i18n/StringsAndroid.kt`);
const ANDROID_SITE_LINKS = read(`${KT}/i18n/SiteLinks.kt`);
const ANDROID_WEBSITE_LINK = read(`${KT}/ui/WebsiteLink.kt`);
const ANDROID_LOGIN = read(`${KT}/feature/auth/LoginScreen.kt`);
const ANDROID_BRAND = read(`${KT}/core/AppBrand.kt`);
const ANDROID_LANGUAGE = read(`${KT}/i18n/Language.kt`);
const ANDROID_APP_CONFIG = read(`${KT}/core/model/MobileAppConfig.kt`);
const ANDROID_API = read(`${KT}/core/net/ApiClient.kt`);
const ANDROID_RING_ROUTER = read(`${KT}/core/push/IncomingCallRouter.kt`);
const ANDROID_GRAPH = read(`${KT}/AppGraph.kt`);
const ANDROID_GRADLE = read('android/app/build.gradle.kts');
const ANDROID_SITE_LINKS_TESTS = read('android/app/src/test/kotlin/com/platform/app/i18n/SiteLinksTest.kt');

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** The text of [source] from [start] (included) to the first [end] after it. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `found: ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** Source without its comments (Swift, Kotlin and TypeScript alike), so a rule is read from code only. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      // `//` inside a string literal ("https://…") is not a comment.
      const at = line.search(/(^|[^:"'`])\/\//);
      return at === -1 ? line : line.slice(0, at + (line[at] === '/' ? 0 : 1));
    })
    .join('\n');
}

const unescape = (literal: string) => literal.replace(/\\(["\\$])/g, '$1');

/** A Swift `static func name(_ l: Language) -> String { switch l { case .xx: "…" } }`, by language code. */
function swiftStrings(source: string, name: string): Record<string, string> {
  const body = between(source, `static func ${name}(_ l: Language) -> String {`, '\n    }\n');
  return Object.fromEntries([...body.matchAll(/case \.(\w+): "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], unescape(m[2])]));
}

/** A Kotlin `fun name(l: Language): String = when (l) { Language.XX -> "…" }`, by language code. */
function kotlinStrings(source: string, name: string): Record<string, string> {
  const body = between(source, `fun ${name}(l: Language): String = when (l) {`, '\n    }');
  return Object.fromEntries(
    [...body.matchAll(/Language\.(\w+) -> "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1].toLowerCase(), unescape(m[2])]),
  );
}

/** The rows of one of the doc's string tables: name → { fa, en, tr, ar }. */
function docStrings(table: string): Map<string, Record<string, string>> {
  const rows = new Map<string, Record<string, string>>();
  for (const line of table.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const name = cells[0]?.match(/^`(\w+)`$/)?.[1];
    if (!name || cells.length !== 5) continue;
    rows.set(name, { fa: cells[1], en: cells[2], tr: cells[3], ar: cells[4] });
  }
  return rows;
}

const SHARED_TABLE = between(PLAN_DOC, '## Strings', 'Android only');
const ANDROID_TABLE = between(PLAN_DOC, 'Android only (`StringsAndroid.kt`):', '## The sign-in screen');
const SHARED = docStrings(SHARED_TABLE);
const ANDROID_ONLY = docStrings(ANDROID_TABLE);

/** Android speaks fa, en and tr (Language.kt); the contract's Arabic is iOS's alone. */
const ANDROID_LANGUAGES = [...ANDROID_LANGUAGE.matchAll(/^\s+([A-Z]{2})\("(\w+)"\)/gm)].map((m) => m[2]);

// ═══ The plan key ════════════════════════════════════════════════════

describe('mobile_app, from the registry to the three readers', () => {
  it('is the registry key the doc defines, on by default', () => {
    const cap = CAPABILITY_REGISTRY.find((c) => c.key === 'mobile_app');
    expect(cap).toMatchObject({ type: 'feature', group: 'mobile', defaultValue: true, planConfigurable: true, workspaceOverridable: false });
    expect(PLAN_DOC).toContain('Registry key `mobile_app`');
    expect(PLAN_DOC).toContain('`features.mobile_app.value`');
  });

  it('is read under the same name by the server\'s push rule and both apps', () => {
    expect(PLAN_GATE).toContain("export const MOBILE_APP_FEATURE = 'mobile_app';");
    expect(IOS_LOCK_MODEL).toContain('static let mobileAppKey = "mobile_app"');
    expect(ANDROID_LOCK_MODEL).toContain('const val MOBILE_APP_FEATURE = "mobile_app"');
  });

  it('locks only on an explicit false, on every side: the opposite of every other gate', () => {
    // The server lets a push through unless the value is false…
    expect(PLAN_GATE).toContain('.features[MOBILE_APP_FEATURE];');
    expect(PLAN_GATE).toContain('const allowed = flag?.value !== false;');
    // …and the apps lock only when it is.
    expect(IOS_LOCK_MODEL).toContain('features?[Self.mobileAppKey]?.value == false');
    expect(IOS_LOCK_MODEL).toContain('value?.mobileAppLocked == true');
    expect(ANDROID_LOCK_MODEL).toContain('features?.get(MOBILE_APP_FEATURE)?.value == false');
    expect(ANDROID_LOCK_MODEL).toContain('value?.mobileAppLocked == true');
  });

  it('is in the snapshot\'s `features` as a boolean, which both apps decode as one', () => {
    const plan = (entitlements: Record<string, unknown>) => ({ entitlements, planLimits: {}, limitOverrides: {} }) as never;
    expect(resolveEffectiveEntitlements(plan({}), [], []).features.mobile_app.value).toBe(true);
    expect(resolveEffectiveEntitlements(plan({ mobile_app: false }), [], []).features.mobile_app.value).toBe(false);
  });

  it('is never read by the web panel, which only names it', () => {
    // Labels (capability-i18n, the plan card) only: no gate of the panel asks for it.
    expect(WEB_PLAN_ACCESS).not.toContain('mobile_app');
    expect(WEB_CONTEXT).not.toContain('mobile_app');
  });
});

// ═══ The server's push rule, and what the apps do with what still comes ═

describe('the push rule and the apps\' side of it', () => {
  it('stops every alert push, colleague ring and call-centre ring of a locked workspace', () => {
    expect(RECIPIENTS).toContain('if (!(await mobileAppAllowed(config, ctx.workspaceId))) return [];');
    expect(TEAM_CALL_RING).toContain('if (!(await mobileAppAllowed(config, workspaceId))) return { ios: [], android: [] };');
    expect(TEAM_CALL_ROUTES).toContain('teamCallRingTargets(config, calleeId, workspaceId)');
    expect(between(CALL_RING, 'export async function ringOperators(', '\n}\n'))
      .toContain('if (!(await mobileAppAllowed(config, input.workspaceId))) return { sent: 0, devices: 0 };');
    // A stop goes while a ring let through just before the switch may still ring.
    expect(between(CALL_RING, 'export async function cancelRing(', '\n}\n'))
      .toContain('mobileAppRingMayBeLive(config, input.workspaceId, RING_TTL_SECONDS)');
  });

  it('a ring that still reaches a locked phone is ended on iOS and not shown on Android; a stop always stops', () => {
    // iOS: reported to CallKit (PushKit requires it), then ended at once.
    expect(IOS_LOCK_MODEL).toContain('!isExpired(now: now) && !holdsAudio && signedIn && !workspaceLocked');
    expect(IOS_CALL_MANAGER).toContain('workspaceLocked: MobileAppLock.isLocked(workspaceID: ring.workspaceID)');
    // Android: both kinds of ring are checked against the plan; the cancels are not.
    expect(ANDROID_RING_ROUTER).toContain('if (locked(call.workspaceId)) {');
    expect(ANDROID_RING_ROUTER).toContain('if (locked(ring.workspaceId)) {');
    const cancels = between(ANDROID_RING_ROUTER, 'if (type == IncomingCall.TYPE_CANCEL) {', 'val now = nowEpochSeconds()');
    expect(cancels).not.toContain('locked(');
    const colleagueCancel = between(ANDROID_RING_ROUTER, 'if (type == TeamCallRing.TYPE_CANCEL) {', 'val now = nowEpochSeconds()');
    expect(colleagueCancel).not.toContain('locked(');
    // The plan asked again reads the same lock rule.
    expect(ANDROID_GRAPH).toContain('api.entitlements(workspaceId) }.getOrNull()?.mobileAppLocked');
  });
});

// ═══ The strings ═════════════════════════════════════════════════════

describe('the lock card\'s strings', () => {
  it('the shared four are in the doc, in iOS word for word, and generated into Android', () => {
    expect(sorted(SHARED.keys())).toEqual(['appLockedAskOwner', 'appLockedBody', 'appLockedSwitchWorkspace', 'appLockedTitle']);
    expect(ANDROID_LANGUAGES).toEqual(['en', 'fa', 'tr']);
    for (const [name, doc] of SHARED) {
      expect(swiftStrings(IOS_STRINGS, name), `iOS Str.${name}`).toEqual(doc);
      const android = kotlinStrings(ANDROID_STRINGS, name);
      expect(sorted(Object.keys(android)), `Android Str.${name}`).toEqual(sorted(ANDROID_LANGUAGES));
      for (const language of ANDROID_LANGUAGES) expect(android[language], `Android Str.${name} ${language}`).toBe(doc[language]);
    }
  });

  it('the Android-only two are Android\'s alone, word for word', () => {
    expect(sorted(ANDROID_ONLY.keys())).toEqual(['appLockedOpenWebsite', 'appLockedVisitWebsite']);
    for (const [name, doc] of ANDROID_ONLY) {
      const android = kotlinStrings(ANDROID_ONLY_STRINGS, name);
      for (const language of ANDROID_LANGUAGES) expect(android[language], `StrAndroid.${name} ${language}`).toBe(doc[language]);
      expect(IOS_STRINGS, `iOS has no ${name}`).not.toContain(name);
    }
  });

  it('each card uses its own: iOS the ask-the-owner line and no website at all; Android the website and the billing page', () => {
    const iosCard = code(IOS_LOCK_VIEW);
    for (const name of ['appLockedTitle', 'appLockedBody', 'appLockedAskOwner', 'appLockedSwitchWorkspace', 'signOut']) {
      expect(iosCard, `iOS Str.${name}`).toContain(`Str.${name}(language)`);
    }
    // App Store Review Guideline 3.1.1 / 3.1.3(f): no link, no button, no website, no purchase.
    expect(iosCard).not.toMatch(/openURL|\bLink\(|siteWebsiteURL|signInWebsiteLink|websiteLabel|websiteURL|billing|appLocked(?:Visit|Open)Website/i);

    const androidCard = code(ANDROID_LOCK_VIEW);
    for (const name of ['appLockedTitle', 'appLockedBody', 'appLockedSwitchWorkspace', 'signOut']) {
      expect(androidCard, `Android Str.${name}`).toContain(`Str.${name}(language)`);
    }
    expect(androidCard).toContain('StrAndroid.appLockedVisitWebsite(language)');
    expect(androidCard).toContain('StrAndroid.appLockedOpenWebsite(language)');
    expect(androidCard).toContain('mobileAppBillingUrl(panelOrigin)');
  });

  it('carries the same accessibility identifiers on both phones, for the UI tests and screenshots', () => {
    const ids = (source: string) => new Set([...source.matchAll(/"((?:login\.website|appLock\.\w+))"/g)].map((m) => m[1]));
    const ios = ids(read(`${IOS}/DesignSystem/Accessibility.swift`));
    const android = ids(read(`${KT}/ui/A11y.kt`));
    expect(sorted(ios)).toEqual(['appLock.card', 'appLock.signOut', 'appLock.switchWorkspace', 'login.website']);
    for (const id of ios) expect(android, id).toContain(id);
    // The one Android has beyond them is its website button, which the iPhone's card never has.
    expect(sorted([...android].filter((id) => !ios.has(id)))).toEqual(['appLock.openWebsite']);
  });

  it('Android\'s button opens the web panel\'s billing page, a route the panel has', () => {
    expect(PLAN_DOC).toContain('(`<panel origin>/app/billing`)');
    expect(ANDROID_LOCK_MODEL).toContain('private const val BILLING_PATH = "/app/billing"');
    expect(ANDROID_LOCK_MODEL).toContain('return "$origin$BILLING_PATH"');
    // /app/<section> resolves to the active workspace's section; billing is one.
    expect(WEB_APP_ROUTES).toContain('<Route path="/app/*"');
    expect(WEB_APP_ROUTES).toMatch(/<Route path="billing" element=\{<RequireWorkspaceAdmin><BillingPage \/>/);
    // The panel's origin is the platform's `appBaseUrl`, which the server names.
    expect(PLATFORM_ORIGINS).toContain('appBaseUrl: toOrigin(data?.app_base_url)');
    expect(ANDROID_API).toContain('val panel: String? get() = https(appBaseUrl)');
  });
});

// ═══ The sign-in screen's website link ═══════════════════════════════

describe('the sign-in screen\'s website link, the same rule in Swift and in Kotlin', () => {
  it('is named by the word, never the address: Super Admin\'s name for it, else "Website"', () => {
    expect(IOS_STATE).toContain('var websiteLabel: String { appConfig.websiteName(language) ?? SettingsStr.website(language) }');
    expect(IOS_STATE).toContain('siteWebsiteURL.map { WebsiteLink(title: websiteLabel, url: $0) }');
    expect(ANDROID_WEBSITE_LINK).toContain('WebsiteLink(title = config.websiteName(language) ?: StrAndroid.website(language), url = url)');
    // The word is the same word on both phones.
    const ios = swiftStrings(IOS_SETTINGS_STRINGS, 'website');
    const android = kotlinStrings(ANDROID_ONLY_STRINGS, 'website');
    for (const language of ANDROID_LANGUAGES) expect(android[language], `website ${language}`).toBe(ios[language]);
    // Super Admin's name, by language code, trimmed, blank meaning none.
    expect(IOS_APP_CONFIG).toContain('websiteLabel[language.rawValue].flatMap {');
    expect(ANDROID_APP_CONFIG).toContain('websiteLabel[language.code]?.trim()?.takeIf { it.isNotEmpty() }');
  });

  it('shows the title and opens the address, on both screens', () => {
    const login = code(ANDROID_LOGIN);
    expect(login).toContain('Text(website.title');
    expect(login).toContain('openInBrowser(context, website.url)');
    expect(login).not.toMatch(/Text\(\s*website\.url|Text\([^)]*\.host\b/);
    // iOS: src/test/ios/signInScreen.test.ts.
  });

  it('reads the app config\'s link and name under the names the server writes them', () => {
    // The server writes them in the iOS app's config (Super Admin → Mobile App → iOS).
    const iosConfig = between(MOBILE_SETTINGS, 'export function toIosAppConfig(', '\n}\n');
    expect(iosConfig).toContain('websiteUrl: settings.ios_app_website_url || null,');
    expect(iosConfig).toContain('websiteLabel: settings.ios_app_website_label ?? {},');
    expect(IOS_APP_CONFIG).toContain('case websiteURL = "websiteUrl"');
    expect(IOS_APP_CONFIG).toContain('case websiteLabel');
    // Android reads the same names when its config carries them (it does not
    // yet: toAndroidAppConfig sends neither, so Android uses the canonical
    // site and its own word — the contract's fallback).
    expect(ANDROID_APP_CONFIG).toContain('val websiteUrl: String? = null,');
    expect(ANDROID_APP_CONFIG).toContain('val websiteLabel: Map<String, String> = emptyMap(),');
  });

  it('builds on the site Super Admin set, else the platform\'s canonical site (`canonicalBaseUrl`)', () => {
    expect(IOS_STATE).toContain('private var siteRoot: URL? { appConfig.websiteURL ?? PlatformOrigin.siteURL }');
    expect(IOS_ORIGINS).toContain('var site: URL? { Self.https(canonicalBaseUrl) }');
    expect(ANDROID_WEBSITE_LINK).toContain('val root = config.websiteLink ?: site?.takeIf { SiteLinks.root(it) != null } ?: return null');
    expect(ANDROID_API).toContain('val site: String? get() = https(canonicalBaseUrl)');
    expect(PLATFORM_ORIGINS).toContain('canonicalBaseUrl: toOrigin(data?.canonical_base_url) ?? publicBaseUrl,');
  });

  it('follows the language for WebYar and not for RESPOK, in both apps', () => {
    const respok = between(IOS_BRAND, '#if BRAND_RESPOK', '#else');
    const webyar = between(IOS_BRAND, '#else', '#endif');
    expect(respok).toContain('static let localizedSitePaths = false');
    expect(webyar).toContain('static let localizedSitePaths = true');
    expect(between(ANDROID_GRADLE, 'create("webyar") {', 'create("respok") {'))
      .toContain('buildConfigField("boolean", "LOCALIZED_SITE_PATHS", "true")');
    expect(between(ANDROID_GRADLE, 'create("respok") {', 'create("minified") {'))
      .toContain('buildConfigField("boolean", "LOCALIZED_SITE_PATHS", "false")');
    expect(ANDROID_BRAND).toContain('const val localizedSitePaths: Boolean = BuildConfig.LOCALIZED_SITE_PATHS');
    expect(IOS_SITE_LINKS).toContain('static var followsLanguage: Bool { AppBrand.localizedSitePaths }');
    expect(ANDROID_SITE_LINKS).toContain('val followsLanguage: Boolean get() = AppBrand.localizedSitePaths');
  });

  describe('SiteLinks, rule by rule', () => {
    const swift = code(IOS_SITE_LINKS);
    const kotlin = code(ANDROID_SITE_LINKS);
    const rules: Array<[string, string, string]> = [
      ['the pages', 'case home = ""\n        case privacy = "privacy"\n        case terms = "terms"', 'HOME(""),\n        PRIVACY("privacy"),\n        TERMS("terms"),'],
      ['Persian at the root, every other language under its code', 'language == .fa ? nil : language.rawValue', 'code.takeUnless { it == Language.FA.code }'],
      ['an https root only', 'scheme == "https"', 'if (uri.scheme?.lowercase() != "https") return null'],
      ['of the root its host and port only', 'parts.host = host\n        parts.port = website.port', 'URI("https", null, host, uri.port, null, null, null)'],
      ['the language, then the page', '[languageSegment(language), page.rawValue.isEmpty ? nil : page.rawValue].compactMap { $0 }', 'listOfNotNull(languageSegment(languageCode), page.path.ifEmpty { null })'],
      ['the root alone for Persian\'s home', 'guard !segments.isEmpty else { return root }', 'if (segments.isEmpty()) return root'],
      ['one path under the root', '"/" + segments.joined(separator: "/")', 'root + "/" + segments.joinToString("/")'],
      ['a brand that keeps its links keeps the website link as given', 'guard followsLanguage else { return website }', 'if (!followsLanguage) return website'],
      ['the home page in the language, else the link as given', 'page(.home, website: website, language: language) ?? website', 'page(Page.HOME, website, languageCode) ?: website'],
      ['the configured legal pages without a site, or for such a brand', 'guard followsLanguage, root(of: website) != nil else { return configured }', 'if (!followsLanguage || root(website) == null) return configured'],
    ];
    it.each(rules)('%s', (_rule, inSwift, inKotlin) => {
      expect(swift).toContain(inSwift);
      expect(kotlin).toContain(inKotlin);
    });

    it('Android\'s tests expect every address the iOS tests expect', () => {
      const urls = (source: string) => new Set([...source.matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]));
      const ios = urls(between(IOS_SITE_LINKS_TESTS, 'final class SiteLinksTests', 'func testThisBuildIsWebYar'));
      const android = urls(ANDROID_SITE_LINKS_TESTS);
      expect(ios.size).toBeGreaterThanOrEqual(10);
      for (const url of ios) expect(android, url).toContain(url);
    });
  });
});

// ═══ Build 4 ════════════════════════════════════════════════════════

describe('the iPhone build', () => {
  it('is at least 1.0.0 (4), the build the rollout names, for both apps of the project', () => {
    const rollout = PLAN_DOC.match(/iOS (\d+\.\d+\.\d+) \((\d+)\) to App Store Connect/);
    expect(rollout).toBeTruthy();
    expect(IOS_PROJECT).toContain(`MARKETING_VERSION: "${rollout![1]}"`);
    expect(rollout![2]).toBe('4');
    // Later builds carry this feature too (build 5: the call media budget,
    // pinned by src/test/native/callMediaBudget.ios.test.ts).
    const build = IOS_PROJECT.match(/CURRENT_PROJECT_VERSION: "(\d+)"/);
    expect(build).toBeTruthy();
    expect(Number(build![1])).toBeGreaterThanOrEqual(Number(rollout![2]));
    // One base setting: no target sets a build number of its own.
    expect(IOS_PROJECT.match(/CURRENT_PROJECT_VERSION:/g)).toHaveLength(1);
  });
});

// ═══ The web panel's colleague calls ═════════════════════════════════

describe('the web panel\'s team-call client and the server', () => {
  const serverRoutes = [...TEAM_CALL_ROUTES.matchAll(/teamCallsRouter\.(get|post)\('([^']*)'/g)]
    .map((m) => `${m[1].toUpperCase()} /api/team-calls${m[2] === '/' ? '' : m[2]}`);
  const webRoutes = [...WEB_API.matchAll(/\b(post|request)<[^(]*>\(\s*(''|`[^`]*`)/g)]
    .map((m) => `${m[1] === 'post' ? 'POST' : 'GET'} /api/team-calls${m[2] === "''" ? '' : m[2].slice(1, -1).replace('/${encodeURIComponent(id)}', '/:id')}`);

  it('calls every route the server has, with the server\'s method, and no other', () => {
    expect(sorted(webRoutes)).toEqual(sorted(serverRoutes));
    expect(WEB_API).toContain("fetch(`${API_BASE}/api/team-calls/${encodeURIComponent(id)}/hangup`, {\n        method: 'POST',");
  });

  it('sends the server\'s bodies: {workspace_id, callee_id, channel} to ring, {device_id} to answer', () => {
    const serverCreate = [...between(TEAM_CALL_ROUTES, 'const createSchema = z.object({', '});').matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
    const webCreate = [...between(WEB_API, 'async place(input: {', '})').slice('async place(input: {'.length).matchAll(/(\w+):/g)]
      .map((m) => m[1]);
    expect(sorted(webCreate)).toEqual(sorted(serverCreate));
    expect(WEB_API).toContain('{ device_id: deviceId }');
    expect(TEAM_CALL_ROUTES).toContain('device_id: z.string().min(4).max(128).optional(),');
  });

  it('answers with a device id the server takes, its own per tab (`web-<random>`)', () => {
    const [, min, max] = WEB_DEVICE.match(/const VALID = \/\^web-\[a-z0-9\]\{(\d+),(\d+)\}\$\/;/) ?? [];
    expect(min && max).toBeTruthy();
    const [, serverMin, serverMax] = TEAM_CALL_ROUTES.match(/device_id: z\.string\(\)\.min\((\d+)\)\.max\((\d+)\)/) ?? [];
    expect('web-'.length + Number(min)).toBeGreaterThanOrEqual(Number(serverMin));
    expect('web-'.length + Number(max)).toBeLessThanOrEqual(Number(serverMax));
    expect(CALLS_DOC).toContain('(`web-<random>`, kept in sessionStorage)');
    expect(WEB_DEVICE).toContain('window.sessionStorage');
  });

  it('reads the TeamCall the server writes: its keys, states and outcomes', () => {
    const view = teamCallView(
      {
        id: 'c', workspace_id: 'w', provider: 'livekit', provider_room_id: null, call_type: 'audio', state: 'ringing',
        entry_source: 'team_call', initiated_by: 'a',
        metadata: { team_call: { caller_user_id: 'a', callee_user_id: 'b', channel: 'audio', outcome: null, answered_device_id: null, answered_at: null, rung_android_device_ids: [], rung_ios_device_ids: [] } },
        created_at: '2026-11-02T10:00:00.000Z', connected_at: null, ended_at: null,
      } as never,
      'a',
      { user_id: 'b', name: null, avatar_url: null },
    );
    const webCall = between(WEB_API, 'export interface TeamCall {', '}');
    const webPeer = between(WEB_API, 'export interface TeamCallPeer {', '}');
    expect(sorted([...webCall.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]))).toEqual(sorted(Object.keys(view)));
    expect(sorted([...webPeer.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]))).toEqual(sorted(Object.keys(view.peer)));

    const union = (name: string) => [...between(WEB_API, `export type ${name} =`, ';').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const serverOutcomes = [...between(read('server/services/calls/teamCall.ts'), 'const OUTCOMES', ']').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(sorted(union('TeamCallState'))).toEqual(sorted([...TEAM_CALL_LIVE_STATES, ...TEAM_CALL_TERMINAL_STATES]));
    expect(sorted(union('TeamCallOutcome'))).toEqual(sorted(serverOutcomes));
    expect(sorted(union('TeamCallChannel'))).toEqual(['audio', 'video']);
  });

  it('names every refusal the server gives a ring, and reads the fields it names them by', () => {
    const create = between(TEAM_CALL_ROUTES, "teamCallsRouter.post('/', callerLimiter", '// ═══ GET /api/team-calls/:id');
    const serverCodes = new Set([
      ...[...create.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]),
      ...[...TEAM_CALL_ROUTES.matchAll(/res\.status\(429\)\.json\(\{ error: '([a-z_]+)'/g)].map((m) => m[1]),
      // team_call_place's verdict, and the provider's own (failure()).
      'caller_busy', 'callee_busy', 'provider_not_ready',
    ]);
    const webCodes = new Set([...WEB_ERRORS.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
    // A malformed ask and a server fault are a plain "couldn't place the call".
    for (const code of serverCodes) {
      if (code === 'invalid_params' || code === 'internal_error') continue;
      expect(webCodes, code).toContain(code);
    }
    expect(webCodes).toContain('not_connected');
    // 422 names its limit and why; 403 says whether the plan or a switch said no.
    expect(create).toContain("limit,\n          reason: decision.reason,");
    expect(WEB_ERRORS).toContain("body.limit === 'max_call_minutes_per_month'");
    expect(WEB_ERRORS).toContain("body.reason === 'usage_unavailable'");
    expect(create).toContain("reason: planAllows ? 'runtime' : 'plan',");
    expect(WEB_ERRORS).toContain("body.reason === 'runtime'");
    expect(create).toContain("capability: channel === 'video' ? 'voice_video.video' : 'voice_video.voice',");
    expect(WEB_ERRORS).toContain("typeof body.capability === 'string'");
  });

  it('hears the realtime `team_call` event on the member\'s own channel, as the server publishes it', () => {
    // Server: { type: 'event', payload: { kind: 'team_call', workspace_id, call_id, state, outcome, rang_at } } on ws:<ws>:user:<uid>.
    expect(REALTIME_TYPES).toContain('return `ws:${workspaceId}:user:${userId}`;');
    expect(between(REALTIME_PUBLISH, 'export async function publishTeamEvent(', '\n}\n')).toContain("type: 'event',");
    const announce = between(TEAM_CALL_LIFECYCLE, 'function publishTeamCallEvent(', '\n}\n');
    expect(between(TEAM_CALL_LIFECYCLE, 'export function announceTeamCall(', 'recordTeamCallEvent(')).toContain('publishTeamCallEvent(config, row)');
    for (const field of ["kind: 'team_call'", 'workspace_id: row.workspace_id', 'call_id: row.id', 'state: row.state', 'rang_at: meta.rang_at']) {
      expect(announce, field).toContain(field);
    }
    // Web: the same channel, and the event's payload read by those names.
    expect(WEB_CONTEXT).toContain('const channel = `ws:${workspaceId}:user:${userId}`;');
    expect(WEB_CONTEXT).toContain("payload.kind !== 'team_call'");
    for (const field of ['payload.call_id', 'payload.state', 'payload.workspace_id']) expect(WEB_CONTEXT, field).toContain(field);
    // Both providers hand `payload` of a `type: 'event'` envelope to onEvent…
    expect(WEB_CENTRIFUGO).toContain("data?.type === 'event' && data.payload");
    expect(WEB_SUPABASE).toContain("ch.on('broadcast', { event: 'event' }");
    // …and ask the server's own endpoint for the member's channel.
    expect(REALTIME_ROUTES).toContain("realtimeRouter.post('/operator-user-subscribe'");
    expect(WEB_CENTRIFUGO).toContain('/api/realtime/operator-user-subscribe');
    expect(WEB_SUPABASE).toContain("user: '/api/realtime/operator-user-subscribe'");
  });

  it('offers a call by the apps\' one plan rule: team_calls, voice_video and the call\'s channel', () => {
    const rule = between(WEB_PLAN_ACCESS, 'export function teamCallAllowed(', '\n}\n');
    expect(rule).toContain("plan.feature('team_calls')");
    expect(rule).toContain("plan.module('voice_video')");
    expect(rule).toContain("plan.channel(kind === 'video' ? 'video' : 'voice')");
  });
});
