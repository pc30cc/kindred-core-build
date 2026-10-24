import SwiftUI
import XCTest
@testable import Webyar

/// The platform's two avatar glyphs (`AvatarGlyphs.swift`): a teammate
/// without a photo is the person glyph and a workspace without a logo the
/// shop front, never letters. The paths are the canonical ones
/// (`src/test/native/avatarGlyphs.test.ts` compares the strings); these
/// check that they are read and drawn where they should be.
@MainActor
final class AvatarGlyphTests: XCTestCase {
    private func box(_ glyph: AvatarGlyph, in rect: CGRect) -> CGRect {
        AvatarGlyphShape(glyph: glyph).path(in: rect).boundingRect
    }

    private func assertRect(_ rect: CGRect, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        let accuracy: CGFloat = 0.05
        XCTAssertEqual(rect.minX, expected.minX, accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(rect.minY, expected.minY, accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(rect.maxX, expected.maxX, accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(rect.maxY, expected.maxY, accuracy: accuracy, file: file, line: line)
    }

    func testThePersonFillsItsGridFromThreeToTwentyOne() {
        // Head r 4.5 at (12, 7.5), shoulders from x 4 to 20 down to y 21.
        assertRect(box(.person, in: CGRect(x: 0, y: 0, width: 24, height: 24)), CGRect(x: 4, y: 3, width: 16, height: 18))
    }

    func testTheWorkspaceFillsItsGridFromThreeToTwentyOne() {
        // The awning runs from x 2.5 to 21.5; the walls end at y 21.
        assertRect(box(.workspace, in: CGRect(x: 0, y: 0, width: 24, height: 24)), CGRect(x: 2.5, y: 3, width: 19, height: 18))
    }

    func testAGlyphIsScaledToTheShorterSideAndCentred() {
        // 48 wide, 24 high: the 24-unit box sits in the middle, unstretched.
        assertRect(box(.workspace, in: CGRect(x: 0, y: 0, width: 48, height: 24)), CGRect(x: 14.5, y: 3, width: 19, height: 18))
        // Doubled, and moved with its rect.
        assertRect(box(.person, in: CGRect(x: 10, y: 10, width: 48, height: 48)), CGRect(x: 18, y: 16, width: 32, height: 36))
    }

    func testTheArcsBecomeCurvesAndEveryOutlineCloses() {
        let person = AvatarGlyphPath.segments(AvatarGlyph.person.pathData)
        // The head is two half circles, each two quarter curves.
        XCTAssertEqual(person.filter { if case .curve = $0 { return true } else { return false } }.count, 4 + 4)
        XCTAssertEqual(person.filter { $0 == .close }.count, 2)
        XCTAssertEqual(person.first, .move(CGPoint(x: 12, y: 3)))

        let workspace = AvatarGlyphPath.segments(AvatarGlyph.workspace.pathData)
        // The outer contour and the one cut out of it.
        XCTAssertEqual(workspace.filter { $0 == .close }.count, 2)
        XCTAssertEqual(workspace.first, .move(CGPoint(x: 6.6, y: 3)))
        XCTAssertFalse(workspace.contains { if case .line(let to) = $0 { return to == .zero } else { return false } })
    }

    func testAHalfCircleArcEndsExactlyWhereItWasAimed() {
        let curves = AvatarGlyphPath.arc(from: CGPoint(x: 12, y: 3), to: CGPoint(x: 12, y: 12), radius: 4.5, large: true, sweep: true)
        XCTAssertEqual(curves.count, 2)
        guard case .curve(_, _, let middle) = curves[0], case .curve(_, _, let end) = curves[1] else {
            return XCTFail("an arc is drawn as curves")
        }
        // Clockwise from the top passes the right-hand side.
        XCTAssertEqual(middle.x, 16.5, accuracy: 0.0001)
        XCTAssertEqual(middle.y, 7.5, accuracy: 0.0001)
        XCTAssertEqual(end, CGPoint(x: 12, y: 12))
    }

    func testTheGlyphsTakeTheirShareOfTheTile() {
        XCTAssertEqual(AvatarGlyph.person.fraction(forSide: 40), 0.62)
        XCTAssertEqual(AvatarGlyph.person.fraction(forSide: 20), 0.68)
        XCTAssertEqual(AvatarGlyph.workspace.fraction(forSide: 40), 0.58)
        XCTAssertEqual(AvatarGlyph.workspace.fraction(forSide: 24), 0.62)
    }
}
