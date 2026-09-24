import SwiftUI

extension View {
    /// Keeps a screen current while it is on screen.
    ///
    /// `onChange` is handed the push that caused it, or `nil` when the reason
    /// was not a push — the app coming back to the foreground, or the timer
    /// that stands in where the platform has no socket for us. Screens that
    /// only need to know *that* something happened can ignore it; a screen
    /// that can tell whether it already has the message uses it to decide
    /// whether the round trip is worth making at all.
    func liveUpdates(
        on channel: LiveChannel?,
        onChange: @escaping @MainActor (LivePush?) async -> Void
    ) -> some View {
        modifier(LiveUpdatesModifier(channel: channel, onChange: onChange))
    }
}

private struct LiveUpdatesModifier: ViewModifier {

    let channel: LiveChannel?
    /// Main-actor isolated on purpose. Every caller reaches straight into a
    /// screen's own model from here, and a closure carrying the main actor's
    /// isolation is what lets it do that inside `.task` without the app
    /// having to hop actors to touch its own view state.
    let onChange: @MainActor (LivePush?) async -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var live = LiveUpdates.shared

    func body(content: Content) -> some View {
        content
            // `.task` is tied to the screen being on screen: it starts when
            // the view appears and is cancelled when it goes away. That is
            // exactly the subscription's lifetime, so there is nothing else
            // to remember to turn off.
            .task(id: channel) {
                guard let channel else { return }
                for await push in live.stream(channel) {
                    await onChange(push)
                }
            }
            .task(id: fallbackKey) {
                await askOnATimer()
            }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:
                    live.resume()
                    // Whatever arrived while the app was away was missed by a
                    // socket that was not running. One read settles it.
                    if channel != nil { Task { await onChange(nil) } }
                case .background:
                    live.suspend()
                default:
                    break
                }
            }
    }

    /// Restarts the timer whenever any of the three things it depends on
    /// changes: which channel, whether a socket is carrying events, and
    /// whether the app is in front of somebody.
    private var fallbackKey: String {
        "\(channel?.name ?? "-")|\(live.isLive)|\(scenePhase == .active)"
    }

    /// The path for a deployment whose realtime provider is `polling_builtin`
    /// or `disabled`, and for the seconds between a socket dropping and the
    /// next one opening.
    ///
    /// Only while the screen is in front of somebody, and only while there is
    /// no socket: on this deployment — where Centrifugo is the configured
    /// provider — this loop never runs at all.
    private func askOnATimer() async {
        guard channel != nil, !Backend.isSample, !live.isLive, scenePhase == .active else { return }

        while !Task.isCancelled {
            // Ahead of the first ask rather than after it: a reconnection
            // takes a second or two, and asking immediately would buy an
            // answer the socket was about to deliver for nothing.
            try? await Task.sleep(for: .seconds(12))
            guard !Task.isCancelled, !live.isLive else { return }
            await onChange(nil)
        }
    }
}
