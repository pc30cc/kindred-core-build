import SwiftUI

/// The message list of any thread — a conversation in any inbox or channel,
/// or a colleague — kept where an operator expects it:
///
/// - opening a thread (or switching to another) lands on its newest message,
///   however late the messages arrive and however tall they turn out;
/// - a new message follows along only while the operator is already at the
///   bottom; scrolled up to read, they stay put and a button offers the way
///   back down, counting what arrived meanwhile;
/// - what the operator sends always brings the list to the bottom, from
///   wherever they were.
struct PinnedMessageList<Rows: View>: View {
    /// Changes when another thread is shown.
    let threadId: String
    /// The newest row, to notice arrivals.
    let lastId: String?
    /// Bumped by the model each time this operator sends.
    let sentCount: Int
    let isEmpty: Bool
    /// Changes when something above the list takes or gives back room (a call panel sliding
    /// in or out): a list that was at the bottom goes back there.
    var refit: Bool = false
    @ViewBuilder let rows: () -> Rows

    @Environment(AppModel.self) private var app
    @State private var atBottom = true
    @State private var unseen = 0
    /// Waiting to land on the newest message of a thread just opened.
    @State private var landing = true
    @State private var landingTask: Task<Void, Never>?
    /// When the end of the list last went out of view: a list that shrinks (a call sliding
    /// down above it) pushes it out without the operator having scrolled anywhere.
    @State private var leftBottomAt: Date?

    private static var bottomId: String { "pinned-list-bottom" }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    rows()
                    // The end of the list: seen means the operator is at the bottom.
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomId)
                        .onAppear {
                            atBottom = true
                            unseen = 0
                        }
                        .onDisappear {
                            atBottom = false
                            leftBottomAt = Date()
                        }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            // Bubbles sit left/right physically, as the web thread; text inside follows its
            // own direction. Set on the scroll view itself: a right-to-left scroll view around
            // left-to-right content draws it shifted sideways.
            .environment(\.layoutDirection, .leftToRight)
            .overlay(alignment: .bottomTrailing) {
                if !atBottom && !isEmpty && !landing {
                    jumpButton { scrollToBottom(proxy, animated: true) }
                        .padding(.trailing, 18)
                        .padding(.bottom, 12)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            }
            .animation(.smooth(duration: 0.2), value: atBottom)
            // The space for the list changed (a call panel sliding in or out above it): one that
            // was at the bottom stays there, rather than being left part-way up.
            .onChange(of: refit) { _, _ in keepAtBottom(proxy) }
            .onChange(of: threadId, initial: true) { _, _ in
                unseen = 0
                landing = true
                land(proxy)
            }
            .onChange(of: lastId) { old, new in
                guard new != nil else { return }
                if landing {
                    land(proxy)
                } else if atBottom {
                    scrollToBottom(proxy, animated: true)
                } else if old != nil {
                    unseen += 1
                }
            }
            .onChange(of: sentCount) { _, _ in
                unseen = 0
                // After the new row is laid out, then once more should it still be growing.
                Task { @MainActor in
                    scrollToBottom(proxy, animated: true)
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    scrollToBottom(proxy, animated: true)
                }
            }
            .onDisappear { landingTask?.cancel() }
        }
    }

    /// Lands on the newest message once there is one. A lazy list learns its
    /// true height only as rows are laid out, so it goes to the end again a
    /// moment later rather than stopping at an estimate.
    private func land(_ proxy: ScrollViewProxy) {
        guard !isEmpty else { return }
        landingTask?.cancel()
        landingTask = Task { @MainActor in
            for delay: UInt64 in [0, 60_000_000, 200_000_000, 450_000_000] {
                if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
                if Task.isCancelled { return }
                scrollToBottom(proxy, animated: false)
            }
            landing = false
            atBottom = true
            unseen = 0
        }
    }

    private func keepAtBottom(_ proxy: ScrollViewProxy) {
        guard !landing, !isEmpty else { return }
        // At the bottom a moment ago counts: the room change itself may have pushed it out of view.
        let justLeft = leftBottomAt.map { Date().timeIntervalSince($0) < 0.8 } ?? false
        guard atBottom || justLeft else { return }
        Task { @MainActor in
            // Now, as the panel slides, and once it has settled.
            for delay: UInt64 in [0, 120_000_000, 400_000_000] {
                if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
                scrollToBottom(proxy, animated: false)
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        if animated {
            withAnimation(.smooth(duration: 0.25)) { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
        } else {
            proxy.scrollTo(Self.bottomId, anchor: .bottom)
        }
    }

    private func jumpButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "chevron.down")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.text)
                .frame(width: 36, height: 36)
                .glass(Circle(), interactive: true)
                .overlay(alignment: .topTrailing) {
                    if unseen > 0 {
                        Text(app.strings.number(unseen))
                            .appFont(10.5, .bold)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(Capsule().fill(Palette.brand))
                            .offset(x: 6, y: -6)
                    }
                }
                .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .help(app.strings["jumpToLatest"])
    }
}
