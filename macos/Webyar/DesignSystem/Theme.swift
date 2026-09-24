import AppKit
import CoreText
import SwiftUI

/// The same design tokens as the Windows app (windows-native App.xaml), the
/// iOS app and the web console: brand blue #3B7AF2, lifted to #5A94FF in dark.
enum Palette {
    private static func dynamic(_ light: UInt32, _ dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua, .vibrantDark, .vibrantLight, .accessibilityHighContrastDarkAqua, .accessibilityHighContrastAqua]).map {
                $0 == .darkAqua || $0 == .vibrantDark || $0 == .accessibilityHighContrastDarkAqua
            } ?? false
            let v = isDark ? dark : light
            return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                           blue: CGFloat(v & 0xFF) / 255, alpha: isDark ? darkAlpha : lightAlpha)
        })
    }

    static let appBackground = dynamic(0xF4F6F9, 0x0C0E14)
    static let surface = dynamic(0xFFFFFF, 0x13161E)
    static let surface2 = dynamic(0xF8F9FB, 0x171B24)
    static let elevated = dynamic(0xEEF1F5, 0x1D222D)
    static let hover = dynamic(0xEEF2F8, 0x1B202A)
    static let selected = dynamic(0xE7EFFE, 0x1B2740)
    static let line = dynamic(0xE3E7EE, 0x242A36)
    static let lineStrong = dynamic(0xD2D8E2, 0x313848)
    static let text = dynamic(0x0F1729, 0xE8ECF4)
    static let text2 = dynamic(0x5B6577, 0x98A2B3)
    static let text3 = dynamic(0x98A2B3, 0x667085)
    static let brand = dynamic(0x3B7AF2, 0x5A94FF)
    static let brandSoft = dynamic(0x3B7AF2, 0x5A94FF, lightAlpha: 0.12, darkAlpha: 0.16)
    static let danger = dynamic(0xE5484D, 0xFF6369)
    static let dangerSoft = dynamic(0xE5484D, 0xFF6369, lightAlpha: 0.12, darkAlpha: 0.14)
    static let success = dynamic(0x30A46C, 0x3DD68C)
    static let successSoft = dynamic(0x30A46C, 0x3DD68C, lightAlpha: 0.14, darkAlpha: 0.14)
    static let warning = dynamic(0xF76B15, 0xFF8B3E)
    static let warningSoft = dynamic(0xF76B15, 0xFF8B3E, lightAlpha: 0.14, darkAlpha: 0.16)
    static let info = dynamic(0x4185C8, 0x5B9BD9)
    static let ai = dynamic(0x7C4DDB, 0xA585F0)
    static let aiSoft = dynamic(0x7C4DDB, 0xA585F0, lightAlpha: 0.12, darkAlpha: 0.16)
    static let bubbleIncoming = dynamic(0xFFFFFF, 0x1B2029)
    static let bubbleIncomingBorder = dynamic(0xE4E8EF, 0x2A303D)
    static let noteBubble = dynamic(0xFFF8E6, 0x2A2415)
    static let noteBorder = dynamic(0xF5D98A, 0x5C4A1C)
    static let chatBackground = dynamic(0xF5F7FA, 0x0F1218)
    static let waveIn = dynamic(0xC7D0DE, 0x434C5E)
    static let fileTile = dynamic(0xF1F4F9, 0x1D222D)

    /// Operator bubbles: the brand blue with a soft diagonal lift, as in the web thread.
    static let bubbleOutgoing = LinearGradient(
        colors: [dynamic(0x4C88F6, 0x4F8BF5), dynamic(0x3169E4, 0x356FDF)],
        startPoint: .topLeading, endPoint: .bottomTrailing)

    /// The sign-in panel's deep blue.
    static let brandPanel = LinearGradient(
        stops: [.init(color: Color(hex: 0x2F6BFF), location: 0), .init(color: Color(hex: 0x1C47C9), location: 0.55), .init(color: Color(hex: 0x122E8A), location: 1)],
        startPoint: .topLeading, endPoint: .bottomTrailing)

    /// (foreground, background) for a conversation status chip.
    static func status(_ status: String) -> (Color, Color) {
        switch status {
        case ConversationStatus.open: return (brand, brandSoft)
        case ConversationStatus.pending: return (warning, warningSoft)
        case ConversationStatus.resolved, ConversationStatus.closed: return (success, successSoft)
        default: return (text2, elevated)
        }
    }

    static func priority(_ priority: String?) -> (Color, Color) {
        switch priority {
        case ConversationPriority.urgent: return (danger, dangerSoft)
        case ConversationPriority.high: return (warning, warningSoft)
        case ConversationPriority.low: return (text3, elevated)
        default: return (text2, elevated)
        }
    }

    /// The dot on an avatar: operator presence, visitor presence or a conversation status.
    static func dot(_ state: String) -> (fill: Color, ring: Bool) {
        switch state {
        case "active", "online", "open": return (success, false)
        case "away", "idle", "pending": return (warning, false)
        case "resolved": return (info, false)
        case "disconnected": return (text3, true)
        default: return (text3, false)
        }
    }

    // windows/src/renderer/src/components/Avatar.tsx, colour for colour.
    private static let avatarColors: [UInt32] = [0x3B7AF2, 0x7C4DDB, 0x0EA5A4, 0xE5484D, 0xF76B15, 0x30A46C, 0xD6409F, 0x0091FF, 0x8E4EC6, 0x12A594]

    /// The same 31-multiplier hash as the web console, so a name keeps its colour across apps.
    static func hash(_ s: String) -> Int {
        var h: Int32 = 0
        for ch in s.utf16 { h = h &* 31 &+ Int32(ch) }
        return h == Int32.min ? 0 : Int(abs(h))
    }

    static func avatarColor(_ name: String) -> Color { Color(hex: avatarColors[hash(name) % avatarColors.count]) }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }

    init(_ hsl: Hsl) {
        let c = hsl.rgb
        self.init(.sRGB, red: c.r, green: c.g, blue: c.b, opacity: 1)
    }
}

/// IRANSans for Persian, the web console's own font (the Windows app bundles
/// the same file); San Francisco for English and Turkish.
enum Typeface {
    @MainActor static var persian = false

    static func register() {
        guard let url = Bundle.main.url(forResource: "IRANSans", withExtension: "ttc") else { return }
        var error: Unmanaged<CFError>?
        if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
            Log.write("[font] IRANSans: \(String(describing: error?.takeRetainedValue()))")
        }
    }

    @MainActor
    static func font(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        guard persian else { return .system(size: size, weight: weight) }
        let name: String
        switch weight {
        case .bold, .heavy, .black, .semibold: name = weight == .semibold ? "IRANSans-Medium" : "IRANSans-Bold"
        case .medium: name = "IRANSans-Medium"
        default: name = "IRANSans-Regular"
        }
        // Persian letters read small beside Latin at the same point size.
        return .custom(name, size: size + 0.5)
    }
}

extension View {
    /// Text in the app's typeface for the current language.
    @MainActor
    func appFont(_ size: CGFloat, _ weight: Font.Weight = .regular) -> some View {
        font(Typeface.font(size, weight))
    }
}

// MARK: - Liquid Glass

extension View {
    /// Liquid Glass on macOS 26, the nearest material before it.
    @ViewBuilder
    func glass<S: Shape>(_ shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(macOS 26.0, *) {
            glassEffect(Glass.regular.tint(tint).interactive(interactive), in: shape)
        } else {
            background {
                ZStack {
                    shape.fill(.regularMaterial)
                    if let tint { shape.fill(tint.opacity(0.25)) }
                    shape.strokeBorder(Palette.line.opacity(0.8), lineWidth: 0.5)
                }
            }
        }
    }

    func glassCard(_ radius: CGFloat = 16, tint: Color? = nil, interactive: Bool = false) -> some View {
        glass(RoundedRectangle(cornerRadius: radius, style: .continuous), tint: tint, interactive: interactive)
    }

    func glassCapsule(tint: Color? = nil, interactive: Bool = false) -> some View {
        glass(Capsule(), tint: tint, interactive: interactive)
    }

    /// A white card on the grey background — the shape every panel in the product uses.
    func panel(_ radius: CGFloat = 14) -> some View {
        background(Palette.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
    }
}

/// A group of glass shapes that blend into one another when close, on macOS 26.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 8
    @ViewBuilder var content: Content

    var body: some View {
        if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

/// The standard filled button, glass-prominent on macOS 26.
struct ProminentButtonStyle: ViewModifier {
    var tint: Color = Palette.brand
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.buttonStyle(.glassProminent).tint(tint)
        } else {
            content.buttonStyle(.borderedProminent).tint(tint)
        }
    }
}

struct GlassButtonStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.buttonStyle(.glass)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}

extension View {
    func prominentButton(tint: Color = Palette.brand) -> some View { modifier(ProminentButtonStyle(tint: tint)) }
    func glassButton() -> some View { modifier(GlassButtonStyle()) }
}
