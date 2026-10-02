import Foundation

// MARK: - Tokens

/// `POST /api/realtime/operator-connect`.
struct RealtimeConnect: Decodable, Sendable, Equatable {
    /// `centrifugo` when the platform runs it; anything else (`disabled`,
    /// `polling_builtin`, `supabase`) means no socket for this app.
    let vendor: String
    let wsURL: String?
    let token: String?
    /// Milliseconds since 1970, when the token stops being accepted.
    let expiresAt: Int64?

    enum CodingKeys: String, CodingKey {
        case vendor, token
        case wsURL = "ws_url"
        case expiresAt = "expires_at"
    }

    init(vendor: String, wsURL: String?, token: String?, expiresAt: Int64?) {
        self.vendor = vendor
        self.wsURL = wsURL
        self.token = token
        self.expiresAt = expiresAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        vendor = (try? c.decode(String.self, forKey: .vendor)) ?? "disabled"
        wsURL = try? c.decodeIfPresent(String.self, forKey: .wsURL)
        token = try? c.decodeIfPresent(String.self, forKey: .token)
        expiresAt = (try? c.decodeIfPresent(Double.self, forKey: .expiresAt)).flatMap { $0.map { Int64(exactly: $0.rounded()) } } ?? nil
    }
}

/// `POST /api/realtime/operator-inbox-subscribe`.
struct RealtimeSubscribe: Decodable, Sendable, Equatable {
    let vendor: String
    let channel: String?
    let token: String?
    let expiresAt: Int64?

    enum CodingKeys: String, CodingKey {
        case vendor, channel, token
        case expiresAt = "expires_at"
    }

    init(vendor: String, channel: String?, token: String?, expiresAt: Int64?) {
        self.vendor = vendor
        self.channel = channel
        self.token = token
        self.expiresAt = expiresAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        vendor = (try? c.decode(String.self, forKey: .vendor)) ?? "disabled"
        channel = try? c.decodeIfPresent(String.self, forKey: .channel)
        token = try? c.decodeIfPresent(String.self, forKey: .token)
        expiresAt = (try? c.decodeIfPresent(Double.self, forKey: .expiresAt)).flatMap { $0.map { Int64(exactly: $0.rounded()) } } ?? nil
    }
}

// MARK: - Events

/// Something that happened in the workspace, as the server published it on
/// `ws:<workspace>:inbox` (`server/services/realtime/publish.ts`).
struct RealtimeEvent: Sendable, Equatable {
    /// `message`, `event`, `seen`, `typing`.
    var type: String
    var conversationID: String?
    var messageID: String?
    /// For `event`: `conversation_updated`, `conversation_resolved`, …
    var kind: String?
    /// The message row itself, when the envelope carried one it could be
    /// read as: shown at once, before the thread is read again.
    var message: Message?
    /// For `email_mailbox_changed`: which mailbox (`gmail`, `yahoo`).
    var provider: String?

    /// A connected mailbox changed (Gmail's push, Yahoo's poll): nothing
    /// about a conversation, only the mailbox's screens read again.
    var isMailboxChange: Bool { kind == "email_mailbox_changed" }

    var isMessage: Bool { type == "message" }
    /// Typing is not something the inbox or a thread reads anything for.
    var needsNoRead: Bool { type == "typing" }
}

/// Something that happened in one of this operator's team threads, as the
/// server published it on their own channel `ws:<workspace>:user:<id>`
/// (`publishTeamEvent`). Ids only: the text is read over REST, where
/// membership is checked again.
struct TeamEvent: Sendable, Equatable {
    static let message = "team_message"
    static let read = "team_read"

    var kind: String
    var messageID: String?
    var senderID: String?
    var recipientID: String?
    /// For a read: whose messages were read.
    var peerID: String?

    /// The `{ type: "event", payload: { kind, … } }` envelope, if it is a team event.
    static func parse(_ data: JSONValue) -> TeamEvent? {
        let payload = data["payload"]
        guard let kind = payload?["kind"]?.stringValue, kind == message || kind == read else { return nil }
        return TeamEvent(
            kind: kind,
            messageID: payload?["message_id"]?.stringValue,
            senderID: payload?["sender_id"]?.stringValue,
            recipientID: payload?["recipient_id"]?.stringValue,
            peerID: payload?["peer_id"]?.stringValue
        )
    }

    /// The colleague this event is about, seen from `me`: the other side of
    /// a message, or the one whose messages were just read.
    func peer(me: String?) -> String? {
        if kind == Self.read { return peerID }
        if let me, senderID == me { return recipientID }
        return senderID
    }
}

enum CentrifugoFrame: Equatable {
    /// An empty object: the server's ping. Unanswered, the server drops the connection.
    case ping
    case reply(id: Int, error: String?)
    case publication(channel: String?, data: JSONValue)
    case disconnect
    case other
}

/// Centrifugo's JSON protocol, the subset the console and the desktop apps
/// use: numbered commands, replies carrying the same id, pushes carrying
/// `{ type, payload }` envelopes, several frames per message separated by
/// newlines.
enum CentrifugoProtocol {
    static func connect(id: Int, token: String, name: String) -> String {
        json(["id": id, "connect": ["token": token, "name": name]])
    }

    static func subscribe(id: Int, channel: String, token: String) -> String {
        json(["id": id, "subscribe": ["channel": channel, "token": token]])
    }

    static let pong = "{}"

    private static func json(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    static func parse(_ text: String) -> [CentrifugoFrame] {
        text.split(separator: "\n").compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) else { return nil }
            return parseOne(object)
        }
    }

    private static func parseOne(_ object: Any) -> CentrifugoFrame {
        guard let root = object as? [String: Any] else { return .other }
        if root.isEmpty { return .ping }
        if let id = (root["id"] as? NSNumber)?.intValue {
            var error: String?
            if let err = root["error"] as? [String: Any] {
                error = (err["message"] as? String) ?? "code \((err["code"] as? NSNumber)?.intValue ?? 0)"
            }
            return .reply(id: id, error: error)
        }
        if let push = root["push"] as? [String: Any] {
            if push["disconnect"] != nil { return .disconnect }
            let channel = push["channel"] as? String
            if let pub = push["pub"] as? [String: Any], let data = pub["data"],
               JSONSerialization.isValidJSONObject(data),
               let bytes = try? JSONSerialization.data(withJSONObject: data),
               let value = try? JSONDecoder().decode(JSONValue.self, from: bytes) {
                return .publication(channel: channel, data: value)
            }
        }
        return .other
    }

    /// The `{ type, payload }` envelope.
    static func event(_ data: JSONValue) -> RealtimeEvent? {
        guard let type = data["type"]?.stringValue else { return nil }
        let payload = data["payload"]
        return RealtimeEvent(
            type: type,
            conversationID: payload?["conversation_id"]?.stringValue,
            messageID: type == "message" ? payload?["id"]?.stringValue : payload?["message_id"]?.stringValue,
            kind: payload?["kind"]?.stringValue,
            message: type == "message" ? payload.flatMap(message) : nil,
            provider: payload?["provider"]?.stringValue
        )
    }

    /// A message row from an envelope, if it has what a thread needs to show it.
    static func message(_ payload: JSONValue) -> Message? {
        guard payload["id"]?.stringValue != nil,
              payload["conversation_id"]?.stringValue != nil,
              payload["created_at"]?.stringValue != nil,
              let data = try? JSONEncoder().encode(payload)
        else { return nil }
        return try? StoreCoding.decoder().decode(Message.self, from: data)
    }
}

// MARK: - The connection

/// Listens on `ws:<workspace>:inbox` — the operator channel every message and
/// conversation change in the workspace is published on — while the app is
/// in front of the operator.
///
/// iOS rules, and the phone's battery, decide when it runs: it is started
/// when the scene becomes active and stopped when the app goes to the
/// background. It never holds a socket open behind the operator's back; a
/// push notification is what reaches them there, and coming back to the app
/// is a catch-up read (`SyncCoordinator`), not a replay of the socket.
///
/// When the platform runs without realtime (another vendor, forced polling),
/// this never connects, asks again only every few minutes, and the screens
/// keep to their polling.
///
/// Also joined, when the server offers it: the operator's own channel
/// `ws:<workspace>:user:<id>`, which carries team chat. It rides the same
/// socket as a second subscription and is optional — a server without it, or
/// a refusal, leaves the inbox connected and team chat on its polling.
///
/// Deliberately not joined: `ws:<workspace>:operators`. Membership there is
/// what marks an operator "connected" for routing and for who gets pushed;
/// the phone has never claimed that, and a phone opened for a glance should
/// not start having conversations routed to it.
@MainActor
final class InboxRealtime {
    private static let backoff: [Double] = [1, 2, 4, 8, 15, 30]
    /// Renegotiate this long before the tokens expire, as the console does.
    private static let refreshLead: TimeInterval = 120
    /// How long to wait before asking again when the server says "no realtime".
    private static let policyRetry: TimeInterval = 300

    private let api: any WebyarAPI
    let workspaceID: String
    private let session: URLSession
    private var loop: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    /// Message ids already handed on: a resubscribe can replay recent publications.
    private var seen: [String] = []
    /// The socket is being closed on purpose, to renew its tokens.
    private var refreshing = false
    /// `stop()` has run. The URL session is invalidated there — a session is
    /// never usable again once invalidated — so a stopped connection is
    /// finished for good, and the coordinator makes a fresh one to restart.
    private var stopped = false

    private(set) var isConnected = false
    /// The team channel is joined as well.
    private(set) var isTeamConnected = false

    var onEvent: ((RealtimeEvent) -> Void)?
    var onConnectionChanged: ((Bool) -> Void)?
    var onTeamEvent: ((TeamEvent) -> Void)?
    /// Platform support's news (`support_*`), which rides the same channel:
    /// the operator is not a member of the workspace that answers, so the
    /// server tells them on their own channel of every workspace they are in.
    var onSupportEvent: ((SupportSignal) -> Void)?
    var onTeamConnectionChanged: ((Bool) -> Void)?

    /// The command id of the team channel's subscribe.
    private static let teamCommand = 3

    init(api: any WebyarAPI, workspaceID: String) {
        self.api = api
        self.workspaceID = workspaceID
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration)
    }

    var isRunning: Bool { loop != nil }

    func start() {
        guard loop == nil, !stopped else { return }
        loop = Task { [weak self] in await self?.run() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        setConnected(false)
        // A URLSession holds a strong reference to its delegate queue and
        // lives until invalidated; without this every foreground/background
        // round trip leaked one.
        if !stopped {
            stopped = true
            session.invalidateAndCancel()
        }
    }

    private func setConnected(_ value: Bool) {
        if !value { setTeamConnected(false) }
        guard isConnected != value else { return }
        isConnected = value
        onConnectionChanged?(value)
    }

    private func setTeamConnected(_ value: Bool) {
        guard isTeamConnected != value else { return }
        isTeamConnected = value
        onTeamConnectionChanged?(value)
    }

    private func run() async {
        var attempt = 0
        var intent = "initial"
        while !Task.isCancelled {
            var wait: TimeInterval
            do {
                let outcome = try await connectOnce(intent: intent)
                if outcome.subscribed { attempt = 0 }
                wait = outcome.retry ?? Self.backoff[min(attempt, Self.backoff.count - 1)]
                if outcome.retry == nil { attempt += 1 }
                intent = outcome.refresh ? "refresh" : "reconnect"
            } catch is CancellationError {
                break
            } catch APIError.unauthorized {
                // The session ended: the screens' own reads will say so. No retry loop against a dead token.
                break
            } catch {
                wait = Self.backoff[min(attempt, Self.backoff.count - 1)]
                attempt += 1
                intent = "reconnect"
            }
            socket = nil
            setConnected(false)
            if Task.isCancelled { break }
            let jitter = 0.8 + Double.random(in: 0...0.4)
            try? await Task.sleep(nanoseconds: UInt64(max(0, wait * jitter) * 1_000_000_000))
        }
        setConnected(false)
    }

    private struct Outcome {
        var subscribed: Bool
        var refresh: Bool
        var retry: TimeInterval?
    }

    private func connectOnce(intent: String) async throws -> Outcome {
        let connection = try await api.realtimeConnect(workspaceID: workspaceID, intent: intent)
        guard connection.vendor == "centrifugo", let wsURL = connection.wsURL, let token = connection.token,
              let url = URL(string: wsURL), url.scheme == "wss" || url.scheme == "ws"
        else {
            return Outcome(subscribed: false, refresh: false, retry: Self.policyRetry)
        }
        let subscription = try await api.realtimeInboxSubscribe(workspaceID: workspaceID)
        guard subscription.vendor == "centrifugo", let channel = subscription.channel,
              let subscriptionToken = subscription.token,
              channel == "ws:\(workspaceID):inbox"
        else {
            return Outcome(subscribed: false, refresh: false, retry: Self.policyRetry)
        }
        // The team channel is extra: an older server answers 404, a platform
        // without it answers another vendor, and either way the inbox carries on.
        let team = await teamSubscription()
        try Task.checkCancellation()

        let expiresAt = min(connection.expiresAt ?? .max, subscription.expiresAt ?? .max, team?.expiresAt ?? .max)
        let refreshAt: Date? = expiresAt == .max
            ? nil
            : Date(timeIntervalSince1970: Double(expiresAt) / 1000).addingTimeInterval(-Self.refreshLead)

        let task = session.webSocketTask(with: url)
        socket = task
        task.resume()
        defer { task.cancel(with: .normalClosure, reason: nil) }
        try await task.send(.string(CentrifugoProtocol.connect(id: 1, token: token, name: "webyar-ios")))

        var subscribed = false
        // Renew the tokens shortly before they expire: closing the socket
        // makes the loop come round with intent "refresh".
        refreshing = false
        let refreshTimer: Task<Void, Never>? = refreshAt.map { at in
            Task { [weak self, weak task] in
                let wait = max(10, at.timeIntervalSinceNow)
                guard wait < 86_400 else { return }
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.refreshing = true
                task?.cancel(with: .goingAway, reason: nil)
            }
        }
        defer { refreshTimer?.cancel() }

        while !Task.isCancelled {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                return Outcome(subscribed: subscribed, refresh: refreshing, retry: refreshing ? 0 : nil)
            }
            let text: String
            switch message {
            case .string(let s): text = s
            case .data(let d): text = String(data: d, encoding: .utf8) ?? ""
            @unknown default: continue
            }
            for frame in CentrifugoProtocol.parse(text) {
                switch frame {
                case .ping:
                    try await task.send(.string(CentrifugoProtocol.pong))
                case .reply(Self.teamCommand, let error):
                    // Refused or joined, the inbox subscription stands.
                    setTeamConnected(error == nil)
                case .reply(_, let error?):
                    _ = error
                    return Outcome(subscribed: subscribed, refresh: false, retry: nil)
                case .reply(1, nil):
                    try await task.send(.string(CentrifugoProtocol.subscribe(id: 2, channel: channel, token: subscriptionToken)))
                case .reply(2, nil):
                    subscribed = true
                    setConnected(true)
                    if let team, let teamChannel = team.channel, let teamToken = team.token {
                        try await task.send(.string(
                            CentrifugoProtocol.subscribe(id: Self.teamCommand, channel: teamChannel, token: teamToken)
                        ))
                    }
                case .disconnect:
                    return Outcome(subscribed: subscribed, refresh: false, retry: nil)
                case .publication(let fromChannel, let data):
                    if let fromChannel, fromChannel == team?.channel {
                        if let event = TeamEvent.parse(data) {
                            onTeamEvent?(event)
                        } else if let signal = SupportSignal.parse(data) {
                            onSupportEvent?(signal)
                        }
                        break
                    }
                    // Only the channel asked for; anything else is not this workspace's.
                    guard fromChannel == nil || fromChannel == channel, let event = CentrifugoProtocol.event(data) else { break }
                    if event.isMessage, let id = event.messageID {
                        if seen.contains(id) { break }
                        seen.append(id)
                        if seen.count > 500 { seen.removeFirst(seen.count - 500) }
                    }
                    onEvent?(event)
                default:
                    break
                }
            }
        }
        throw CancellationError()
    }

    /// The token for this operator's own channel, if the server offers one —
    /// and only if it names a channel of this workspace's shape.
    private func teamSubscription() async -> RealtimeSubscribe? {
        guard let team = try? await api.realtimeUserSubscribe(workspaceID: workspaceID),
              team.vendor == "centrifugo", let channel = team.channel, team.token != nil,
              channel.hasPrefix("ws:\(workspaceID):user:")
        else { return nil }
        return team
    }
}
