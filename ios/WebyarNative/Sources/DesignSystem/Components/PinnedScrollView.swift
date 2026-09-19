import SwiftUI
import Observation

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
                    .background(
                        GeometryReader { inner in
                            Color.clear.preference(
                                key: TranscriptGeometryKey.self,
                                value: TranscriptGeometry(
                                    height: inner.size.height,
                                    offset: -inner.frame(in: .named(Self.space)).minY
                                )
                            )
                        }
                    )
                }
                .coordinateSpace(name: Self.space)
                // The closure has to be sendable, so it may only touch an
                // actor-isolated box — never the proxy, and never `self`.
                .onPreferenceChange(TranscriptGeometryKey.self) { [metrics] geometry in
                    Task { @MainActor in metrics.apply(geometry) }
                }
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
                    withAnimation(Theme.Motion.bubble) {
                        proxy.scrollTo(Self.anchorID, anchor: .bottom)
                    }
                }
                .onChange(of: conversationKey) {
                    open(proxy)
                }
                .onAppear {
                    viewport = outer.size.height
                    open(proxy)
                }
                .onChange(of: outer.size.height) { _, height in
                    viewport = height
                }
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
        guard metrics.height > 0, viewport > 0 else { return true }
        return metrics.height - metrics.offset - viewport < threshold
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

    nonisolated init() {}

    fileprivate func apply(_ geometry: TranscriptGeometry) {
        height = geometry.height
        offset = geometry.offset
    }
}

struct TranscriptGeometry: Equatable, Sendable {
    var height: CGFloat = 0
    var offset: CGFloat = 0
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
