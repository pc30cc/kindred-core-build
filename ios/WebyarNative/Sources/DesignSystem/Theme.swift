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

        /// The raised thumb of a segmented control — white on the grey track
        /// in light mode, a lighter grey in dark, as the system draws it.
        static let segmentThumb = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.388, green: 0.388, blue: 0.400, alpha: 1)
                : .white
        })

        /// The skeleton's ground: what stands where a picture or a face will
        /// be. Opaque, unlike `surfaceElevated`, so a face's silhouette reads
        /// the same on a white row, a grey sheet and a chat bubble.
        static let skeletonBase = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.165, green: 0.176, blue: 0.204, alpha: 1)
                : UIColor(red: 0.914, green: 0.925, blue: 0.945, alpha: 1)
        })
        /// The figure drawn on the skeleton's ground — a silhouette's head
        /// and shoulders. One step off the ground, never a contrast.
        static let skeletonFigure = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.259, green: 0.275, blue: 0.314, alpha: 1)
                : UIColor(red: 0.812, green: 0.831, blue: 0.867, alpha: 1)
        })
        /// The band of light that crosses a skeleton while it loads.
        static let skeletonShine = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(white: 1, alpha: 0.08)
                : UIColor(white: 1, alpha: 0.6)
        })

        static let label = Color(uiColor: .label)
        static let labelSecondary = Color(uiColor: .secondaryLabel)
        static let labelTertiary = Color(uiColor: .tertiaryLabel)

        static let separator = Color(uiColor: .separator)

        /// The AI's own colour — the Mac app's `Palette.ai` — so what is the
        /// AI's (its composer's voice picker and send button) is told apart
        /// from the operator's blue at a glance.
        static let ai = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.647, green: 0.522, blue: 0.941, alpha: 1)   // #A585F0
                : UIColor(red: 0.486, green: 0.302, blue: 0.859, alpha: 1)   // #7C4DDB
        })
        /// `ai` as a soft fill behind its own ink — the Mac's `aiSoft`.
        static let aiSoft = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.647, green: 0.522, blue: 0.941, alpha: 0.16)
                : UIColor(red: 0.486, green: 0.302, blue: 0.859, alpha: 0.12)
        })

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

    // MARK: - Typography
    //
    // Text styles, never fixed point sizes, so every label grows with the
    // reader's Dynamic Type setting — and through `Font.app`, so Persian is
    // set in IRANSans (see `Typeface`). Computed rather than stored: the
    // answer depends on the language, which can change while the app runs.

    enum Typo {
        /// Screen hero title (login).
        static var hero: Font { .app(.largeTitle, .bold) }
        /// A row's primary line — a contact name, a conversation subject.
        static var rowTitle: Font { .app(.body, .semibold) }
        /// A row's supporting line — the message preview.
        static var rowSubtitle: Font { .app(.subheadline) }
        /// Timestamps, counters, channel badges.
        static var meta: Font { .app(.caption) }
        static var metaEmphasis: Font { .app(.caption, .semibold) }
        /// Button labels.
        static var button: Font { .app(.body, .semibold) }
        /// Chat message text.
        static var message: Font { .app(.body) }
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
    }
}
