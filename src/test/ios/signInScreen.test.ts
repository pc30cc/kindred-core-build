/**
 * The iPhone sign-in screen (docs/operations/MOBILE_APP_PLAN.md, "The sign-in
 * screen's site address"): a small link under the form labelled with the
 * word "Website" in the app's language — never the address (owner,
 * 2026-11-02: "don't show the address, make it a link") — opening the
 * brand's site in that language; and the redesign keeping everything the
 * screen did, in both brands, from one brand-neutral source.
 *
 * The link's label and address are pinned by
 * ios/Webyar/Tests/App/SignInWebsiteLinkTests.swift; this reads what can be
 * read without Xcode.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(process.cwd(), 'ios', 'Webyar', 'Sources');

/** Swift with its comments removed. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

const read = (path: string) => code(readFileSync(join(APP, path), 'utf8'));
const login = read('Features/Auth/LoginView.swift');
const state = read('App/AppState.swift');

function struct(text: string, name: string): string {
  const start = text.indexOf(`struct ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end === -1 ? undefined : end);
}

describe('the website link under the sign-in form', () => {
  it('is named by the Settings website row\'s label and goes where that row goes, in the language on screen', () => {
    const link = state.slice(state.indexOf('var signInWebsiteLink: WebsiteLink?'));
    expect(link.slice(0, link.indexOf('\n    }\n'))).toContain('siteWebsiteURL.map { WebsiteLink(title: websiteLabel, url: $0) }');
    // The label: Super Admin's name for the website in this language, else the app's own word.
    expect(state).toContain('var websiteLabel: String { appConfig.websiteName(language) ?? SettingsStr.website(language) }');
    // The address: SiteLinks, WebYar's in the app's language.
    expect(state).toMatch(/var siteWebsiteURL: URL\? \{ SiteLinks\.website\(/);
  });

  it('shows the word and opens the address, and never prints the address', () => {
    const links = struct(login, 'SignInLinks');
    expect(login).toContain('website: appState.signInWebsiteLink');
    expect(links).toContain('Text(website.title)');
    expect(links).toContain('openURL(website.url)');
    expect(links).toContain('.accessibilityIdentifier(A11y.loginWebsite)');
    // Nothing of a URL is drawn as text anywhere on the screen.
    expect(login).not.toMatch(/absoluteString|\.host\b|Text\([^)]*\.url\b|Text\(verbatim: [^)]*url/i);
  });

  it('names no plan, price or activation beside it', () => {
    const links = struct(login, 'SignInLinks');
    expect(links).not.toMatch(/Str\.(?:plan|upgrade|price|buy|purchase|appLocked)\w*\(/i);
  });
});

describe('the redesigned sign-in screen keeps what it did', () => {
  it('signs in with an email and a password, says what went wrong, and shows that it is working', () => {
    expect(login).toContain('AuthEmailField(');
    expect(login).toMatch(/SecureField\(Str\.passwordLabel\(language\), text: \$password\)/);
    expect(login).toContain('Backend.current.logIn(');
    expect(login).toContain('AuthErrorBanner(message: errorMessage)');
    expect(login).toMatch(/PrimaryButton\(\s*title: Str\.logIn\(language\),\s*isLoading: isSubmitting,/);
    // The reason a session ended, carried over from the screen it ended on.
    expect(login).toContain('appState.sessionEndedMessage');
  });

  it('keeps forgot password, the privacy policy and the terms', () => {
    expect(login).toMatch(/NavigationLink \{\s*PasswordResetView\(prefilledEmail: email\)/);
    expect(login).toContain('Str.forgotPassword(language)');
    expect(login).toContain('.accessibilityIdentifier(A11y.loginPrivacyPolicy)');
    expect(login).toContain('.accessibilityIdentifier(A11y.loginTerms)');
    expect(login).toContain('legal: appState.siteLegalLinks');
  });

  it('offers every language the app speaks, the same choice as Settings', () => {
    const menu = struct(login, 'LanguageMenu');
    expect(menu).toContain('ForEach(Language.allCases)');
    expect(menu).toContain('Text(option.endonym)');
    expect(menu).toContain('appState.language = $0');
    expect(menu).toContain('.accessibilityIdentifier(A11y.loginLanguage)');
  });

  it('wears the brand from its assets, never by name, in both apps', () => {
    for (const path of ['Features/Auth/LoginView.swift', 'Features/Auth/AuthScaffold.swift', 'App/AppLock.swift']) {
      expect(read(path), path).not.toMatch(/webyar|respok|BRAND_RESPOK|AppBrand\.(?:name|id)\b/i);
    }
    expect(login).toContain('BrandMark(');
    expect(login).toContain('isAuth: true');
    expect(login).toContain('.foregroundStyle(AuthPalette.link)');
    expect(login).toContain('.background(AuthBackdrop())');
    expect(login).toContain('.brandFooter()');
  });

  it('grows with Dynamic Type, scrolls on a small screen, and keeps the address fields left to right', () => {
    expect(login).toContain('ScrollView {');
    expect(login).toContain('.scrollDismissesKeyboard(.interactively)');
    expect(login).toContain('.dismissesKeyboardOnTap()');
    expect(login).toContain('@ScaledMetric');
    // Every text in a text style (Font.app), none in a fixed size.
    expect(login).not.toMatch(/\.font\(\.app\(size:|\.font\(\.system\(size: (?!17\))/);
    expect(login).toContain('.environment(\\.layoutDirection, .leftToRight)');
  });
});
