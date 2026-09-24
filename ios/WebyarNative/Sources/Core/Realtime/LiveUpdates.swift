import SwiftUI
import Observation

/// The one place the app listens to the platform.
///
/// Before this existed, every screen in the app read once and then sat there:
/// the inbox reloaded when its `.task` re-ran — which is why leaving the tab
/// and coming back was the way to see a new message — and an open thread
/// never reloaded at all. Nothing was wrong with the screens; there was
/// simply nothing telling them anything had happened.
///
/// The platform has had that channel all along. The web console negotiates a
/// transport, subscribes to `ws:<workspace>:inbox` and to the thread it has
/// open, and re-reads when a push arrives. This is the same three steps, in
/// Swift, against the same endpoints — `/api/realtime/operator-connect`,
/// `/operator-inbox-subscribe`, `/operator-subscribe` — so a deployment that
/// changes its realtime provider changes it for the phone too, and neither
/// client has a private arrangement the other does not know about.
///
/// What it costs the server: two requests when a connection is established
/// and two more each time the token is renewed, which is once every half
/// hour. Between those, nothing at all — no request, no query, no row. The
/// fallback below is the only thing here that polls, and it only runs where
/// the platform has said sockets are not available.
@MainActor
@Observable
final class LiveUpdates {

    static let shared = LiveUpdates()

    /// Whether a socket is actually carrying events right now.
    ///
    /// Screens watch this rather than assume: while it is false they ask the
    /// server on a timer instead, which is what the web does when the
    /// negotiated provider is `polling_builtin`.
    private(set) var isLive = false

    private var api: any WebyarAPI { Backend.current }

    private var socket: CentrifugoSocket?
    private var workspaceID: String?
    /// Who wants to hear about what. A channel with no listeners is a channel
    /// the socket does not need to be subscribed to.
    private var listeners: [LiveChannel: [UUID: AsyncStream<LivePush>.Continuation]] = [:]
    private var subscribed: Set<LiveChannel> = []

    private var opening: Task<Void, Never>?
    private var retry: Task<Void, Never>?
    private var renewal: Task<Void, Never>?
    private var idleClose: Task<Void, Never>?
    private var attempt = 0
    /// Why the next negotiation is happening. The platform counts
    /// reconnections from what the client says, so this is tracked rather
    /// than always reported as a first connection.
    private var intent: LiveConnectIntent = .initial
    /// Set while the app is in the background. iOS suspends the process, the
    /// socket dies with it, and reconnecting a socket nobody can see is just
    /// a way to spend somebody's battery.
    private var isSuspended = false

    private init() {}

    // MARK: - Listening

    /// Everything that happens on one channel, for as long as the caller
    /// keeps reading.
    ///
    /// Ending the loop — which is what `.task` does when a screen goes away —
    /// is the whole unsubscribe: the stream's termination handler drops the
    /// listener, and the last listener off a channel takes the subscription
    /// with it.
    func stream(_ channel: LiveChannel) -> AsyncStream<LivePush> {
        // At most two kept. Every push that reaches a screen means the same
        // thing — "read this again" — so a burst of six is one refresh, and
        // keeping the other five would be five identical requests.
        let (stream, continuation) = AsyncStream<LivePush>.makeStream(
            of: LivePush.self,
            bufferingPolicy: .bufferingNewest(2)
        )
        let id = UUID()
        listeners[channel, default: [:]][id] = continuation
        idleClose?.cancel()
        idleClose = nil

        continuation.onTermination = { _ in
            Task { @MainActor in LiveUpdates.shared.stopListening(id, on: channel) }
        }

        connectIfNeeded(workspace: channel.workspaceID)
        Task { await subscribeIfNeeded(channel) }
        return stream
    }

    private func stopListening(_ id: UUID, on channel: LiveChannel) {
        listeners[channel]?.removeValue(forKey: id)
        guard listeners[channel]?.isEmpty ?? true else { return }

        listeners[channel] = nil
        subscribed.remove(channel)
        if let socket {
            Task { await socket.unsubscribe(channel: channel.name) }
        }

        guard listeners.isEmpty else { return }
        // Not straight away. Switching tabs ends one screen's listening and
        // starts another's a moment later, and closing the socket in between
        // would pay for a fresh negotiation every time somebody looked at
        // Settings.
        idleClose?.cancel()
        idleClose = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard let self, !Task.isCancelled, self.listeners.isEmpty else { return }
            self.idleClose = nil
            self.teardown()
        }
    }

    // MARK: - The app's own lifecycle

    /// The app went to the background.
    func suspend() {
        guard !isSuspended else { return }
        isSuspended = true
        teardown()
    }

    /// The app came back. Screens refresh themselves on the same signal, so
    /// anything that happened while the socket was down is already on its way.
    func resume() {
        guard isSuspended else { return }
        isSuspended = false
        guard let workspace = workspaceID ?? listeners.keys.first?.workspaceID else { return }
        connectIfNeeded(workspace: workspace)
    }

    /// Signed out, or signed in as somebody else. The tokens this connection
    /// holds belong to the operator who is leaving.
    func signedOut() {
        teardown()
        workspaceID = nil
        intent = .initial
    }

    // MARK: - Connection

    private func connectIfNeeded(workspace: String) {
        if workspaceID != workspace {
            teardown()
            workspaceID = workspace
            intent = .initial
        }
        // The sample backend is a fixture in memory. There is no server to
        // negotiate with and nothing that could ever change.
        guard !Backend.isSample, !isSuspended, socket == nil, opening == nil, retry == nil else { return }
        opening = Task { await self.open() }
    }

    private func open() async {
        defer { opening = nil }
        guard let workspace = workspaceID, !isSuspended else { return }

        guard let negotiation = try? await api.liveNegotiation(workspaceID: workspace, intent: intent) else {
            // We could not even ask. Screens poll until this succeeds.
            isLive = false
            scheduleRetry()
            return
        }
        guard !isSuspended, workspaceID == workspace else { return }

        guard negotiation.canOpenSocket,
              let url = negotiation.socketURL,
              let token = negotiation.token
        else {
            // This deployment is on polling, or is being held there during an
            // incident. Believe it, and stop asking: nothing on this side can
            // change the answer, and the web memoizes the same verdict for
            // the life of a tab.
            isLive = false
            return
        }

        let fresh = CentrifugoSocket(
            url: url,
            onPush: { push in Task { @MainActor in LiveUpdates.shared.deliver(push) } },
            onDropped: { Task { @MainActor in LiveUpdates.shared.socketDropped() } }
        )

        do {
            try await fresh.open(token: token)
        } catch {
            await fresh.close()
            isLive = false
            scheduleRetry()
            return
        }

        guard !isSuspended, workspaceID == workspace else {
            await fresh.close()
            return
        }

        socket = fresh
        isLive = true
        attempt = 0
        scheduleRenewal(before: negotiation.expiresAt)
        for channel in listeners.keys {
            await subscribeIfNeeded(channel)
        }
    }

    private func subscribeIfNeeded(_ channel: LiveChannel) async {
        guard let target = socket, isLive,
              listeners[channel] != nil,
              !subscribed.contains(channel)
        else { return }

        guard let grant = try? await api.liveGrant(for: channel),
              let token = grant.token,
              // The server names the channel it just authorized. If it is not
              // the one asked for, something upstream has changed shape and
              // subscribing anyway would be guessing.
              grant.channel == channel.name
        else { return }

        // The socket can be replaced while a grant is in flight.
        guard socket === target, listeners[channel] != nil else { return }

        do {
            try await target.subscribe(channel: channel.name, token: token)
            subscribed.insert(channel)
        } catch {
            // Whatever went wrong, the reconnect path re-subscribes
            // everything anybody is still listening to.
        }
    }

    private func deliver(_ push: LivePush) {
        for (channel, bag) in listeners where channel.name == push.channel {
            for continuation in bag.values { continuation.yield(push) }
        }
    }

    private func socketDropped() {
        socket = nil
        isLive = false
        subscribed.removeAll()
        renewal?.cancel()
        renewal = nil
        intent = .reconnect
        guard !isSuspended, !listeners.isEmpty else { return }
        scheduleRetry()
    }

    /// Closes the socket and forgets what it had subscribed to. Listeners
    /// survive: the screens still want to hear, and the next connection
    /// subscribes to everything they are waiting on.
    private func teardown() {
        opening?.cancel(); opening = nil
        retry?.cancel(); retry = nil
        renewal?.cancel(); renewal = nil
        idleClose?.cancel(); idleClose = nil
        subscribed.removeAll()
        if let socket { Task { await socket.close() } }
        socket = nil
        isLive = false
        attempt = 0
    }

    // MARK: - Timers

    private static let backoffSeconds: [Double] = [1, 2, 5, 10, 20, 30]

    private func scheduleRetry() {
        guard retry == nil, !isSuspended, !listeners.isEmpty else { return }
        let base = Self.backoffSeconds[min(attempt, Self.backoffSeconds.count - 1)]
        attempt += 1
        // A little randomness, so a provider coming back after an outage is
        // not met by every phone in the workspace at the same millisecond.
        let wait = base * Double.random(in: 0.8...1.2)

        retry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self, !Task.isCancelled else { return }
            self.retry = nil
            guard self.socket == nil, let workspace = self.workspaceID else { return }
            self.connectIfNeeded(workspace: workspace)
        }
    }

    private func scheduleRenewal(before expiry: Date?) {
        renewal?.cancel()
        renewal = nil
        guard let expiry else { return }
        // A minute early, and never less than ten seconds out: a token with
        // moments left is still worth those moments, and renewing in a tight
        // loop would be worse than either.
        let wait = max(10, expiry.timeIntervalSinceNow - 60)

        renewal = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self, !Task.isCancelled else { return }
            self.renewal = nil
            guard let workspace = self.workspaceID else { return }
            // A new connection token means a new socket. Centrifugo has a
            // `refresh` command for doing it in place, and this app does not
            // need the extra state to save one reconnection every half hour.
            self.teardown()
            self.intent = .refresh
            self.connectIfNeeded(workspace: workspace)
        }
    }
}
