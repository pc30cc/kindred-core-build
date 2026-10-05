import SwiftUI
import Observation
import UIKit

/// A scrolling transcript that stays pinned to its newest row.
///
/// Scrolling once when the rows first render is not enough. A photo, a file
/// card or a voice note finishes loading AFTER that scroll and grows the
/// content under it, which leaves the newest message below the fold — open a
/// thread that ends in a picture and you land on the message before it. This
/// is the same problem `useStickToBottom` solves in the console and the
/// `ResizeObserver` solves in the PWA, and it is solved the same way: watch
/// the content's height and re-pin whenever it grows.
///
/// Two behaviours, deliberately different:
///   - Opening a conversation jumps. A smooth scroll through a thousand
///     messages is a long, useless animation.
///   - A message arriving while you are already at the bottom glides. One
///     arriving while you are reading history does not: being yanked away
///     mid-sentence is worse than missing a scroll.
struct PinnedScrollView<Content: View>: View {

    /// Changing this is "a different conversation opened" — jump.
    let conversationKey: String
    /// Changing this is "the messages changed" — glide, if we were pinned.
    let revision: Int
    /// Treated as "at the bottom" within this many points.
    var threshold: CGFloat = 80
    /// Changing this is "the operator sent something" — follow it down,
    /// wherever they were reading, and keep following while it lays out.
    var follow: Int = 0
    @ViewBuilder var content: Content

    @State private var metrics = ScrollMetrics()
    @State private var viewport: CGFloat = 0
    @State private var lastHeight: CGFloat = 0
    /// While this is in the future, every growth re-pins without asking where
    /// the reader is — the first second of a thread is all layout settling,
    /// and the numbers are not trustworthy yet.
    @State private var settleUntil = Date.distantPast

    private static var anchorID: String { "transcript.bottom" }
    private static var space: String { "transcript.space" }

    var body: some View {
        GeometryReader { outer in
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        content

                        // What everything scrolls to. Outside the caller's
                        // own stack so it exists whether or not the last row
                        // has been realised yet.
                        Color.clear
                            .frame(height: 1)
                            .id(Self.anchorID)
                    }
                    .modifier(LegacyGeometryProbe(space: Self.space))
                }
                .coordinateSpace(name: Self.space)
                .modifier(TranscriptGeometryReader(metrics: metrics))
                .onChange(of: metrics.height) { _, height in
                    defer { lastHeight = height }
                    guard height > lastHeight + 0.5 else { return }
                    // Grew under us. Follow it while the reader is at the
                    // bottom, and unconditionally while the thread is still
                    // settling into place.
                    guard Date.now < settleUntil || isNearBottom else { return }
                    proxy.scrollTo(Self.anchorID, anchor: .bottom)
                }
                .onChange(of: revision) {
                    guard isNearBottom else { return }
                    // A new row's photo or file card lays out a beat after the
                    // row does; keep the bottom while it grows.
                    settleUntil = max(settleUntil, .now + 1)
                    withAnimation(Theme.Motion.bubble) {
                        proxy.scrollTo(Self.anchorID, anchor: .bottom)
                    }
                }
                .onChange(of: follow) {
                    settleUntil = .now + 1.5
                    // A turn of the run loop first, so the bottom aimed at is
                    // the one with the new message in it.
                    Task { @MainActor in
                        await Task.yield()
                        withAnimation(Theme.Motion.bubble) {
                            proxy.scrollTo(Self.anchorID, anchor: .bottom)
                        }
                    }
                }
                .onChange(of: conversationKey) {
                    open(proxy)
                }
                .onAppear {
                    viewport = outer.size.height
                    open(proxy)
                }
                .onChange(of: outer.size.height) { previous, height in
                    viewport = height
                    // A real change of size — a rotation, or Split View. The
                    // keyboard is NOT one of these; see below.
                    guard height < previous, isNearBottom else { return }
                    proxy.scrollTo(Self.anchorID, anchor: .bottom)
                }
                // The keyboard, which this used to try to infer from the
                // height above and never could.
                //
                // Opening it does not shrink the `GeometryReader` — SwiftUI
                // reports the keyboard as a bottom SAFE AREA, and a safe area
                // sits inside the proposed size rather than reducing it. So
                // `outer.size.height` never moved and the handler above never
                // fired. That much is certain: the old code was not a weak
                // mechanism, it was no mechanism.
                //
                // What is NOT established is that this one is doing the work.
                // On iOS 26.4 the transcript follows the keyboard with these
                // observers, without them, and with the whole file reverted to
                // the version that could not work — the system pins a scroll
                // view that was already at its end all by itself. Only 26.4 is
                // installed here, and the app deploys to 17.0, so that is one
                // data point about one release, not a licence to delete this.
                //
                // It stays as the explicit answer to an explicit question:
                // both directions matter — opening puts the bottom of the
                // transcript behind the keys, and closing gives that space
                // back — and it borrows the keyboard's own duration, which the
                // automatic behaviour does not promise to.
                .onReceive(keyboardWillChange) { note in
                    followKeyboard(note, proxy)
                }
                .onReceive(keyboardWillHide) { note in
                    followKeyboard(note, proxy)
                }
            }
        }
    }

    private var keyboardWillChange: NotificationCenter.Publisher {
        NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)
    }

    private var keyboardWillHide: NotificationCenter.Publisher {
        NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
    }

    /// Re-pin to the newest message as the keyboard moves.
    ///
    /// `isNearBottom` is read now, before the safe area changes, so the
    /// question being answered is "was the operator at the bottom when they
    /// tapped the field" — someone reading history is left where they are.
    ///
    /// The scroll waits one turn of the run loop: the notification arrives
    /// *will*-change, and scrolling to the bottom before the inset lands
    /// would aim at the old bottom. It borrows the keyboard's own duration so
    /// the transcript and the keys move together rather than in sequence.
    private func followKeyboard(_ note: Notification, _ proxy: ScrollViewProxy) {
        guard isNearBottom else { return }
        let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey]
            as? Double ?? 0.25
        Task { @MainActor in
            await Task.yield()
            withAnimation(.easeOut(duration: duration)) {
                proxy.scrollTo(Self.anchorID, anchor: .bottom)
            }
        }
    }

    /// A freshly opened conversation always starts at its newest message,
    /// and keeps being pulled there for as long as the content is still
    /// arriving.
    private func open(_ proxy: ScrollViewProxy) {
        settleUntil = .now + 2
        lastHeight = 0
        proxy.scrollTo(Self.anchorID, anchor: .bottom)
    }

    private var isNearBottom: Bool {
        // Before anything is measured, "at the bottom" is the safe answer:
        // the alternative is refusing to scroll on the very first paint.
        guard metrics.height > 0 else { return true }
        if let distance = metrics.distanceToBottom { return distance < threshold }
        guard viewport > 0 else { return true }
        return metrics.height - metrics.offset - viewport < threshold
    }
}

/// Where the transcript is, read from the scroll view itself.
///
/// iOS 18 reports a scroll view's geometry directly. Before that it had to be
/// measured with a `GeometryReader` behind the content and handed up as a
/// preference — which changes with every scrolled point, and a scroll made in
/// answer to it changes it again in the same frame. That is the console's
/// "Bound preference TranscriptGeometryKey tried to update multiple times per
/// frame". The preference is kept only for iOS 17.
private struct TranscriptGeometryReader: ViewModifier {
    let metrics: ScrollMetrics

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: TranscriptGeometry.self) { geometry in
                let visibleBottom = geometry.contentOffset.y + geometry.containerSize.height
                return TranscriptGeometry(
                    height: geometry.contentSize.height,
                    offset: geometry.contentOffset.y + geometry.contentInsets.top,
                    // Zero at the very end, whatever the bars and the
                    // composer cover.
                    distanceToBottom: geometry.contentSize.height + geometry.contentInsets.bottom - visibleBottom
                )
            } action: { _, geometry in
                metrics.apply(geometry)
            }
        } else {
            // The closure has to be sendable, so it may only touch an
            // actor-isolated box — never the proxy, and never `self`.
            content.onPreferenceChange(TranscriptGeometryKey.self) { [metrics] geometry in
                Task { @MainActor in metrics.apply(geometry) }
            }
        }
    }
}

/// The iOS 17 measurement: the content's height and how far it has scrolled.
private struct LegacyGeometryProbe: ViewModifier {
    let space: String

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
        } else {
            content.background(
                GeometryReader { inner in
                    Color.clear.preference(
                        key: TranscriptGeometryKey.self,
                        value: TranscriptGeometry(
                            height: inner.size.height,
                            offset: -inner.frame(in: .named(space)).minY
                        )
                    )
                }
            )
        }
    }
}

/// Where the transcript is, in numbers.
///
/// A class rather than plain `@State` because `onPreferenceChange` hands its
/// value to a sendable closure, which may capture an isolated reference but
/// not a `View`.
@MainActor
@Observable
final class ScrollMetrics {
    private(set) var height: CGFloat = 0
    private(set) var offset: CGFloat = 0
    /// How far the end of the transcript is below the visible part, when the
    /// scroll view says so itself (iOS 18 and later).
    private(set) var distanceToBottom: CGFloat?

    nonisolated init() {}

    fileprivate func apply(_ geometry: TranscriptGeometry) {
        height = geometry.height
        offset = geometry.offset
        distanceToBottom = geometry.distanceToBottom
    }
}

struct TranscriptGeometry: Equatable, Sendable {
    var height: CGFloat = 0
    var offset: CGFloat = 0
    var distanceToBottom: CGFloat?
}

private struct TranscriptGeometryKey: PreferenceKey {
    static let defaultValue = TranscriptGeometry()

    /// The content's own reading wins. A zero-height report is a view that
    /// has not been laid out yet, not a transcript that shrank to nothing.
    static func reduce(value: inout TranscriptGeometry, nextValue: () -> TranscriptGeometry) {
        let next = nextValue()
        if next.height > 0 { value = next }
    }
}
