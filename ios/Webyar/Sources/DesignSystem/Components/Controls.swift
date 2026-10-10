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
    /// Sign in and password reset wear the brand's own call to action
    /// (`AuthPalette`); everywhere else the interface's tint.
    var isAuth: Bool = false
    let action: () -> Void

    private var fill: AnyShapeStyle { isAuth ? AuthPalette.action : AnyShapeStyle(Theme.Palette.brand) }
    private var label: Color {
        guard isAuth else { return .white }
        return isEnabled && !isLoading ? AuthPalette.actionLabel : AuthPalette.actionLabelDimmed
    }

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
                        .tint(label)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: Theme.Size.minTouchTarget + 6)
            .foregroundStyle(label)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    // Fading the whole button takes the white label down with
                    // it and leaves the title barely readable. Dimming only
                    // the fill keeps the text at full contrast, so a disabled
                    // button still says plainly what it will do.
                    .fill(fill)
                    .opacity(isEnabled && !isLoading ? 1 : 0.4)
            )
        }
        .disabled(!isEnabled || isLoading)
        .buttonStyle(.plain)
        .animation(Theme.Motion.standard, value: isLoading)
        .animation(Theme.Motion.standard, value: isEnabled)
    }
}

// MARK: - Segmented filter

/// The strip above the inbox list: the queues an operator moves between all
/// day, and Colleagues.
///
/// The items come from the plan and Super Admin, not from `allCases` — a
/// segment that leads to a permanently empty list because the plan excludes
/// it reads as a broken app, not as an upsell.
///
/// A count rides in the segment label when there is one — the queue's, or the
/// unread team messages on Colleagues — because the whole reason to glance at
/// this control is to see where the work is. And a segment holding something
/// nobody has read carries a red dot after its label: Open and Colleagues,
/// from the same counts as the Inbox tab's badge, never the AI queue.
///
/// Drawn here rather than as `Picker(.segmented)`, which it replaced, because
/// a system segment takes a string or a glyph and nothing else — there is no
/// way to put one red dot in one segment. It keeps the system control's
/// look: a grey track, a raised thumb that slides to the selection, equal
/// segments, and the same traits for VoiceOver.
struct FilterPicker: View {
    @Binding var selection: InboxStripItem
    let items: [InboxStripItem]
    let counts: InboxCounts?
    /// Messages from colleagues not read yet.
    var colleaguesUnread: Int = 0
    /// The segments holding something nobody has read, and how many — a dot
    /// on each, and the number for VoiceOver.
    var unread: [InboxStripItem: Int] = [:]
    let language: Language

    @Namespace private var thumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private func label(for item: InboxStripItem) -> String {
        let title: String
        let count: Int?
        switch item {
        case .queue(let filter):
            title = filter.title(language)
            count = counts?.count(for: filter)
        case .colleagues:
            title = Str.colleagues(language)
            count = colleaguesUnread
        }
        guard let count, count > 0 else { return title }
        return "\(title) (\(Format.number(count, language: language)))"
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(items) { item in
                segment(item)
            }
        }
        .padding(2)
        .background(Capsule().fill(Theme.Palette.surfaceElevated))
        .accessibilityElement(children: .contain)
    }

    private func segment(_ item: InboxStripItem) -> some View {
        let isSelected = item == selection
        let unreadCount = unread[item] ?? 0

        return Button {
            guard !isSelected else { return }
            Haptics.selection()
            withAnimation(reduceMotion ? nil : Theme.Motion.tabBubble) {
                selection = item
            }
        } label: {
            HStack(spacing: 5) {
                Text(label(for: item))
                    .font(.app(.footnote, isSelected ? .semibold : .medium))
                    .foregroundStyle(isSelected ? Theme.Palette.label : Theme.Palette.labelSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)

                if unreadCount > 0 {
                    Circle()
                        .fill(Theme.Palette.danger)
                        .frame(width: 7, height: 7)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.3).combined(with: .opacity))
                }
            }
            .padding(.horizontal, Theme.Space.sm)
            .frame(maxWidth: .infinity, minHeight: 30)
            .background {
                if isSelected {
                    Capsule()
                        .fill(Theme.Palette.segmentThumb)
                        .shadow(color: .black.opacity(0.10), radius: 3, x: 0, y: 1)
                        .matchedGeometryEffect(id: "thumb", in: thumb)
                }
            }
            .contentShape(Capsule())
            .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.7), value: unreadCount > 0)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label(for: item))
        .accessibilityValue(
            unreadCount > 0
                ? Str.tabUnread(language).filling("count", with: Format.number(unreadCount, language: language))
                : ""
        )
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
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
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Theme.Palette.labelTertiary)

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

/// One quiet line above content the phone saved earlier, when the server
/// cannot be reached right now.
///
/// Not an error screen: the conversations are still there and still
/// readable, and replacing them with "can't reach the server" would take away
/// the one thing that is useful in a lift. This only says how old they may be.
struct OfflineNotice: View {
    let text: String

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            Image(systemName: "icloud.slash")
                .font(.app(.caption))
            Text(text)
                .font(Theme.Typo.meta)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Theme.Palette.labelSecondary)
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .background(Capsule().fill(Theme.Palette.surfaceElevated))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.offlineNotice)
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
            .padding(.horizontal, Theme.Space.sm)
            .frame(minWidth: 22, minHeight: 20)
            .background(Capsule().fill(Theme.Palette.brand))
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
            .background(Capsule().fill(tint.opacity(0.14)))
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
