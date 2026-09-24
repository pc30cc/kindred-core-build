import SwiftUI

// MARK: - Primary button

/// The one prominent action on a screen.
///
/// It is full width, `minTouchTarget` tall, and swaps its label for a spinner
/// while busy *without changing size* — a button that shrinks under the
/// thumb mid-tap is how a mis-tap happens.
struct PrimaryButton: View {
    let title: String
    var isLoading: Bool = false
    var isEnabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                // Keeps the intrinsic width while the spinner shows.
                Text(title)
                    .font(Theme.Typo.button)
                    .opacity(isLoading ? 0 : 1)

                if isLoading {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(.white)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: Theme.Size.minTouchTarget + 6)
            .foregroundStyle(.white)
            .background {
                let shape = RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                // A gradient rather than a flat fill, and only here: the one
                // committing action on a screen is the only thing in this app
                // allowed to carry the brand as a surface.
                shape.fill(Theme.Gradient.brand)
                    // Fading the whole button takes the white label down with
                    // it and leaves the title barely readable. Dimming only
                    // the fill keeps the text at full contrast, so a disabled
                    // button still says plainly what it will do.
                    .opacity(isEnabled && !isLoading ? 1 : 0.4)
                    .overlay {
                        // The lit top edge every raised iOS surface has. It
                        // is what stops a filled rectangle reading as a flat
                        // coloured box.
                        shape.strokeBorder(
                            LinearGradient(
                                colors: [.white.opacity(0.34), .white.opacity(0.04)],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.75
                        )
                    }
                    .elevated(isEnabled && !isLoading ? .raised : .resting)
            }
        }
        .disabled(!isEnabled || isLoading)
        .buttonStyle(PressableButtonStyle())
        .animation(Theme.Motion.standard, value: isLoading)
        .animation(Theme.Motion.standard, value: isEnabled)
    }
}

// MARK: - Segmented filter

/// The inbox queue filter.
///
/// `Picker(.segmented)` is the native control and already handles RTL, Dynamic
/// Type and the selection animation, so it is used rather than reimplemented.
/// The queues come from the plan, not from `allCases` — a segment that leads
/// to a permanently empty list because the plan excludes it reads as a broken
/// app, not as an upsell.
///
/// A count rides in the segment label when there is one, because the whole
/// reason to glance at this control is to see where the work is.
struct FilterPicker: View {

    /// A chip that leaves this screen rather than narrowing it.
    ///
    /// The strip is a filter control and these are not filters, so they are
    /// kept apart rather than mixed into `filters`: they sit after a divider,
    /// they carry an icon, and nothing can ever draw one as selected. An
    /// operator who taps one and comes back finds the queue they left still
    /// chosen, because it never stopped being chosen.
    struct Destination: Identifiable {
        let id: String
        let title: String
        /// SF Symbol, and the same one the title menu uses for this place.
        let icon: String
        let open: () -> Void
    }

    @Binding var selection: InboxFilter
    let filters: [InboxFilter]
    let counts: InboxCounts?
    let language: Language
    /// The inboxes that are their own screens. Empty unless the plan grants
    /// one, which is why this defaults rather than being passed everywhere.
    var destinations: [Destination] = []

    private func label(for filter: InboxFilter) -> String {
        let title = filter.chipTitle(language)
        guard let count = counts?.count(for: filter), count > 0 else { return title }
        return "\(title) (\(Format.number(count, language: language)))"
    }

    @Namespace private var chip
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // Chips rather than a segmented control.
        //
        // `Picker(.segmented)` divides the width it is given equally, which
        // is fine for two short words and wrong for what this screen
        // actually shows: five queue names in Turkish, each with a count
        // riding in the label. Everything shrank to fit the longest one and
        // the counts -- the reason to glance at the control at all -- came
        // out at eight points. A scrolling row gives every chip the width of
        // its own words and the queue with forty waiting conversations can
        // say so.
        ScrollView(.horizontal) {
            LiquidGlassGroup(spacing: Theme.Space.lg) {
                HStack(spacing: Theme.Space.sm) {
                    ForEach(filters) { filter in
                        chipButton(for: filter)
                    }

                    if !destinations.isEmpty {
                        // A hairline, not a gap. The two groups are different
                        // kinds of thing — one narrows the list, one leaves
                        // it — and a little more space would only read as a
                        // layout accident.
                        Rectangle()
                            .fill(Theme.Palette.separator.opacity(0.7))
                            .frame(width: 0.5, height: 20)
                            .padding(.horizontal, Theme.Space.xxs)
                            .accessibilityHidden(true)

                        ForEach(destinations) { destination in
                            destinationButton(for: destination)
                        }
                    }
                }
                // Room for the glass edge and its shadow, which would
                // otherwise be shaved off by the scroll view's bounds.
                .padding(.vertical, Theme.Space.xs)
                .padding(.horizontal, Theme.Space.xxs)
            }
        }
        .scrollIndicators(.hidden)
        // The shadow under a chip belongs outside the scroll view's clip.
        .scrollClipDisabled()
        .accessibilityElement(children: .contain)
    }

    private func chipButton(for filter: InboxFilter) -> some View {
        let isSelected = filter == selection
        let count = counts?.count(for: filter) ?? 0

        return Button {
            guard !isSelected else { return }
            Haptics.selection()
            withAnimation(reduceMotion ? nil : Theme.Motion.morph) {
                selection = filter
            }
        } label: {
            HStack(spacing: Theme.Space.xs) {
                Text(filter.chipTitle(language))
                    .font(.app(.subheadline, weight: isSelected ? .semibold : .medium))
                    .lineLimit(1)

                if count > 0 {
                    Text(Format.number(count, language: language))
                        .font(Theme.Typo.metaEmphasis)
                        .monospacedDigit()
                        // The count changes under the operator's eyes as
                        // conversations arrive; rolling the digits says that
                        // plainly where a cross-fade just flickers.
                        .contentTransition(.numericText())
                        .padding(.horizontal, Theme.Space.xs)
                        .frame(minWidth: 20, minHeight: 19)
                        .background(
                            Capsule().fill(
                                isSelected
                                    ? Color.white.opacity(0.22)
                                    : Theme.Palette.brand.opacity(0.13)
                            )
                        )
                }
            }
            .foregroundStyle(isSelected ? Color.white : Theme.Palette.label)
            .padding(.horizontal, Theme.Space.sm + Theme.Space.xs)
            .frame(height: 36)
            .background {
                if isSelected {
                    Capsule(style: .continuous)
                        .fill(Theme.Gradient.brand)
                        .elevated(.resting)
                        .matchedGeometryEffect(id: "chip", in: chip)
                } else {
                    // A real surface, not glass.
                    //
                    // Glass is for chrome that content moves beneath -- the
                    // tab bar, a toolbar, the composer. These chips are a
                    // row *inside* the list, sitting still on an opaque page;
                    // a lens over an opaque page has nothing to refract and
                    // renders as a pale smear that its own label cannot be
                    // read on. White with a hairline is what an inline
                    // control on iOS actually looks like.
                    Capsule(style: .continuous)
                        .fill(Theme.Palette.surface)
                        .overlay(
                            Capsule(style: .continuous)
                                .strokeBorder(Theme.Palette.separator.opacity(0.7), lineWidth: 0.5)
                        )
                        .elevated(.resting)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel(label(for: filter))
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }

    /// The same capsule as an unselected queue, with its icon in front of it.
    ///
    /// Deliberately never the selected treatment: this chip opens a screen
    /// and comes straight back off it, and a chip that lit up and then went
    /// out again as the operator returned would read as the tap having been
    /// undone.
    private func destinationButton(for destination: Destination) -> some View {
        Button {
            Haptics.selection()
            destination.open()
        } label: {
            HStack(spacing: Theme.Space.xs) {
                Image(systemName: destination.icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Palette.brand)

                Text(destination.title)
                    .font(.app(.subheadline, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(Theme.Palette.label)
            .padding(.horizontal, Theme.Space.sm + Theme.Space.xs)
            .frame(height: 36)
            .background {
                Capsule(style: .continuous)
                    .fill(Theme.Palette.surface)
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(Theme.Palette.separator.opacity(0.7), lineWidth: 0.5)
                    )
                    .elevated(.resting)
            }
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel(destination.title)
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Press feedback

/// A tap that the thumb can feel.
///
/// `.plain` leaves a custom-drawn button completely inert under the finger,
/// which on iOS reads as a tap that did not land -- the reason people tap a
/// second time. Every hand-drawn control in this app uses this instead, so
/// they all answer the same way.
struct PressableButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.72), value: configuration.isPressed)
    }
}

// MARK: - States

/// Shown when a list legitimately has nothing in it.
///
/// Centred as a block, with the icon, title and body on one vertical axis and
/// the body text centre-aligned and width-limited so it never runs edge to
/// edge.
struct EmptyStateView: View {
    let systemImage: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: Theme.Space.md) {
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Theme.Palette.brand)
                .symbolRenderingMode(.hierarchical)
                .frame(width: 76, height: 76)
                // The glyph sits on its own disc rather than floating loose
                // in the middle of the screen. An empty state is still a
                // composed screen, not an absence of one.
                .liquidGlass(.card, in: Circle())

            VStack(spacing: Theme.Space.xs) {
                Text(title)
                    .font(.app(.headline))
                    .foregroundStyle(Theme.Palette.label)

                Text(message)
                    .font(.app(.subheadline))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .multilineTextAlignment(.center)
                    // A measure this wide stays comfortable to read; full-width
                    // centred text does not.
                    .frame(maxWidth: 280)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Theme.screenInset)
        .padding(.vertical, Theme.Space.huge)
    }
}

/// Shown when a request failed and retrying is the sensible next step.
struct ErrorStateView: View {
    let title: String
    let message: String
    let retryTitle: String
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: Theme.Space.md) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Theme.Palette.warning)

            VStack(spacing: Theme.Space.xs) {
                Text(title)
                    .font(.app(.headline))
                Text(message)
                    .font(.app(.subheadline))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }

            Button(action: onRetry) {
                Text(retryTitle)
                    .font(Theme.Typo.button)
                    .padding(.horizontal, Theme.Space.xl)
                    .frame(height: Theme.Size.minTouchTarget)
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .padding(.top, Theme.Space.xs)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Theme.screenInset)
        .padding(.vertical, Theme.Space.huge)
    }
}

// MARK: - Badges

/// The unread counter on an inbox row.
struct UnreadBadge: View {
    let count: Int
    @Environment(\.locale) private var locale

    var body: some View {
        // Formatted rather than interpolated. A ternary between two string
        // literals settles on `String`, which is the overload of `Text` that
        // does *not* localize — so the capped form would have shipped as an
        // ASCII "99+" beside Persian digits on the row above it.
        Text(count > 99 ? "\(Format.number(99, locale: locale))+" : Format.number(count, locale: locale))
            .font(Theme.Typo.metaEmphasis)
            .monospacedDigit()
            .foregroundStyle(.white)
            .contentTransition(.numericText())
            .padding(.horizontal, Theme.Space.sm)
            .frame(minWidth: 22, minHeight: 20)
            .background(Capsule().fill(Theme.Gradient.brand).elevated(.resting))
            // A conversation just arrived in a queue the operator is looking
            // at. The digits already roll; this is the badge itself noticing.
            .jumpsOnChange(count)
            // The digits themselves localize with the reader's language; this
            // only stops the capped form rendering as "+99" under RTL.
            .environment(\.layoutDirection, .leftToRight)
    }
}

/// A small status pill — "resolved", "AI", and similar.
struct StatusPill: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(Theme.Typo.meta)
            .foregroundStyle(tint)
            .padding(.horizontal, Theme.Space.sm)
            .padding(.vertical, Theme.Space.xxs)
            .background {
                Capsule().fill(tint.opacity(0.13))
                    // A hairline of the same colour keeps the pill legible
                    // where the fill alone is nearly the page behind it.
                    .overlay(Capsule().strokeBorder(tint.opacity(0.22), lineWidth: 0.5))
            }
    }
}


/// Forces left-to-right on a run of text that is Latin whatever the interface
/// language is — an address, a phone number, a version string.
///
/// Reading `operator@webyar.app` right-to-left puts the domain first, which is
/// wrong in Persian and Turkish just as it would be in English.
struct LatinIfNeeded: ViewModifier {
    let isLatin: Bool

    func body(content: Content) -> some View {
        if isLatin {
            content.environment(\.layoutDirection, .leftToRight)
        } else {
            content
        }
    }
}

extension View {
    func latin(_ isLatin: Bool = true) -> some View {
        modifier(LatinIfNeeded(isLatin: isLatin))
    }
}

/// A centred, quiet line inside a list — "nothing here yet", said without
/// making a scene of it.
///
/// Not an `EmptyStateView`: that one owns a whole screen with an icon and a
/// title. This is one row saying one section is empty while the rest of the
/// list carries on around it.
struct QuietRow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.app(.subheadline))
            .foregroundStyle(Theme.Palette.labelSecondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, Theme.Space.sm)
            .listRowSeparator(.hidden)
    }
}
