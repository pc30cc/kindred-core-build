import SwiftUI

/// A contact avatar: the remote image when there is one, otherwise initials on
/// a colour derived from the identifier.
///
/// Deriving the colour from a hash rather than picking randomly means the same
/// person is the same colour on every launch and on every screen, which is
/// what lets someone recognise a thread at a glance.
struct Avatar: View {
    let name: String
    let imageURL: String?
    var size: CGFloat = Theme.Size.avatarMedium

    private var initials: String {
        let words = name
            .split(separator: " ", omittingEmptySubsequences: true)
            .prefix(2)
        let letters = words.compactMap(\.first)
        if letters.isEmpty { return "?" }
        return String(letters).uppercased()
    }

    /// Stable hue per identity. `hashValue` is deliberately avoided — Swift
    /// seeds it per process, so it would give a different colour each launch.
    private var tint: Color {
        var sum: UInt32 = 0
        for byte in name.unicodeScalars { sum = (sum &* 31) &+ byte.value }
        let hue = Double(sum % 360) / 360.0
        return Color(hue: hue, saturation: 0.55, brightness: 0.78)
    }

    var body: some View {
        Group {
            if let imageURL, let url = URL(string: imageURL) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        // Showing initials while loading — and if loading fails
                        // — means the row never collapses to an empty circle.
                        initialsCircle
                    }
                }
            } else {
                initialsCircle
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        // Keeps a pale avatar from dissolving into a pale background.
        .overlay(Circle().strokeBorder(Theme.Palette.separator.opacity(0.5), lineWidth: 0.5))
        .accessibilityHidden(true)
    }

    private var initialsCircle: some View {
        ZStack {
            tint
            Text(initials)
                .font(.system(size: size * 0.38, weight: .semibold))
                .foregroundStyle(.white)
                // Initials are Latin-derived; forcing LTR keeps a mixed-script
                // name from rendering its letters in the wrong order.
                .environment(\.layoutDirection, .leftToRight)
        }
    }
}
