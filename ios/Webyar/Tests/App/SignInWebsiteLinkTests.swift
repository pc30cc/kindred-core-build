import Foundation
import XCTest
@testable import Webyar

/// The sign-in screen's website link (docs/operations/MOBILE_APP_PLAN.md,
/// "The sign-in screen's site address"; owner, 2026-11-02: "don't show the
/// address, make it a link"): labelled with the Settings website row's name —
/// the word, never the address — and opening the brand's site in the
/// language on screen, WebYar's Persian at the root and every other
/// language under its code.
@MainActor
final class SignInWebsiteLinkTests: XCTestCase {
    private static let siteKey = "platform.siteURL"
    private static let languageKey = "app.language"
    private var savedSite: Any?
    private var savedLanguage: Any?

    override func setUp() async throws {
        savedSite = UserDefaults.standard.object(forKey: Self.siteKey)
        savedLanguage = UserDefaults.standard.object(forKey: Self.languageKey)
        // The brand's canonical site, as the platform names it before sign-in.
        PlatformOrigin.rememberSite(URL(string: "https://webyar.ai"))
    }

    override func tearDown() async throws {
        for (key, value) in [(Self.siteKey, savedSite), (Self.languageKey, savedLanguage)] {
            if let value {
                UserDefaults.standard.set(value, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
    }

    private actor NoAPI: TestAPIBase {}

    func testTheLinkIsTheWordNeverTheAddress() throws {
        let appState = AppState(api: NoAPI())
        let original = appState.language
        defer { appState.language = original }

        for language in Language.allCases {
            appState.language = language
            let link = try XCTUnwrap(appState.signInWebsiteLink, "\(language)")
            XCTAssertEqual(link.title, SettingsStr.website(language), "\(language)")
            XCTAssertFalse(link.title.contains("://"), "\(language): the label is an address")
            XCTAssertFalse(link.title.lowercased().contains("webyar.ai"), "\(language): the label is an address")
            // Where Settings' website row goes, in the same language.
            XCTAssertEqual(link.url, appState.siteWebsiteURL)
        }
    }

    func testItOpensTheSiteInTheLanguageOnScreen() throws {
        let appState = AppState(api: NoAPI())
        let original = appState.language
        defer { appState.language = original }

        let expected: [Language: String] = [
            .fa: "https://webyar.ai",
            .en: "https://webyar.ai/en",
            .tr: "https://webyar.ai/tr",
            .ar: "https://webyar.ai/ar",
        ]
        for (language, address) in expected {
            appState.language = language
            XCTAssertEqual(appState.signInWebsiteLink?.url.absoluteString, address, "\(language)")
        }
    }

    /// Super Admin's name for the website, in this language, when it set one.
    func testSuperAdminsNameIsTheLabel() throws {
        let config = try JSONDecoder().decode(
            MobileAppConfig.self,
            from: Data(#"{"websiteUrl":"https://webyar.ai","websiteLabel":{"en":"Our site","fa":"سایت ما"}}"#.utf8)
        )
        XCTAssertEqual(config.websiteName(.en), "Our site")
        XCTAssertNil(config.websiteName(.tr), "else the app's own word")
        XCTAssertEqual(SettingsStr.website(.tr), "Web sitesi")
    }
}
