import Foundation
import XCTest
@testable import Webyar

/// WebYar's site links in the app's language (owner, 2026-11-01): Persian at
/// the root, every other language under its code; RESPOK's as configured.
final class SiteLinksTests: XCTestCase {
    private let website = URL(string: "https://webyar.ai")!
    private let configured = LegalLinks(
        privacyPolicy: URL(string: "https://app.webyar.ai/privacy"),
        terms: URL(string: "https://app.webyar.ai/terms")
    )

    private func legal(_ language: Language, follows: Bool = true, website: URL? = URL(string: "https://webyar.ai")) -> LegalLinks {
        SiteLinks.legal(configured, website: website, language: language, followsLanguage: follows)
    }

    func testPersianIsAtTheRoot() {
        XCTAssertEqual(SiteLinks.website(website, language: .fa, followsLanguage: true)?.absoluteString, "https://webyar.ai")
        XCTAssertEqual(legal(.fa).privacyPolicy?.absoluteString, "https://webyar.ai/privacy")
        XCTAssertEqual(legal(.fa).terms?.absoluteString, "https://webyar.ai/terms")
    }

    func testOtherLanguagesLiveUnderTheirCode() {
        XCTAssertEqual(SiteLinks.website(website, language: .en, followsLanguage: true)?.absoluteString, "https://webyar.ai/en")
        XCTAssertEqual(legal(.en).privacyPolicy?.absoluteString, "https://webyar.ai/en/privacy")
        XCTAssertEqual(legal(.en).terms?.absoluteString, "https://webyar.ai/en/terms")
        XCTAssertEqual(legal(.tr).privacyPolicy?.absoluteString, "https://webyar.ai/tr/privacy")
        XCTAssertEqual(legal(.tr).terms?.absoluteString, "https://webyar.ai/tr/terms")
        XCTAssertEqual(SiteLinks.website(website, language: .ar, followsLanguage: true)?.absoluteString, "https://webyar.ai/ar")
        XCTAssertEqual(legal(.ar).privacyPolicy?.absoluteString, "https://webyar.ai/ar/privacy")
    }

    /// The root is the website link's host, whatever path Super Admin typed.
    func testOnlyTheWebsitesHostIsKept() {
        let typed = URL(string: "https://webyar.ai/fa/landing?x=1")
        XCTAssertEqual(legal(.en, website: typed).terms?.absoluteString, "https://webyar.ai/en/terms")
        XCTAssertEqual(SiteLinks.website(typed, language: .fa, followsLanguage: true)?.absoluteString, "https://webyar.ai")
    }

    /// Without a site address the configured pages stand.
    func testNoWebsiteKeepsTheConfiguredPages() {
        XCTAssertEqual(legal(.en, website: nil), configured)
        XCTAssertNil(SiteLinks.website(nil, language: .en, followsLanguage: true))
        XCTAssertEqual(legal(.en, website: URL(string: "http://webyar.ai")), configured, "never an http root")
    }

    /// RESPOK keeps what it is given.
    func testRespokIsUnchanged() {
        XCTAssertEqual(legal(.en, follows: false), configured)
        XCTAssertEqual(SiteLinks.website(website, language: .tr, followsLanguage: false), website)
    }

    func testThisBuildIsWebYar() {
        XCTAssertTrue(SiteLinks.followsLanguage, "the test target builds the Webyar app")
    }
}
