import Foundation

/// Something that happened in the workspace: a new message, or a change to a conversation.
struct InboxEvent: Sendable, Equatable {
    var type: String
    var conversationId: String?
    var messageId: String?
    var senderType: String?
    var kind: String?

    var isMessage: Bool { type == "message" }
    var isVisitorMessage: Bool { isMessage && senderType == SenderType.contact }
}

enum CentrifugoFrame: Equatable {
    /// An empty object: the server's ping. Unanswered, the server drops the connection.
    case ping
    case reply(id: Int, error: String?)
    case publication(channel: String?, data: JSONValue)
    case disconnect
    case other
}

/// Centrifugo's JSON protocol, the subset the web console uses
/// (src/realtime/providers/centrifugo.ts): numbered commands, replies with the
/// same id, pushes carrying `{ type, payload }` envelopes, and several frames
/// per WebSocket message separated by newlines.
enum CentrifugoProtocol {
    static func connect(id: Int, token: String, name: String) -> String {
        json(["id": id, "connect": ["token": token, "name": name]])
    }

    static func subscribe(id: Int, channel: String, token: String) -> String {
        json(["id": id, "subscribe": ["channel": channel, "token": token]])
    }

    static let pong = "{}"

    private static func json(_ obj: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data()
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    static func parse(_ message: String) -> [CentrifugoFrame] {
        message.split(separator: "\n").compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) else { return nil }
            return parseOne(obj)
        }
    }

    private static func parseOne(_ obj: Any) -> CentrifugoFrame {
        guard let root = obj as? [String: Any] else { return .other }
        if root.isEmpty { return .ping }
        if let id = (root["id"] as? NSNumber)?.intValue {
            var error: String?
            if let err = root["error"] as? [String: Any] {
                error = (err["message"] as? String) ?? "\(err)"
            }
            return .reply(id: id, error: error)
        }
        if let push = root["push"] as? [String: Any] {
            if push["disconnect"] != nil { return .disconnect }
            let channel = push["channel"] as? String
            if let pub = push["pub"] as? [String: Any], let data = pub["data"],
               let bytes = try? JSONSerialization.data(withJSONObject: data),
               let value = try? JSONDecoder().decode(JSONValue.self, from: bytes) {
                return .publication(channel: channel, data: value)
            }
        }
        return .other
    }

    /// The `{ type, payload }` envelope the server publishes (server/services/realtime/publish.ts).
    static func event(_ data: JSONValue) -> InboxEvent? {
        guard let type = data["type"]?.string else { return nil }
        let p = data["payload"]
        return InboxEvent(type: type, conversationId: p?["conversation_id"]?.string, messageId: p?["id"]?.string,
                          senderType: p?["sender_type"]?.string, kind: p?["kind"]?.string)
    }
}

/// Listens on `ws:<workspace>:inbox`, the channel the web console uses: every
/// message and operator event in the workspace arrives there. While it is
/// connected the app's pollers relax to a slow safety net. When the server
/// runs without realtime this simply never connects and the pollers carry on.
///
/// It also joins `ws:<workspace>:operators` (what makes this operator
/// "connected" for teammates) and, on request, `ws:<workspace>:visitors`.
@MainActor
final class InboxRealtime {
    private static let backoff: [Double] = [1, 2, 4, 8, 15, 30]
    /// Renegotiate this long before the tokens expire, as the web console does.
    private static let refreshLead: TimeInterval = 120
    /// How long to wait before asking again when the server says "poll".
    private static let policyRetry: TimeInterval = 300

    private let api: WebyarAPI
    private let workspaceId: String
    private let allowed: () -> Bool
    private var seen = Set<String>()
    private var loop: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var nextCommand = 10
    private var visitorsCommand: Int?

    private(set) var isConnected = false

    var onEvent: ((InboxEvent) -> Void)?
    var onConnectionChanged: ((Bool) -> Void)?
    /// The operator is now a member of the workspace's operators channel.
    var onPresenceJoined: (() -> Void)?
    /// A nudge on the visitors channel (someone arrived, left or moved on).
    var onVisitorEvent: ((JSONValue) -> Void)?

    /// Set when the visitors page wants the visitors channel; joined on every (re)connect.
    var wantsVisitors = false {
        didSet { if wantsVisitors && !oldValue && isConnected { Task { await subscribeVisitors() } } }
    }

    init(api: WebyarAPI, workspaceId: String, allowed: @escaping () -> Bool) {
        self.api = api
        self.workspaceId = workspaceId
        self.allowed = allowed
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in await self?.run() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        setConnected(false)
    }

    private func setConnected(_ value: Bool) {
        guard isConnected != value else { return }
        isConnected = value
        onConnectionChanged?(value)
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
            } catch {
                Log.write("[realtime] failed: \(error)")
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

    private struct Outcome { var subscribed: Bool; var refresh: Bool; var retry: TimeInterval? }

    private func connectOnce(intent: String) async throws -> Outcome {
        guard allowed() else { return Outcome(subscribed: false, refresh: false, retry: Self.policyRetry) }
        let conn = try await api.realtimeConnect(workspaceId: workspaceId, intent: intent)
        guard conn.vendor == "centrifugo", let wsUrl = conn.wsUrl, let token = conn.token, let url = URL(string: wsUrl) else {
            return Outcome(subscribed: false, refresh: false, retry: Self.policyRetry)
        }
        let sub = try await api.realtimeInboxSubscribe(workspaceId: workspaceId)
        guard sub.vendor == "centrifugo", let channel = sub.channel, let subToken = sub.token else {
            return Outcome(subscribed: false, refresh: false, retry: Self.policyRetry)
        }
        // Joining the operators channel is what makes this operator "connected"
        // for teammates, as in the web console. Optional: the inbox works without it.
        var presence: RealtimeSubscribe?
        do {
            let p = try await api.realtimePresenceSubscribe(workspaceId: workspaceId)
            if p.vendor == "centrifugo", p.channel != nil, p.token != nil { presence = p }
        } catch {
            Log.write("[realtime] presence token: \(error)")
        }

        var expiresAt = min(conn.expiresAt ?? .max, sub.expiresAt ?? .max)
        if let pe = presence?.expiresAt { expiresAt = min(expiresAt, pe) }
        let refreshAt: Date? = expiresAt == .max ? nil : Date(timeIntervalSince1970: Double(expiresAt) / 1000).addingTimeInterval(-Self.refreshLead)

        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        task.resume()
        defer { task.cancel(with: .normalClosure, reason: nil) }
        try await task.send(.string(CentrifugoProtocol.connect(id: 1, token: token, name: "webyar-macos")))

        var subscribed = false
        // Renew the tokens shortly before they expire.
        let refreshTimer: Task<Void, Never>? = refreshAt.map { at in
            Task { [weak task] in
                let wait = max(10, at.timeIntervalSinceNow)
                guard wait < 86_400 else { return }
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                if !Task.isCancelled { task?.cancel(with: .goingAway, reason: nil) }
            }
        }
        defer { refreshTimer?.cancel() }

        while !Task.isCancelled {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                if let refreshTimer, refreshAt.map({ $0.timeIntervalSinceNow <= 1 }) == true, !refreshTimer.isCancelled {
                    Log.write("[realtime] refreshing tokens")
                    return Outcome(subscribed: subscribed, refresh: true, retry: 0)
                }
                Log.write("[realtime] closed")
                return Outcome(subscribed: subscribed, refresh: false, retry: nil)
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
                case .reply(3, let error?):
                    Log.write("[realtime] presence error \(error)")
                case .reply(3, nil):
                    Log.write("[realtime] joined \(presence?.channel ?? "")")
                    onPresenceJoined?()
                case .reply(let id, let error?) where id == visitorsCommand:
                    Log.write("[realtime] visitors error \(error)")
                case .reply(let id, nil) where id == visitorsCommand:
                    Log.write("[realtime] visitors joined")
                case .reply(_, let error?):
                    Log.write("[realtime] error \(error)")
                    return Outcome(subscribed: subscribed, refresh: false, retry: nil)
                case .reply(1, nil):
                    try await task.send(.string(CentrifugoProtocol.subscribe(id: 2, channel: channel, token: subToken)))
                case .reply(2, nil):
                    subscribed = true
                    setConnected(true)
                    Log.write("[realtime] subscribed \(channel)")
                    if let pc = presence?.channel, let pt = presence?.token {
                        try await task.send(.string(CentrifugoProtocol.subscribe(id: 3, channel: pc, token: pt)))
                    }
                    if wantsVisitors { await subscribeVisitors() }
                case .disconnect:
                    Log.write("[realtime] server disconnect")
                    return Outcome(subscribed: subscribed, refresh: false, retry: nil)
                case .publication(let ch, let data):
                    if let ch, ch.hasSuffix(":visitors") {
                        onVisitorEvent?(data)
                        break
                    }
                    guard let ev = CentrifugoProtocol.event(data) else { break }
                    // A resubscribe can replay recent publications.
                    if ev.isMessage, let id = ev.messageId {
                        if seen.contains(id) { break }
                        seen.insert(id)
                        if seen.count > 500 { seen.removeAll() }
                    }
                    onEvent?(ev)
                default:
                    break
                }
            }
        }
        throw CancellationError()
    }

    private func subscribeVisitors() async {
        guard let task = socket, isConnected else { return }
        do {
            let sub = try await api.realtimeVisitorsSubscribe(workspaceId: workspaceId)
            guard sub.vendor == "centrifugo", let ch = sub.channel, let token = sub.token else { return }
            nextCommand += 1
            visitorsCommand = nextCommand
            try await task.send(.string(CentrifugoProtocol.subscribe(id: nextCommand, channel: ch, token: token)))
        } catch {
            Log.write("[realtime] visitors token: \(error)")
        }
    }
}
