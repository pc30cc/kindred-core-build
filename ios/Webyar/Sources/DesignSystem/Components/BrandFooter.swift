import SwiftUI

/// The brand's own colours, as its art draws them: the launch loader (and the
/// `LaunchLoader` launch image drawn from it), the "AI" of the footer and the
/// tile behind `BrandMark`. Each from its brand kit.
///
/// Not the interface's tint. That is `Theme.Palette.brand`, mirrored in the
/// asset catalog's AccentColor, and it is the same blue in both apps — the
/// Mac's RESPOK target made the same call: buttons and links are the UI's
/// theme, the icon, mark and loader are the brand's.
enum BrandPalette {
    #if BRAND_RESPOK
    // RESPOK brand kit, Thread / Signal: Signal #FF5A3C, Signal Deep #D3361A,
    // Ink #16142B.

    /// Signal Deep: where the loader's comet comes from.
    static let deep = Color(red: 0.827, green: 0.212, blue: 0.102)
    /// Signal: the comet's head and its bead.
    static let bright = Color(red: 1.000, green: 0.353, blue: 0.235)
    /// The loader's other colour, its inner arc: Ink on a light screen and white
    /// on a dark one — the symbol's own "color" and "reversed" colourways.
    static let second = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? .white
            : UIColor(red: 0.086, green: 0.078, blue: 0.169, alpha: 1)
    })
    /// The faint ring the comet runs on (drawn at 10%).
    static let track = second
    /// The tile behind the mark: flat Signal, as the app icon.
    static let tile = LinearGradient(colors: [bright, bright], startPoint: .top, endPoint: .bottom)
    /// The mark's box inside the tile, as a share of the tile: where the app
    /// icon puts the symbol (573 × 507 of 1024).
    static let markScale = CGSize(width: 0.560, height: 0.495)
    #else
    // WebYar brand kit: turquoise #16C7A8, deep turquoise #0B7D6C, and the app
    // icon's gradient #2EDFC0 → #14BFA2 → #0B8A78.

    /// Deep turquoise: where the loader's comet comes from.
    static let deep = Color(red: 0.043, green: 0.490, blue: 0.424)
    /// The icon's light turquoise: the comet's head and its bead.
    static let bright = Color(red: 0.180, green: 0.875, blue: 0.753)
    /// The loader's inner arc.
    static let second = bright
    /// The faint ring the comet runs on (drawn at 10%): the kit's turquoise.
    static let track = Color(red: 0.086, green: 0.780, blue: 0.659)
    /// The tile behind the mark: the app icon's own gradient, at its 150°.
    static let tile = LinearGradient(
        stops: [
            .init(color: Color(red: 0.180, green: 0.875, blue: 0.753), location: 0),
            .init(color: Color(red: 0.078, green: 0.749, blue: 0.635), location: 0.48),
            .init(color: Color(red: 0.043, green: 0.541, blue: 0.471), location: 1),
        ],
        startPoint: UnitPoint(x: 0.158, y: -0.092),
        endPoint: UnitPoint(x: 0.842, y: 1.092)
    )
    /// The mark's box inside the tile, as a share of the tile: where the app
    /// icon puts the symbol (397 × 524 of 1024), plus the PDF's own hairline margin.
    static let markScale = CGSize(width: 0.398, height: 0.523)
    #endif
}

/// The product's signature, small and letter-spaced: "WEBYAR AI" — the name
/// in the label's quiet grey, the "AI" in the brand's turquoise — and for
/// RESPOK its name alone (`AppBrand.wordmark`, `AppBrand.wordmarkSuffix`).
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
            Text(verbatim: BrandStr.brandWordmark)
                .foregroundStyle(Theme.Palette.labelSecondary)
            if let suffix = AppBrand.wordmarkSuffix {
                Text(verbatim: suffix)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [BrandPalette.deep, BrandPalette.bright],
                            startPoint: .leading, endPoint: .trailing
                        )
                    )
            }
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
