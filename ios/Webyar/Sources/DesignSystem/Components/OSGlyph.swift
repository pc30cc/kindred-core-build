import SwiftUI

/// The operating-system families the inbox draws a brand mark for.
///
/// Resolution mirrors `src/components/visitors/OsIcon.tsx` exactly — the same
/// strings map to the same family, so a visitor shown as Windows in the web
/// inbox is Windows here too.
enum OSKind: String, Sendable {
    case apple, windows, linux, android

    static func resolve(os: String?, device: String?) -> OSKind? {
        let value = (os ?? "").lowercased()
        guard !value.isEmpty else { return nil }
        if value.contains("mac") || value.contains("ios")
            || value.contains("iphone") || value.contains("ipad") { return .apple }
        if value.contains("win") { return .windows }
        if value.contains("android") { return .android }
        if value.contains("linux") || value.contains("ubuntu") { return .linux }
        return nil
    }

    /// The same brand gradients the web uses, transcribed from
    /// `OS_GRADIENT` in `ContactAvatar.tsx` (HSL → RGB).
    var gradient: LinearGradient {
        let stops: [Color]
        switch self {
        case .apple:
            stops = [Color(hue: 220 / 360, saturation: 0.08, brightness: 0.42),
                     Color(hue: 220 / 360, saturation: 0.12, brightness: 0.16)]
        case .windows:
            stops = [Color(hue: 201 / 360, saturation: 0.92, brightness: 0.56),
                     Color(hue: 217 / 360, saturation: 0.90, brightness: 0.44)]
        case .linux:
            stops = [Color(hue: 38 / 360, saturation: 0.96, brightness: 0.58),
                     Color(hue: 22 / 360, saturation: 0.90, brightness: 0.48)]
        case .android:
            stops = [Color(hue: 150 / 360, saturation: 0.68, brightness: 0.50),
                     Color(hue: 142 / 360, saturation: 0.72, brightness: 0.34)]
        }
        // 140° in CSS runs top-left-ish to bottom-right-ish; these unit points
        // are the SwiftUI equivalent.
        return LinearGradient(colors: stops, startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// The brand mark itself.
///
/// Apple and Android come from SF Symbols. Windows and Linux are drawn from
/// the *same* SVG path data the web ships, so the two inboxes cannot drift
/// into showing subtly different marks for the same visitor.
struct OSGlyph: View {
    let kind: OSKind
    let size: CGFloat

    var body: some View {
        switch kind {
        case .apple:
            Image(systemName: "apple.logo")
                .font(.system(size: size * 0.9))
                .foregroundStyle(.white)
        case .android:
            // The web uses Lucide's generic `Smartphone`; `iphone` is its
            // closest SF Symbol and reads as a modern handset rather than the
            // keypad phone `candybarphone` draws.
            Image(systemName: "iphone")
                .font(.system(size: size * 0.92))
                .foregroundStyle(.white)
        case .windows:
            SVGShape(path: Self.windowsPath, viewBox: 24)
                .fill(.white)
                .frame(width: size, height: size)
        case .linux:
            SVGShape(path: Self.linuxPath, viewBox: 24)
                .fill(.white)
                .frame(width: size, height: size)
        }
    }

    /// Four-pane Windows monogram — `WindowsGlyph` in OsIcon.tsx.
    private static let windowsPath =
        "M3 5.5l8-1.1v7.1H3V5.5zm0 13l8 1.1v-7H3v5.9zm9 1.2l9 1.3v-8.5h-9v7.2zm0-15.4l9-1.3v8.5h-9V4.3z"

    /// Simplified Tux silhouette — `LinuxGlyph` in OsIcon.tsx.
    private static let linuxPath =
        "M12 2.4c-2 0-3.4 1.7-3.4 3.9 0 1 .3 1.9.7 2.6-.9.6-1.8 1.6-2.4 2.9-.9 2-1.4 4-2.2 5.5-.4.7-.9 1.2-.9 1.8 0 .8.8 1.3 1.7 1.5.7.2 1.4.3 1.7.6.4.4.8 1 2.1 1.2 1 .2 2.1-.1 2.7-.5.6.4 1.7.7 2.7.5 1.3-.2 1.7-.8 2.1-1.2.3-.3 1-.4 1.7-.6.9-.2 1.7-.7 1.7-1.5 0-.6-.5-1.1-.9-1.8-.8-1.5-1.3-3.5-2.2-5.5-.6-1.3-1.5-2.3-2.4-2.9.4-.7.7-1.6.7-2.6 0-2.2-1.4-3.9-3.4-3.9zm-1.4 4.1c.3 0 .5.4.5.9 0 .2 0 .4-.1.5-.1-.1-.3-.1-.4-.1-.4 0-.7.3-.7.7v.1c-.2-.2-.3-.5-.3-.8 0-.7.5-1.3 1-1.3zm2.8 0c.5 0 1 .6 1 1.3 0 .3-.1.6-.3.8v-.1c0-.4-.3-.7-.7-.7-.1 0-.3 0-.4.1-.1-.1-.1-.3-.1-.5 0-.5.2-.9.5-.9z"
}

/// Draws an SVG `path` string, scaled from its viewBox into the given rect.
///
/// Only the commands the two glyphs above actually use are implemented — move,
/// line, horizontal, vertical, cubic, close, in both absolute and relative
/// form. Anything unrecognised is skipped rather than throwing, because a
/// half-drawn icon is a better failure than a crash in a list row.
struct SVGShape: Shape {
    let path: String
    let viewBox: CGFloat

    func path(in rect: CGRect) -> Path {
        var result = Path()
        // Uniform scale keeps the glyph's proportions; the offsets centre it
        // when the rect is not square.
        let scale = min(rect.width, rect.height) / viewBox
        let offsetX = rect.minX + (rect.width - viewBox * scale) / 2
        let offsetY = rect.minY + (rect.height - viewBox * scale) / 2

        func map(_ point: CGPoint) -> CGPoint {
            CGPoint(x: offsetX + point.x * scale, y: offsetY + point.y * scale)
        }

        var cursor = CGPoint.zero
        var subpathStart = CGPoint.zero

        for (command, values) in Self.tokenize(path) {
            let isRelative = command.isLowercase
            var index = 0

            func next() -> CGFloat {
                defer { index += 1 }
                return index < values.count ? values[index] : 0
            }
            /// Resolves a pair against the cursor when the command is relative.
            func point() -> CGPoint {
                let x = next(), y = next()
                return isRelative ? CGPoint(x: cursor.x + x, y: cursor.y + y) : CGPoint(x: x, y: y)
            }

            switch command.lowercased() {
            case "m":
                cursor = point()
                subpathStart = cursor
                result.move(to: map(cursor))
                // Extra pairs after a moveto are implicit linetos.
                while index < values.count {
                    cursor = point()
                    result.addLine(to: map(cursor))
                }

            case "l":
                while index < values.count {
                    cursor = point()
                    result.addLine(to: map(cursor))
                }

            case "h":
                while index < values.count {
                    let x = next()
                    cursor = CGPoint(x: isRelative ? cursor.x + x : x, y: cursor.y)
                    result.addLine(to: map(cursor))
                }

            case "v":
                while index < values.count {
                    let y = next()
                    cursor = CGPoint(x: cursor.x, y: isRelative ? cursor.y + y : y)
                    result.addLine(to: map(cursor))
                }

            case "c":
                while index + 5 < values.count {
                    let c1 = point(), c2 = point(), end = point()
                    result.addCurve(to: map(end), control1: map(c1), control2: map(c2))
                    cursor = end
                }

            case "z":
                result.closeSubpath()
                cursor = subpathStart

            default:
                break
            }
        }
        return result
    }

    /// Splits a path string into (command, numbers) pairs.
    private static func tokenize(_ path: String) -> [(Character, [CGFloat])] {
        var result: [(Character, [CGFloat])] = []
        var command: Character?
        var numbers: [CGFloat] = []
        var buffer = ""

        func flushNumber() {
            if !buffer.isEmpty, let value = Double(buffer) {
                numbers.append(CGFloat(value))
            }
            buffer = ""
        }

        func flushCommand() {
            flushNumber()
            if let command { result.append((command, numbers)) }
            numbers = []
        }

        for character in path {
            if character.isLetter {
                flushCommand()
                command = character
            } else if character == "-" && !buffer.isEmpty && !buffer.hasSuffix("e") {
                // A minus that is not an exponent starts the next number.
                flushNumber()
                buffer = "-"
            } else if character == "," || character == " " {
                flushNumber()
            } else if character == "." && buffer.contains(".") {
                // SVG allows "0.5.5" meaning two numbers.
                flushNumber()
                buffer = "."
            } else {
                buffer.append(character)
            }
        }
        flushCommand()
        return result
    }
}
