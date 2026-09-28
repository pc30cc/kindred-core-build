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
        /// Something waiting in this tab — unread conversations, for the
        /// Inbox. Any number above zero is shown on the icon (`TabBadge`),
        /// and read out through `badgeLabel`.
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
                    .modifier(TabBadge(count: item.badge))

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

/// The unread count on a tab's icon: a small red capsule with the number in
/// it, the way the system, Telegram, Signal and WhatsApp mark a tab.
///
/// A number rather than a dot, because what an operator wants from the tab
/// bar is "how much is waiting", and a dot answers only "something". It
/// counts conversations, not messages — the unit the inbox is worked in, and
/// the one Slack, Intercom and Zendesk badge — and stops at 99+, past which
/// the exact figure tells nobody anything.
///
/// Geometry for an 18-point glyph: 16 points tall, a circle for one digit and
/// a capsule beyond, 4.5 points either side of the digits in 11-point
/// semibold. It sits beside the icon's trailing top corner — top-right in
/// English, top-left in Persian — overlapping the glyph by only 3 points,
/// with its middle 2 points below the glyph's top. It used to start at the
/// glyph's centre and covered a third of the tray: the badge read, the icon
/// did not. Out at the corner, both do, and it still never touches the label.
///
/// Where it does overlap, the icon is cut away 1.5 points around it: a real
/// hole, punched with `.destinationOut`, rather than a ring painted in the
/// background colour. The bar is a translucent material, and a painted ring
/// showed as a pale halo on it — worst in dark mode.
///
/// Motion is small and only says what changed: the capsule springs in, the
/// digits roll to the new number, and a count that goes up pops once. Reduce
/// Motion turns all of it into a cross-fade.
private struct TabBadge: ViewModifier {
    let count: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.locale) private var locale
    /// Counts up each time the number does, to set off one pop.
    @State private var arrivals = 0

    private let height: CGFloat = 16
    private let cutout: CGFloat = 1.5
    /// How far the capsule reaches in over the glyph's trailing edge.
    private let overlap: CGFloat = 3
    /// How far below the glyph's top the capsule's middle sits.
    private let drop: CGFloat = 2

    private var isShown: Bool { count > 0 }

    /// Persian digits in Persian, through the locale the root sets. The
    /// capped form is "99+" — which a right-to-left line draws as "+۹۹", the
    /// way Persian writes it.
    private var label: String {
        let shown = min(count, 99).formatted(.number.locale(locale).grouping(.never))
        return count > 99 ? shown + "+" : shown
    }

    func body(content: Content) -> some View {
        content
            // The hole, the same shape and place as the capsule and a
            // cut-out wider, taken out of the icon itself.
            .overlay(alignment: .topTrailing) {
                if isShown {
                    anchored(
                        capsule
                            .padding(cutout)
                            .background(Capsule())
                            .blendMode(.destinationOut),
                        reach: overlap + cutout
                    )
                    .transition(appearance)
                }
            }
            .compositingGroup()
            .overlay(alignment: .topTrailing) {
                if isShown {
                    capsule
                        .keyframeAnimator(initialValue: 1.0, trigger: arrivals) { view, scale in
                            view.scaleEffect(scale)
                        } keyframes: { _ in
                            KeyframeTrack {
                                CubicKeyframe(1.12, duration: 0.12)
                                SpringKeyframe(1.0, duration: 0.25, spring: .snappy)
                            }
                        }
                        .modifier(Anchored(reach: overlap, drop: drop))
                        .transition(appearance)
                }
            }
            // Appearing and going: a spring in, a quick fade out.
            .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.7), value: isShown)
            // A new number while it is up: the digits roll.
            .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.25), value: count)
            .onChange(of: count) { old, new in
                // Only a count that was already showing pops; the first one
                // has the spring in.
                guard new > old, old > 0, !reduceMotion else { return }
                arrivals += 1
            }
    }

    /// The hole, placed exactly as the capsule is.
    private func anchored(_ view: some View, reach: CGFloat) -> some View {
        view.modifier(Anchored(reach: reach, drop: drop))
    }

    private var capsule: some View {
        Text(label)
            .font(.app(size: 11, .semibold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .lineLimit(1)
            .fixedSize()
            .contentTransition(reduceMotion ? .opacity : .numericText(value: Double(count)))
            .padding(.horizontal, 4.5)
            .frame(minWidth: height)
            .frame(height: height)
            .background(Capsule().fill(Theme.Palette.danger))
            // The tab says it out loud (`badgeLabel`); the capsule is only
            // what the eye reads.
            .accessibilityHidden(true)
    }

    private var appearance: AnyTransition {
        reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity)
    }
}

/// Puts a badge beside the corner it is overlaid on: its near edge `reach`
/// points in from the corner, its middle `drop` points below it.
///
/// A zero-sized frame pinned to the corner, with the badge hanging off its
/// leading edge — so it grows outward, away from the icon, however many
/// digits it has — and nudged back in by padding. Leading-edge padding and
/// frame alignment both follow the layout direction, so the same code puts
/// it top-right in English and top-left in Persian. (Custom alignment guides
/// were the first way this was written; inside this overlay SwiftUI ignored
/// them and sat the badge on top of the icon.)
private struct Anchored: ViewModifier {
    let reach: CGFloat
    let drop: CGFloat

    func body(content: Content) -> some View {
        content
            .padding(.leading, -reach)
            .padding(.top, drop * 2)
            .frame(width: 0, height: 0, alignment: .leading)
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

    /// Something was put back the way it was — a switch that sprang back
    /// because the save did not land.
    @MainActor
    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
