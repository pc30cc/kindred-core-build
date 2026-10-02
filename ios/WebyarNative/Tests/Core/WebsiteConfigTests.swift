import Foundation
import XCTest
@testable import WebyarNative

/// Settings → About → Website, as Super Admin sets it
/// (GET /api/mobile-app/config?platform=ios: websiteUrl, websiteLabel).
final class WebsiteConfigTests: XCTestCase {
    private func config(_ json: String) throws -> MobileAppConfig {
        try JSONDecoder().decode(MobileAppConfig.self, from: Data(json.utf8))
    }

    func testTheAddressAndTheNameSuperAdminSet() throws {
        let config = try config(#"{"websiteUrl":" https://webyar.ai/ ","websiteLabel":{"fa":"سایت وبیار","en":"  ","tr":"Webyar sitesi"}}"#)
        XCTAssertEqual(config.websiteURL, URL(string: "https://webyar.ai/"))
        XCTAssertEqual(config.websiteName(.fa), "سایت وبیار")
        XCTAssertEqual(config.websiteName(.tr), "Webyar sitesi")
        XCTAssertNil(config.websiteName(.en), "a blank name is no name: the app's own word is used")
    }

    func testOnlyAWebPageIsAWebsite() throws {
        for raw in ["http://webyar.ai", "mailto:a@b.co", "tel:123", "javascript:alert(1)", "https://", ""] {
            XCTAssertNil(try config(#"{"websiteUrl":"\#(raw)"}"#).websiteURL, raw)
        }
    }

    func testAServerFromBeforeTheWebsiteChangesNothing() throws {
        let old = try config(#"{"showSupport":true,"supportUrl":"https://t.me/webyar"}"#)
        XCTAssertNil(old.websiteURL)
        XCTAssertEqual(old.websiteLabel, [:])
        XCTAssertEqual(old, MobileAppConfig(
            showContacts: true, showVisitors: true, showWebAnalytics: true,
            supportURL: URL(string: "https://t.me/webyar")
        ))
        // A label that is not a dictionary of words is ignored, not fatal.
        XCTAssertEqual(try config(#"{"websiteLabel":"Website"}"#).websiteLabel, [:])
    }

    func testTheAppsOwnWord() {
        XCTAssertEqual(SettingsStr.website(.fa), "وب‌سایت")
        XCTAssertEqual(SettingsStr.website(.en), "Website")
        XCTAssertEqual(SettingsStr.website(.tr), "Web sitesi")
    }
}
