import Foundation
import XCTest
@testable import WebyarNative

/// The language the app is in: the operator's choice, else the one Super
/// Admin set for the iOS app, else the build's own.
final class LanguageChoiceTests: XCTestCase {
    func testTheOperatorsChoiceComesFirst() {
        XCTAssertEqual(LanguageChoice.starting(stored: "tr", platformDefault: "fa", compiled: .en), .tr)
    }

    func testThenThePlatformsDefaultAsLastRead() {
        XCTAssertEqual(LanguageChoice.starting(stored: nil, platformDefault: "fa", compiled: .en), .fa)
    }

    func testThenTheBuildsOwn() {
        XCTAssertEqual(LanguageChoice.starting(stored: nil, platformDefault: nil, compiled: .en), .en)
        // Values this app does not speak are passed over, not trusted.
        XCTAssertEqual(LanguageChoice.starting(stored: "de", platformDefault: "xx", compiled: .fa), .fa)
    }

    func testThePlatformsDefaultMovesOnlyAnOperatorWhoHasNotChosen() {
        XCTAssertEqual(LanguageChoice.adopt(platformDefault: .fa, hasChosen: false, current: .en), .fa)
        XCTAssertNil(LanguageChoice.adopt(platformDefault: .fa, hasChosen: true, current: .en), "a choice is never overridden")
        XCTAssertNil(LanguageChoice.adopt(platformDefault: .fa, hasChosen: false, current: .fa), "already there")
    }

    func testThePublicConfigIsReadLeniently() throws {
        let decode = { (json: String) in try JSONDecoder().decode(MobilePublicConfig.self, from: Data(json.utf8)) }
        XCTAssertEqual(try decode(#"{"platform":"ios","defaultLanguage":"fa"}"#).defaultLanguage, .fa)
        XCTAssertNil(try decode(#"{"platform":"ios","defaultLanguage":"de"}"#).defaultLanguage)
        XCTAssertNil(try decode(#"{"platform":"ios"}"#).defaultLanguage)
        XCTAssertNil(try decode(#"{"defaultLanguage":7}"#).defaultLanguage)
    }

    func testThePrivacyPolicyAndTermsAreKeptOnlyAsHttpsAddresses() throws {
        let decode = { (json: String) in try JSONDecoder().decode(MobilePublicConfig.self, from: Data(json.utf8)) }
        let set = try decode(#"{"privacyPolicyUrl":"https://webyar.ai/privacy","termsUrl":" https://webyar.ai/terms "}"#)
        XCTAssertEqual(set.legal.privacyPolicy?.absoluteString, "https://webyar.ai/privacy")
        XCTAssertEqual(set.legal.terms?.absoluteString, "https://webyar.ai/terms")
        XCTAssertFalse(set.legal.isEmpty)

        let refused = try decode(#"{"privacyPolicyUrl":"http://webyar.ai/privacy","termsUrl":"javascript:alert(1)"}"#)
        XCTAssertTrue(refused.legal.isEmpty, "only https is linked")
        XCTAssertTrue(try decode(#"{"privacyPolicyUrl":null,"termsUrl":7}"#).legal.isEmpty)
    }
}
