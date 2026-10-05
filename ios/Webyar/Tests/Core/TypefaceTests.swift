import CoreText
import UIKit
import XCTest
@testable import Webyar

/// The Persian font, `Resources/fa.ttc`: its three faces are found by
/// reading the file, so this is what says the names it hands out are faces
/// UIKit can load, lightest to heaviest.
final class TypefaceTests: XCTestCase {
    @MainActor
    func testThePersianFontsThreeFacesLoadInWeightOrder() throws {
        Typeface.use(.fa)
        defer { Typeface.use(.en) }
        XCTAssertTrue(Typeface.isPersian)

        let weights = try Typeface.Face.allCases.map { face -> Double in
            let font = try XCTUnwrap(UIFont(name: face.name, size: 12), "\(face) does not load")
            let traits = CTFontCopyTraits(font as CTFont) as? [CFString: Any]
            return try XCTUnwrap(traits?[kCTFontWeightTrait] as? NSNumber).doubleValue
        }
        XCTAssertEqual(weights, weights.sorted())
        XCTAssertEqual(Set(Typeface.Face.allCases.map(\.name)).count, 3)
    }

    @MainActor
    func testArabicIsSetInTheSystemFace() {
        Typeface.use(.ar)
        defer { Typeface.use(.en) }
        XCTAssertFalse(Typeface.isPersian)
    }
}
