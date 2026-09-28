import SwiftUI

/// A detached capsule tab bar that floats above the content.
///
/// The system tab bar is hidden and this is drawn in its place. Two things
/// make it read as native rather than as a web widget: it sits on a real
/// `.ultraThinMaterial` so the content scrolling underneath genuinely shows
/// through and blurs, and the selection bubble slides between items with
/// `matchedGeometryEffect` instead of cross-fading, so the eye can follow it.
///
/// Every item is at least `minTouchTarget` tall, and the labels shrink rather
/// than truncate at large Dynamic Type sizes, because a tab bar that clips its
/// own words is worse than one with slightly smaller ones.
struct FloatingTabBar<Tab: Hashable>: View {

    struct Item: Identifiable {
        let tab: Tab
        let title: String
        /// Shown when the tab is not selected.
        let icon: String
        /// The filled counterpart, shown when it is.
        let selectedIcon: String
        /// Something waiting in this tab — unread messages, for the Inbox.
        /// Any number above zero shows a dot; the number itself is for
        /// VoiceOver, through `badgeLabel`.
        var badge: Int = 0
        /// What VoiceOver says of the badge ("3 unread").
        var badgeLabel: String? = nil

        var id: Tab { tab }
    }

    @Binding var selection: Tab
    let items: [Item]

    @Namespace private var bubble
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            ForEach(items) { item in
                button(for: item)
            }
        }
        .padding(.horizontal, Theme.Space.sm)
        .padding(.vertical, Theme.Space.sm)
        .background(
            Capsule(style: .continuous)
                .fill(.ultraThinMaterial)
        )
        .overlay(
            // A hairline keeps the capsule's edge defined against a light
            // background, where the material alone almost disappears.
            Capsule(style: .continuous)
                .strokeBorder(Theme.Palette.separator.opacity(0.35), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.14), radius: 18, x: 0, y: 6)
        .padding(.horizontal, Theme.Space.xl)
        // Measured from the bottom of the screen rather than from the bottom
        // of the safe area, which is why this is usually negative: the bar
        // deliberately sits inside the home-indicator strip, otherwise 34
        // points of nothing under a bar that is supposed to float. It stops
        // just short of the indicator itself, so the system's swipe-up
        // gesture keeps its own room. On a device with a home button there is
        // no strip and the padding is simply the gap.
        .padding(.bottom, Theme.Size.floatingBarBottomGap - ScreenInsets.bottom)
        // `.contain` rather than nothing at all: an identifier on a plain
        // `HStack` names a view that accessibility never publishes, so the bar
        // is unreachable — to a UI test, and to anything else asking the
        // system what is on screen. This makes the row itself an element that
        // holds its buttons, without taking their own labels away.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.tabBar)
    }

    private func button(for item: Item) -> some View {
        let isSelected = item.tab == selection

        return Button {
            guard !isSelected else { return }
            Haptics.selection()
            withAnimation(reduceMotion ? nil : Theme.Motion.tabBubble) {
                selection = item.tab
            }
        } label: {
            VStack(spacing: Theme.Space.xxs) {
                Image(systemName: isSelected ? item.selectedIcon : item.icon)
                    .font(.system(size: 18, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                    .overlay(alignment: .topTrailing) {
                        if item.badge > 0 {
                            TabBadgeDot(count: item.badge)
                                .transition(.scale(scale: 0.2).combined(with: .opacity))
                        }
                    }
                    .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.58), value: item.badge > 0)

                Text(item.title)
                    .font(.app(size: 11, isSelected ? .semibold : .medium))
                    .lineLimit(1)
                    // Long localized labels ("Gelen kutusu") shrink instead of
                    // being cut off mid-word.
                    .minimumScaleFactor(0.75)
            }
            .foregroundStyle(isSelected ? Theme.Palette.brand : Theme.Palette.labelSecondary)
            .frame(maxWidth: .infinity)
            .frame(height: Theme.Size.minTouchTarget + 4)
            .background {
                if isSelected {
                    Capsule(style: .continuous)
                        .fill(Theme.Palette.brand.opacity(0.14))
                        .matchedGeometryEffect(id: "selection", in: bubble)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.title)
        .accessibilityValue(item.badge > 0 ? (item.badgeLabel ?? "") : "")
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }
}

/// The dot on a tab with something unread: a small red disc on the icon's
/// top corner, cut out of the icon by a ring of the background — the way the
/// system marks a tab — and, each time the count goes up, one soft ring going
/// out from it, so a new message is noticed without anything moving for long.
///
/// On the icon's trailing corner — top-right in English, top-left in Persian —
/// where the system puts a tab's badge in each.
private struct TabBadgeDot: View {
    let count: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Counts up each time the number does, to set off one ripple.
    @State private var arrivals = 0

    private let size: CGFloat = 9
    private let cutout: CGFloat = 1.75

    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.Palette.danger, lineWidth: 1.5)
                .frame(width: size, height: size)
                .phaseAnimator([RipplePhase.rest, .start, .end], trigger: arrivals) { ring, phase in
                    ring
                        .scaleEffect(phase == .end ? 2.8 : 1)
                        .opacity(phase == .start ? 0.75 : 0)
                } animation: { phase in
                    phase == .end ? .easeOut(duration: 0.9) : nil
                }

            Circle()
                .fill(Theme.Palette.danger)
                .frame(width: size, height: size)
                .padding(cutout)
                .background(Circle().fill(Color(uiColor: .systemBackground)))
        }
        // Half over the icon's corner and half beyond it. Alignment guides
        // rather than an offset: they are measured from the trailing edge in
        // either direction, so the dot follows the corner in Persian too.
        .alignmentGuide(.trailing) { d in d[.trailing] - size * 0.55 }
        .alignmentGuide(.top) { d in d[.top] + size * 0.3 }
        .accessibilityHidden(true)
        .onChange(of: count) { old, new in
            guard new > old, !reduceMotion else { return }
            arrivals += 1
        }
    }

    private enum RipplePhase { case rest, start, end }
}

/// Thin wrapper so call sites do not each reach for UIKit.
enum Haptics {
    @MainActor
    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }

    @MainActor
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// Something was put back the way it was — a switch that sprang back
    /// because the save did not land.
    @MainActor
    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
