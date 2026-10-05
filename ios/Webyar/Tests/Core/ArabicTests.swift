import Foundation
import SwiftUI
import XCTest
@testable import Webyar

/// Arabic, as the app speaks it: right to left, in Arabic-Indic digits and
/// the Gregorian calendar, with its nouns counted the way Arabic counts them
/// — and English to a server that speaks only the product's three languages.
final class ArabicTests: XCTestCase {
    func testArabicReadsRightToLeftAndNamesItself() {
        XCTAssertEqual(Language.ar.layoutDirection, .rightToLeft)
        XCTAssertEqual(Language.ar.endonym, "العربية")
        XCTAssertEqual(Language.ar.listSeparator, "، ")
        XCTAssertEqual(Language.fa.listSeparator, "، ")
        XCTAssertEqual(Language.en.listSeparator, ", ")
    }

    func testNumbersAndClocksAreInArabicIndicDigits() {
        XCTAssertEqual(Format.number(2026, language: .ar), "٢٠٢٦")
        XCTAssertEqual(Format.openingTime("17:30", language: .ar), "١٧:٣٠")
    }

    func testDatesAreGregorianNotHijri() {
        XCTAssertEqual(Format.workingCalendar(Language.ar.locale).identifier, .gregorian)
    }

    /// One and two have words of their own; three to ten take the plural;
    /// eleven to ninety-nine the singular; a hundred another form again.
    func testNounsAreCountedTheArabicWay() {
        func days(_ n: Int) -> String {
            Format.arabicCount(n, one: "يوم واحد", two: "يومان", few: "أيام", many: "يومًا", other: "يوم")
        }
        XCTAssertEqual(days(1), "يوم واحد")
        XCTAssertEqual(days(2), "يومان")
        XCTAssertEqual(days(3), "٣ أيام")
        XCTAssertEqual(days(10), "١٠ أيام")
        XCTAssertEqual(days(11), "١١ يومًا")
        XCTAssertEqual(days(99), "٩٩ يومًا")
        XCTAssertEqual(days(100), "١٠٠ يوم")
        XCTAssertEqual(days(103), "١٠٣ أيام")
        XCTAssertEqual(EmailStr.messagesCount(.ar, 5), "٥ رسائل")
    }

    func testTheServerIsAskedInEnglish() {
        XCTAssertEqual(Language.ar.serverLocale, "en")
        XCTAssertEqual(Language.fa.serverLocale, "fa")
        XCTAssertEqual(Language.tr.serverLocale, "tr")
    }

    func testTheOperatorCanChooseArabic() {
        XCTAssertTrue(Language.allCases.contains(.ar))
        XCTAssertEqual(LanguageChoice.starting(stored: "ar", platformDefault: "fa", compiled: .en), .ar)
        XCTAssertEqual(Str.cancel(.ar), "إلغاء")
    }
}
