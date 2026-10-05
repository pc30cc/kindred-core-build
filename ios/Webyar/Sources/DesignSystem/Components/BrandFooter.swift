import SwiftUI

/// The brand's two blues, as the launch loader draws them: the deep blue of
/// the icon's lower edge and the cyan of its highlight.
enum BrandPalette {
    static let deep = Color(red: 0.047, green: 0.314, blue: 0.914)
    static let cyan = Color(red: 0.180, green: 0.839, blue: 1.000)
}

/// "WEBYAR AI", small and letter-spaced: the name in the label's quiet grey,
/// the "AI" in the brand's blue.
///
/// The product's signature on the screens that come before the app proper —
/// the launch screen, sign in and password reset. Placed with `brandFooter()`
/// rather than by hand, so that it is in the same spot on all three.
///
/// Latin in every language — it is the mark, not prose — so it is pinned
/// left-to-right; a right-to-left layout would set it as "AI WEBYAR".
struct BrandFooter: View {
    /// How far up from the bottom of the safe area the footer reaches: its
    /// line and the gap under it. A scrolling screen that carries it ends its
    /// content with at least this much room, so the last control never comes
    /// to rest under the name.
    static let clearance: CGFloat = Theme.Space.xl + Theme.Space.lg

    private let tracking: CGFloat = 3

    var body: some View {
        HStack(spacing: tracking * 1.6) {
            Text(Str.brandWordmark)
                .foregroundStyle(Theme.Palette.labelSecondary)
            Text(verbatim: "AI")
                .foregroundStyle(
                    LinearGradient(
                        colors: [BrandPalette.deep, BrandPalette.cyan],
                        startPoint: .leading, endPoint: .trailing
                    )
                )
        }
        .font(.system(size: 12, weight: .semibold, design: .rounded))
        .tracking(tracking)
        // Tracking adds its space after the last letter too, which would sit
        // the centred name half a letter to the left.
        .padding(.leading, tracking)
        .environment(\.layoutDirection, .leftToRight)
        // Read as the one name it is, not as two words VoiceOver stops on.
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.brandFooter)
    }
}

extension View {
    /// Signs the screen with `BrandFooter`: centred, `Theme.Space.xl` above
    /// the bottom of the safe area.
    ///
    /// One modifier rather than each screen placing it, because the point is
    /// that it does not move. The app opens on the launch screen, fades into
    /// sign in and pushes password reset from there, and the name stays
    /// exactly where it was through all three.
    ///
    /// Fixed to the screen rather than carried by its content, and under the
    /// keyboard rather than riding up on it: it is a signature, not part of
    /// the form, and a name floating over the keyboard is one more thing
    /// between the operator and the field they are typing in. It takes no
    /// touches, so nothing that scrolls beneath it is ever out of reach.
    func brandFooter() -> some View {
        overlay {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                BrandFooter()
                    .padding(.bottom, Theme.Space.xl)
            }
            .frame(maxWidth: .infinity)
            .allowsHitTesting(false)
            .ignoresSafeArea(.keyboard, edges: .bottom)
        }
    }
}
