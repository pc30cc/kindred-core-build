import Foundation
import SwiftUI

// The platform's two avatar glyphs. This file is in both Apple apps, the
// iPhone's (ios/Webyar/Sources/DesignSystem/Components/AvatarGlyphs.swift)
// and the Mac's (macos/Webyar/DesignSystem/AvatarGlyphs.swift); keep the two
// copies identical (src/test/native/avatarGlyphs.test.ts checks it).
//
// The source of truth for the paths is shared/avatarGlyphs.ts
// (PERSON_SILHOUETTE and WORKSPACE_MARK). Change them there first, then
// here: src/test/native/avatarGlyphs.test.ts fails until this copy matches.

/// The two glyphs the whole product draws where there is no picture, on a
/// 24 × 24 grid:
///
/// - `person`: a head-and-shoulders silhouette, for an operator or a
///   teammate without a photo. Never initials.
/// - `workspace`: a shop front, for a workspace whose owner has set no
///   logo. Never its first letter.
///
/// One design for the web panel, both website widgets and every native app,
/// so they are not redrawn here: the strings are the paths of
/// `shared/avatarGlyphs.ts` (the source of truth) in their expanded form
/// (absolute commands, every number on its own), and
/// `src/test/native/avatarGlyphs.test.ts` compares them with the shared
/// ones point for point.
///
/// Both are left–right symmetric, so they never mirror under right to left,
/// and no outline overlaps another, so either fill rule gives the same
/// pixels.
enum AvatarGlyph: Sendable {
    case person
    case workspace

    var pathData: String {
        switch self {
        case .person:
            return "M 12 3 A 4.5 4.5 0 1 1 12 12 A 4.5 4.5 0 0 1 12 3 Z "
                + "M 12 13.75 C 7.4 13.75 4 16.05 4 19 C 4 20.1 4.9 21 6 21 L 18 21 "
                + "C 19.1 21 20 20.1 20 19 C 20 16.05 16.6 13.75 12 13.75 Z"
        case .workspace:
            return "M 6.6 3 L 17.4 3 Q 18.3 3 18.78 3.83 L 21.5 8.5 A 2.375 2.375 0 0 1 20.25 10.59 "
                + "L 20.25 18.75 A 2.25 2.25 0 0 1 18 21 L 6 21 A 2.25 2.25 0 0 1 3.75 18.75 "
                + "L 3.75 10.59 A 2.375 2.375 0 0 1 2.5 8.5 L 5.22 3.83 Q 5.7 3 6.6 3 Z "
                + "M 5.75 10.71 L 5.75 18.75 Q 5.75 19 6 19 L 10 19 L 10 16.25 A 2 2 0 0 1 14 16.25 "
                + "L 14 19 L 18 19 Q 18.25 19 18.25 18.75 L 18.25 10.71 A 2.375 2.375 0 0 1 16.75 8.5 "
                + "A 2.375 2.375 0 0 1 12 8.5 A 2.375 2.375 0 0 1 7.25 8.5 A 2.375 2.375 0 0 1 5.75 10.71 Z"
        }
    }

    /// `pathData` as drawing steps in the 24-unit box. Each glyph is read
    /// once, on first use, and kept (a static `let` is set up lazily, once,
    /// safely across threads), so drawing only scales and moves the steps.
    var segments: [AvatarGlyphPath.Segment] {
        switch self {
        case .person: return Self.personSegments
        case .workspace: return Self.workspaceSegments
        }
    }

    private static let personSegments: [AvatarGlyphPath.Segment] =
        AvatarGlyphPath.segments(AvatarGlyph.person.pathData)
    private static let workspaceSegments: [AvatarGlyphPath.Segment] =
        AvatarGlyphPath.segments(AvatarGlyph.workspace.pathData)

    /// How much of its tile the glyph's 24-unit box takes, centred: 62% for
    /// the person and 58% for the workspace, a little more on a chip of 24
    /// points or less so the figure stays legible.
    func fraction(forSide side: CGFloat) -> CGFloat {
        switch self {
        case .person: return side <= 24 ? 0.68 : 0.62
        case .workspace: return side <= 24 ? 0.62 : 0.58
        }
    }
}

/// Turns a glyph's path into drawing steps, its arcs already as cubic
/// curves: SwiftUI draws an arc from a centre and two angles, SVG from two
/// end points, and the curves need no reading of which way "clockwise" runs
/// in a flipped space.
enum AvatarGlyphPath {
    enum Segment: Equatable, Sendable {
        case move(CGPoint)
        case line(CGPoint)
        case quad(CGPoint, CGPoint)
        case curve(CGPoint, CGPoint, CGPoint)
        case close
    }

    /// The expanded form only: absolute M, L, Q, C, A and Z, every number
    /// separated by a space. Anything else is skipped.
    static func segments(_ data: String) -> [Segment] {
        let tokens = data.split(whereSeparator: { $0 == " " || $0 == "," }).map(String.init)
        var result: [Segment] = []
        var index = 0
        var command = ""
        var current = CGPoint.zero
        var start = CGPoint.zero

        func number() -> CGFloat {
            defer { index += 1 }
            guard index < tokens.count, let value = Double(tokens[index]) else { return 0 }
            return CGFloat(value)
        }
        func point() -> CGPoint {
            let x = number()
            let y = number()
            return CGPoint(x: x, y: y)
        }

        while index < tokens.count {
            if let first = tokens[index].first, first.isLetter {
                command = tokens[index]
                index += 1
            }
            switch command {
            case "M":
                current = point()
                start = current
                result.append(.move(current))
                // More pairs after a move are lines.
                command = "L"
            case "L":
                current = point()
                result.append(.line(current))
            case "Q":
                let control = point()
                current = point()
                result.append(.quad(control, current))
            case "C":
                let control1 = point()
                let control2 = point()
                current = point()
                result.append(.curve(control1, control2, current))
            case "A":
                // The glyphs' arcs are circles, unrotated: rx, ry, rotation.
                let radius = number()
                _ = number()
                _ = number()
                let large = number() != 0
                let sweep = number() != 0
                let end = point()
                result += arc(from: current, to: end, radius: radius, large: large, sweep: sweep)
                current = end
            case "Z":
                result.append(.close)
                current = start
                command = ""
            default:
                // Not a command these glyphs use: step over it rather than stall.
                index += 1
            }
        }
        return result
    }

    /// SVG's end-point arc of a circle as cubic curves, one per quarter turn
    /// or less (the centre as in SVG 1.1, appendix F.6.5). A radius too short
    /// to reach the end point is lengthened until it does, as SVG does.
    static func arc(from p1: CGPoint, to p2: CGPoint, radius: CGFloat, large: Bool, sweep: Bool) -> [Segment] {
        let x1 = Double(p1.x), y1 = Double(p1.y)
        let x2 = Double(p2.x), y2 = Double(p2.y)
        let hx = (x1 - x2) / 2, hy = (y1 - y2) / 2
        let half = hx * hx + hy * hy
        guard half > 0, radius > 0 else { return [.line(p2)] }

        var r = Double(radius)
        if half > r * r { r = half.squareRoot() }
        var k = (max(0, r * r - half) / half).squareRoot()
        if large == sweep { k = -k }
        let cx = k * hy + (x1 + x2) / 2
        let cy = -k * hx + (y1 + y2) / 2

        let startAngle = atan2(y1 - cy, x1 - cx)
        var delta = atan2(y2 - cy, x2 - cx) - startAngle
        if sweep && delta < 0 { delta += 2 * Double.pi }
        if !sweep && delta > 0 { delta -= 2 * Double.pi }

        let count = max(1, Int((abs(delta) / (Double.pi / 2) - 1e-9).rounded(.up)))
        let step = delta / Double(count)
        let handle = 4.0 / 3.0 * tan(step / 4) * r

        var result: [Segment] = []
        var a = startAngle
        for i in 0..<count {
            let b = a + step
            let fromX = cx + r * cos(a), fromY = cy + r * sin(a)
            let last = i == count - 1
            let toX = last ? x2 : cx + r * cos(b)
            let toY = last ? y2 : cy + r * sin(b)
            let control1 = CGPoint(x: fromX - handle * sin(a), y: fromY + handle * cos(a))
            let control2 = CGPoint(x: toX + handle * sin(b), y: toY - handle * cos(b))
            result.append(.curve(control1, control2, CGPoint(x: toX, y: toY)))
            a = b
        }
        return result
    }
}

// MARK: - Drawing

/// An `AvatarGlyph` as a shape: its 24-unit box scaled to the rect's
/// shorter side and centred in it. Fill it with the tile's ink. The glyph's
/// steps are read once (`AvatarGlyph.segments`); this only places them.
struct AvatarGlyphShape: Shape {
    let glyph: AvatarGlyph

    func path(in rect: CGRect) -> Path {
        let unit = min(rect.width, rect.height) / 24
        let originX = rect.midX - 12 * unit
        let originY = rect.midY - 12 * unit
        func map(_ point: CGPoint) -> CGPoint {
            CGPoint(x: originX + point.x * unit, y: originY + point.y * unit)
        }

        var path = Path()
        for segment in glyph.segments {
            switch segment {
            case .move(let to):
                path.move(to: map(to))
            case .line(let to):
                path.addLine(to: map(to))
            case .quad(let control, let to):
                path.addQuadCurve(to: map(to), control: map(control))
            case .curve(let control1, let control2, let to):
                path.addCurve(to: map(to), control1: map(control1), control2: map(control2))
            case .close:
                path.closeSubpath()
            }
        }
        return path
    }
}

/// A glyph at its share of a tile `side` points across, for laying over
/// the tile's own background. Decoration: the name beside it is what a
/// screen reader reads.
struct AvatarGlyphView<Ink: ShapeStyle>: View {
    let glyph: AvatarGlyph
    let side: CGFloat
    let ink: Ink

    var body: some View {
        let box = side * glyph.fraction(forSide: side)
        AvatarGlyphShape(glyph: glyph)
            .fill(ink)
            .frame(width: box, height: box)
            .accessibilityHidden(true)
    }
}
