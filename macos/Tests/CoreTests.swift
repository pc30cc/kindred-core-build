import XCTest
@testable import Webyar

final class CoreTests: XCTestCase {
    func testDjb2MatchesTheWeb() {
        XCTAssertEqual(AvatarArt.djb2("?"), 177562)
    }

    func testLegacyCodeIsFourCharacters() {
        XCTAssertEqual(Display.legacyCode("abc").count, 4)
    }

    func testParsesPostgresDates() {
        XCTAssertNotNil(JSON.parseDate("2025-01-02T03:04:05.123456+00:00"))
        XCTAssertNotNil(JSON.parseDate("2025-01-02 03:04:05+00"))
        XCTAssertNotNil(JSON.parseDate("2025-01-02T03:04:05Z"))
    }
}
