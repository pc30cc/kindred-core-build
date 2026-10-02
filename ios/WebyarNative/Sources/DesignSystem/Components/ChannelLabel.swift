import SwiftUI

/// The channel as a small tonal label — its mark and its name, in its own
/// colour, the way the console's `ChannelBadge` shows it beside a name.
///
/// Every thread wears one, the website's included: an operator answering
/// three channels at once should not have to infer "the site" from the
/// absence of a label. A support conversation names the app it was written
/// from too — «کاربر سایت · Android». The same marks and colours as the
/// Android app's `ChannelLabel`.
struct ChannelLabel: View {
    let key: String
    let language: Language
    /// For a support conversation: the app it was written from
    /// (`ConversationChannel.clientPlatform`).
    var platform: String?
    /// A shorter pill for a dense row; the chat's bar gets the fuller one.
    var compact = false

    @Environment(\.colorScheme) private var colorScheme

    private var look: ChannelLook { ChannelLook.of(key) }

    private var tint: Color { look.color(colorScheme) }

    private var title: String { ConversationChannel.label(key, language: language, platform: platform) }

    var body: some View {
        HStack(spacing: compact ? 3 : 4) {
            ChannelMark(key: key, size: compact ? 10 : 12)
                .foregroundStyle(tint)
            Text(title)
                .font(.app(compact ? .caption2 : .caption, .medium))
                .foregroundStyle(tint)
                .lineLimit(1)
        }
        .padding(.horizontal, compact ? 6 : 8)
        .padding(.vertical, compact ? 1 : 2)
        .background(Capsule().fill(tint.opacity(0.12)))
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityIdentifier(A11y.channelLabel(key))
    }
}

/// A channel's mark on its own: an SF Symbol, or the X logo, which SF Symbols
/// does not carry.
struct ChannelMark: View {
    let key: String
    var size: CGFloat = 12

    var body: some View {
        if key == "x" {
            XLogo()
                .fill(style: FillStyle(eoFill: true))
                .frame(width: size, height: size)
        } else {
            Image(systemName: ChannelLook.of(key).symbol)
                .font(.system(size: size, weight: .semibold))
        }
    }
}

/// A channel's mark and its colour, light and dark.
struct ChannelLook {
    enum Tint {
        case brand
        case neutral
        case rgb(light: UInt32, dark: UInt32)
    }

    let symbol: String
    let tint: Tint

    /// The colour, in the scheme on screen.
    func color(_ scheme: ColorScheme) -> Color {
        switch tint {
        case .brand: Theme.Palette.brand
        case .neutral: Theme.Palette.labelSecondary
        case .rgb(let light, let dark): scheme == .dark ? Color(hex: dark) : Color(hex: light)
        }
    }

    static func of(_ key: String) -> ChannelLook {
        switch key {
        case ConversationChannel.web: ChannelLook(symbol: "globe", tint: .brand)
        case "telegram": ChannelLook(symbol: "paperplane.fill", tint: .rgb(light: 0x1C8AD1, dark: 0x6CC3F5))
        case "bale": ChannelLook(symbol: "paperplane.fill", tint: .rgb(light: 0x12806A, dark: 0x5ED3B6))
        case "whatsapp": ChannelLook(symbol: "bubble.left.fill", tint: .rgb(light: 0x128C4A, dark: 0x5FD98E))
        case "instagram": ChannelLook(symbol: "camera.fill", tint: .rgb(light: 0xC72A6E, dark: 0xF57EAE))
        case "x": ChannelLook(symbol: "xmark", tint: .neutral)
        case "email": ChannelLook(symbol: "envelope.fill", tint: .neutral)
        case "phone": ChannelLook(symbol: "phone.fill", tint: .neutral)
        case ConversationChannel.platformSupport: ChannelLook(symbol: "headset", tint: .rgb(light: 0x6A4BD6, dark: 0xB9A8FF))
        default: ChannelLook(symbol: "bubble.left.fill", tint: .neutral)
        }
    }
}

/// The X mark, on the 24-unit grid the Android app draws it on.
private struct XLogo: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        path.move(to: p(18.9, 1.15))
        for point in [
            p(22.58, 1.15), p(14.54, 10.35), p(24, 22.85), p(16.6, 22.85), p(10.8, 15.26),
            p(4.16, 22.85), p(0.47, 22.85), p(9.07, 13.02), p(0, 1.15), p(7.6, 1.15), p(12.84, 8.08),
        ] {
            path.addLine(to: point)
        }
        path.closeSubpath()
        path.move(to: p(17.61, 20.64))
        path.addLine(to: p(19.65, 20.64))
        path.addLine(to: p(6.49, 3.24))
        path.addLine(to: p(4.3, 3.24))
        path.closeSubpath()
        return path
    }
}

extension Color {
    /// `0xRRGGBB`.
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
