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
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    // Fading the whole button takes the white label down with
                    // it and leaves the title barely readable. Dimming only
                    // the fill keeps the text at full contrast, so a disabled
                    // button still says plainly what it will do.
                    .fill(Theme.Palette.brand.opacity(isEnabled && !isLoading ? 1 : 0.4))
            )
        }
        .disabled(!isEnabled || isLoading)
        .buttonStyle(.plain)
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
    @Binding var selection: InboxFilter
    let filters: [InboxFilter]
    let counts: InboxCounts?
    let language: Language

    private func label(for filter: InboxFilter) -> String {
        let title = filter.title(language)
        guard let count = counts?.count(for: filter), count > 0 else { return title }
        return "\(title) (\(count))"
    }

    var body: some View {
        Picker("", selection: $selection) {
            ForEach(filters) { filter in
                Text(label(for: filter)).tag(filter)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
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
                    .font(.headline)
                    .foregroundStyle(Theme.Palette.label)

                Text(message)
                    .font(.subheadline)
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
                    .font(.headline)
                Text(message)
                    .font(.subheadline)
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

    var body: some View {
        // Both branches go through Text's localized interpolation, so a
        // Persian reader sees Persian digits in the capped form too rather
        // than "۳" on one row and an ASCII "99+" on the next.
        Text(count > 99 ? "99+" : "\(count)")
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
