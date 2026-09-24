import SwiftUI

/// The single source of truth for spacing, radius and colour.
///
/// Every screen pulls its numbers from here. That is what keeps a title on one
/// screen aligned with a title on the next one, and it is why nothing in this
/// app hard-codes a padding value.
enum Theme {

    // MARK: - Spacing

    /// A 4-point rhythm. Layout code picks a step, never an arbitrary number,
    /// so vertical gaps stay in proportion as text scales.
    enum Space {
        /// 2 — hairline separation inside a single control.
        static let xxs: CGFloat = 2
        /// 4 — between a label and the value directly under it.
        static let xs: CGFloat = 4
        /// 8 — between tightly related elements in a row.
        static let sm: CGFloat = 8
        /// 12 — between rows in a stack.
        static let md: CGFloat = 12
        /// 16 — the standard iOS reading margin; the default screen inset.
        static let lg: CGFloat = 16
        /// 20 — between a section and the next one.
        static let xl: CGFloat = 20
        /// 28 — around a focal element such as a form's submit button.
        static let xxl: CGFloat = 28
        /// 40 — top of a hero/branding block.
        static let huge: CGFloat = 40
    }

    /// The horizontal inset every full-width screen uses. Matching this to the
    /// system's own 16pt margin is what makes custom screens line up with
    /// `List` rows and navigation titles.
    static let screenInset: CGFloat = Space.lg

    // MARK: - Radius

    enum Radius {
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        /// Matches the corner of a grouped `List` section.
        static let lg: CGFloat = 16
        static let xl: CGFloat = 22
        /// Fully rounded — pills, avatars, the composer field.
        static let pill: CGFloat = 999
    }

    // MARK: - Sizing

    enum Size {
        /// Apple's minimum comfortable hit target. Every tappable control in
        /// this app is at least this tall.
        static let minTouchTarget: CGFloat = 44
        static let avatarSmall: CGFloat = 32
        static let avatarMedium: CGFloat = 44
        static let avatarLarge: CGFloat = 76
        static let rowMinHeight: CGFloat = 60
        /// The floating tab bar's own height: one item plus the capsule's
        /// padding above and below it.
        static let floatingBarHeight: CGFloat = minTouchTarget + 4 + Space.sm * 2

        /// How far the bar's bottom edge sits from the bottom of the screen —
        /// not from the safe area, which it deliberately reaches into.
        ///
        /// The home indicator is a 5-point bar about 8 points up from the
        /// edge, so this is as low as the capsule can go and still leave the
        /// indicator its own room.
        static let floatingBarBottomGap: CGFloat = 16

        /// Room a scrolling screen leaves at the bottom so its last row can
        /// clear the floating bar, measured from the safe area the way
        /// `safeAreaInset` wants it.
        ///
        /// The bar is positioned against the screen, so how much of it hangs
        /// below the safe area depends on the device — hence the subtraction
        /// rather than a constant.
        @MainActor
        static var floatingBarClearance: CGFloat {
            max(0, floatingBarHeight + floatingBarBottomGap + Space.xs - ScreenInsets.bottom)
        }
    }

    // MARK: - Colour
    //
    // Semantic system colours are used wherever one exists: they already
    // adapt to dark mode, increased contrast and accessibility settings, and
    // they keep the app looking like the rest of iOS. Only the brand tint and
    // a couple of chat-specific surfaces are defined by hand.

    enum Palette {
        /// Brand tint, defined explicitly rather than as `Color.accentColor`.
        ///
        /// `accentColor` is *state-dependent*: inside a disabled control
        /// SwiftUI resolves it to the system's grey disabled tint. A disabled
        /// primary button would therefore turn grey rather than stay a muted
        /// brand blue, which reads as broken instead of as "not yet". The same
        /// values are mirrored in the asset catalog's `AccentColor` so system
        /// controls still pick the brand up on their own.
        static let brand = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.353, green: 0.580, blue: 1.000, alpha: 1)
                : UIColor(red: 0.231, green: 0.478, blue: 0.949, alpha: 1)
        })

        /// Page background behind grouped content.
        static let background = Color(uiColor: .systemGroupedBackground)
        /// A card or row sitting on `background`.
        static let surface = Color(uiColor: .secondarySystemGroupedBackground)
        /// A control resting on `surface` — a search field, a segmented track.
        static let surfaceElevated = Color(uiColor: .tertiarySystemFill)

        static let label = Color(uiColor: .label)
        static let labelSecondary = Color(uiColor: .secondaryLabel)
        static let labelTertiary = Color(uiColor: .tertiaryLabel)

        static let separator = Color(uiColor: .separator)

        static let danger = Color(uiColor: .systemRed)
        static let success = Color(uiColor: .systemGreen)
        static let warning = Color(uiColor: .systemOrange)

        /// Outgoing chat bubble — the brand tint carries it.
        static let bubbleOutgoing = brand
        static let bubbleOutgoingText = Color.white
        /// Incoming chat bubble.
        ///
        /// This has to be the *grouped* secondary surface, not
        /// `.secondarySystemBackground`: in light mode the latter is the same
        /// #F2F2F7 as the transcript's own `systemGroupedBackground`, so every
        /// incoming bubble rendered invisibly against the page. The grouped
        /// variant is white on light and #1C1C1E on dark, which reads against
        /// the transcript in both themes.
        static let bubbleIncoming = Color(uiColor: .secondarySystemGroupedBackground)
        static let bubbleIncomingText = Color(uiColor: .label)
    }


    // MARK: - Elevation
    //
    // How far off the page a surface sits. Three steps, because a fourth
    // would be a shadow nobody can tell from the one above it.
    //
    // The values are deliberately soft and low-opacity: iOS shadows describe
    // height, they do not draw outlines. A shadow dark enough to see on its
    // own is a shadow that will look like dirt on an OLED screen.

    enum Elevation {
        /// Flat on the page. A row, a chip — something with an edge but no lift.
        case resting
        /// Lifted: a card, a grouped section.
        case raised
        /// Floating over content that scrolls beneath it: the tab bar, a
        /// header, a composer.
        case floating

        var radius: CGFloat {
            switch self {
            case .resting: return 4
            case .raised: return 12
            case .floating: return 20
            }
        }

        var y: CGFloat {
            switch self {
            case .resting: return 1
            case .raised: return 4
            case .floating: return 8
            }
        }

        var opacity: Double {
            switch self {
            case .resting: return 0.06
            case .raised: return 0.10
            case .floating: return 0.16
            }
        }
    }

    // MARK: - Gradients

    enum Gradient {
        /// The brand, given depth. Used on the one primary action of a
        /// screen and on the outgoing chat bubble — nowhere else, because a
        /// gradient on everything is a gradient on nothing.
        @MainActor
        static let brand = LinearGradient(
            colors: [
                Palette.brand,
                Color(uiColor: UIColor { traits in
                    traits.userInterfaceStyle == .dark
                        ? UIColor(red: 0.243, green: 0.451, blue: 0.898, alpha: 1)
                        : UIColor(red: 0.176, green: 0.373, blue: 0.851, alpha: 1)
                }),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )

        /// The page behind everything: the system's grouped background with
        /// the faintest wash of brand at the top, so glass laid over it has
        /// something to refract rather than a flat grey.
        @MainActor
        static let canvas = LinearGradient(
            colors: [
                Palette.brand.opacity(0.07),
                Palette.brand.opacity(0.0),
            ],
            startPoint: .top,
            endPoint: .center
        )
    }

    // MARK: - Typography
    //
    // Text styles are system styles, never fixed point sizes, so every label
    // grows with the reader's Dynamic Type setting.

    enum Typo {
        /// Screen hero title (login).
        static let hero = Font.system(.largeTitle, design: .default, weight: .bold)
        /// A row's primary line — a contact name, a conversation subject.
        static let rowTitle = Font.system(.body, weight: .semibold)
        /// A row's supporting line — the message preview.
        static let rowSubtitle = Font.system(.subheadline)
        /// Timestamps, counters, channel badges.
        static let meta = Font.system(.caption)
        static let metaEmphasis = Font.system(.caption, weight: .semibold)
        /// Button labels.
        static let button = Font.system(.body, weight: .semibold)
        /// Chat message text.
        static let message = Font.system(.body)
    }

    // MARK: - Motion

    enum Motion {
        /// The standard transition for content appearing or changing.
        static let standard = Animation.easeOut(duration: 0.22)
        /// Springy, for a message arriving in the chat transcript.
        static let bubble = Animation.spring(response: 0.34, dampingFraction: 0.82)
        /// The tab bar's selection bubble. Tighter and less bouncy than a
        /// message: it travels a short distance and should feel crisp, not
        /// wobbly.
        static let tabBubble = Animation.spring(response: 0.28, dampingFraction: 0.86)

        /// Glass settling. Slower and softer than `bubble`: a lens that has
        /// mass moves differently from a message that pops in, and Apple's
        /// own glass transitions land around here.
        static let glass = Animation.spring(response: 0.42, dampingFraction: 0.78)

        /// Two pieces of glass merging or pulling apart. Short, because the
        /// shape is doing the talking and a slow morph reads as lag.
        static let morph = Animation.spring(response: 0.32, dampingFraction: 0.84)
    }
}

/// Lift a surface off the page by a named amount.
///
/// A modifier rather than a raw `.shadow(...)` at each call site, so that
/// "this is a card" and "this floats over the content" stay two decisions
/// with two answers, instead of sixty hand-tuned radii.
extension View {
    func elevated(_ level: Theme.Elevation) -> some View {
        shadow(
            color: .black.opacity(level.opacity),
            radius: level.radius,
            x: 0,
            y: level.y
        )
    }
}
