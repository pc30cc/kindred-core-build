import Foundation

enum AvatarOs: Sendable { case none, apple, windows, linux, android }

/// An HSL colour, as the web console writes its gradients.
struct Hsl: Sendable, Equatable {
    var h: Double, s: Double, l: Double

    init(_ h: Double, _ s: Double, _ l: Double) { self.h = h; self.s = s; self.l = l }

    /// 0…1 components.
    var rgb: (r: Double, g: Double, b: Double) {
        let s = self.s / 100, l = self.l / 100
        let c = (1 - abs(2 * l - 1)) * s
        let hp = h.truncatingRemainder(dividingBy: 360) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        let (r, g, b): (Double, Double, Double)
        switch hp {
        case ..<1: (r, g, b) = (c, x, 0)
        case ..<2: (r, g, b) = (x, c, 0)
        case ..<3: (r, g, b) = (0, c, x)
        case ..<4: (r, g, b) = (0, x, c)
        case ..<5: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        let m = l - c / 2
        func clamp(_ v: Double) -> Double { min(1, max(0, v)) }
        return (clamp(r + m), clamp(g + m), clamp(b + m))
    }
}

/// What a visitor's avatar shows, computed exactly like the web console's
/// ContactAvatar (and the Windows app's AvatarArt): their photo; else, when
/// the operating system is known, its logo on that OS's gradient; else their
/// initials on a gradient picked by a djb2 hash of the name.
struct AvatarArt: Sendable, Equatable {
    var os: AvatarOs
    var initials: String
    var from: Hsl
    var to: Hsl
    var angleDegrees: Double

    private static let palette: [(Double, Double)] = [
        (212, 92), (262, 78), (192, 78), (152, 62), (172, 70), (232, 88),
        (292, 70), (332, 78), (16, 86), (36, 90), (142, 64), (202, 88),
    ]

    static func make(name: String?, email: String?, os: String?) -> AvatarArt {
        let kind = osOf(os)
        let initials = initialsOf(name: name, email: email)
        switch kind {
        case .apple: return AvatarArt(os: kind, initials: initials, from: Hsl(220, 8, 42), to: Hsl(220, 12, 16), angleDegrees: 140)
        case .windows: return AvatarArt(os: kind, initials: initials, from: Hsl(201, 92, 56), to: Hsl(217, 90, 44), angleDegrees: 140)
        case .linux: return AvatarArt(os: kind, initials: initials, from: Hsl(38, 96, 58), to: Hsl(22, 90, 48), angleDegrees: 140)
        case .android: return AvatarArt(os: kind, initials: initials, from: Hsl(150, 68, 50), to: Hsl(142, 72, 34), angleDegrees: 140)
        case .none: break
        }
        let seed = ((name ?? "").isEmpty ? email ?? "" : name!).lowercased()
        let (h, s) = palette[Int(djb2(seed.isEmpty ? "?" : seed) % 12)]
        return AvatarArt(os: .none, initials: initials, from: Hsl(h, s, 56), to: Hsl((h + 28).truncatingRemainder(dividingBy: 360), s, 44), angleDegrees: 135)
    }

    static func osOf(_ os: String?) -> AvatarOs {
        let o = (os ?? "").lowercased()
        if o.isEmpty { return .none }
        if o.contains("mac") || o.contains("ios") || o.contains("iphone") || o.contains("ipad") { return .apple }
        if o.contains("win") { return .windows }
        if o.contains("android") { return .android }
        if o.contains("linux") || o.contains("ubuntu") { return .linux }
        return .none
    }

    /// JavaScript's `((h << 5) + h) ^ charCode` over UTF-16 units, then `>>> 0`.
    static func djb2(_ s: String) -> UInt32 {
        var h: Int32 = 5381
        for c in s.utf16 { h = ((h &<< 5) &+ h) ^ Int32(c) }
        return UInt32(bitPattern: h)
    }

    static func initialsOf(name: String?, email: String?) -> String {
        let src = ((name ?? "").isEmpty ? email ?? "" : name!).trimmingCharacters(in: .whitespacesAndNewlines)
        if src.isEmpty { return "?" }
        let parts = src.split(whereSeparator: { $0.isWhitespace })
        if parts.count >= 2 { return (String(parts[0].prefix(1)) + String(parts[1].prefix(1))).uppercased() }
        return String(parts[0].prefix(parts[0].count >= 2 ? 2 : 1)).uppercased()
    }

    /// The country as a flag: macOS draws flag emoji, unlike Windows.
    static func flag(_ countryCode: String?) -> String? {
        guard let cc = countryCode?.uppercased(), cc.count == 2, cc.unicodeScalars.allSatisfy({ $0.value >= 65 && $0.value <= 90 }) else { return nil }
        var out = ""
        for u in cc.unicodeScalars { if let s = Unicode.Scalar(0x1F1E6 + u.value - 65) { out.unicodeScalars.append(s) } }
        return out
    }
}
