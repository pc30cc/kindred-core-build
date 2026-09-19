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

                Text(item.title)
                    .font(.system(size: 11, weight: isSelected ? .semibold : .medium))
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
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }
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
}
