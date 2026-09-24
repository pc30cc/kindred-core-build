import Foundation

/// One Centrifugo connection, speaking the frames the web console speaks.
///
/// There is no Centrifugo SDK here on purpose. The web client does not use
/// one either — `src/realtime/providers/centrifugo.ts` writes the frames by
/// hand — and the protocol this deployment needs is four shapes wide:
///
///     → {"id":1,"connect":{"token":"…","name":"ios"}}
///     → {"id":2,"subscribe":{"channel":"ws:…:inbox","token":"…"}}
///     ← {"id":2,"subscribe":{…}}   or   {"id":2,"error":{"code":…}}
///     ← {"push":{"channel":"…","pub":{"data":{"type":"message","payload":{…}}}}}
///
/// plus a keepalive that is literally `{}` in both directions. Adding a
/// dependency for that would be more code to keep in step with the server,
/// not less: the one thing that must never drift is the frame layout, and
/// the frame layout is right here next to the web's.
actor CentrifugoSocket {

    /// Why a command did not succeed.
    enum Failure: Error, Sendable {
        /// The socket is gone, or went while the command was in flight.
        case closed
        /// Centrifugo answered and said no. Code 109 is an expired token,
        /// which the caller must re-negotiate rather than retry.
        case rejected(code: Int, message: String)
        case timedOut
    }

    private let url: URL
    private let session: URLSession
    private let onPush: @Sendable (LivePush) -> Void
    /// Fired once, and only when the socket died on its own. A deliberate
    /// `close()` is not a disconnection to recover from.
    private let onDropped: @Sendable () -> Void

    private var socket: URLSessionWebSocketTask?
    private var pump: Task<Void, Never>?
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<Void, any Error>] = [:]
    private var isFinished = false

    init(
        url: URL,
        onPush: @escaping @Sendable (LivePush) -> Void,
        onDropped: @escaping @Sendable () -> Void
    ) {
        self.url = url
        self.onPush = onPush
        self.onDropped = onDropped

        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        self.session = URLSession(configuration: config)
    }

    // MARK: - Lifecycle

    /// Opens the socket and completes the Centrifugo handshake.
    ///
    /// Throws if the handshake is refused, which is the only honest signal
    /// the caller has that this transport is not going to work: a
    /// `URLSessionWebSocketTask` reports a connection failure through the
    /// first read or write, never from `resume()`.
    func open(token: String) async throws {
        guard !isFinished else { throw Failure.closed }
        let task = session.webSocketTask(with: url)
        socket = task
        task.resume()
        // Started before the handshake, because the handshake's own reply
        // arrives through it.
        pump = Task { [weak self] in await self?.readFrames() }
        try await send("connect", ["token": token, "name": "ios"])
    }

    func subscribe(channel: String, token: String) async throws {
        try await send("subscribe", ["channel": channel, "token": token])
    }

    func unsubscribe(channel: String) async {
        // Best-effort: if it fails the socket is going away anyway, and the
        // server drops the subscription with the connection.
        try? await send("unsubscribe", ["channel": channel])
    }

    /// Deliberate shutdown. Never calls `onDropped` — nobody needs to
    /// reconnect a socket that was asked to go.
    func close() {
        guard !isFinished else { return }
        isFinished = true
        pump?.cancel()
        pump = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        failEverythingPending()
    }

    // MARK: - Commands

    private func send(_ key: String, _ body: [String: String]) async throws {
        guard !isFinished, let socket else { throw Failure.closed }
        let id = nextID
        nextID += 1

        let frame: [String: Any] = ["id": id, key: body]
        guard let data = try? JSONSerialization.data(withJSONObject: frame) else {
            throw Failure.closed
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            pending[id] = continuation

            // A reply that never comes must not hold a caller forever. Eight
            // seconds is what the web waits.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(8))
                await self?.settle(id, with: Failure.timedOut)
            }

            socket.send(.string(String(decoding: data, as: UTF8.self))) { [weak self] error in
                guard error != nil else { return }
                Task { await self?.settle(id, with: Failure.closed) }
            }
        }
    }

    private func settle(_ id: Int, with error: (any Error)?) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    }

    private func failEverythingPending() {
        let waiting = pending
        pending = [:]
        for continuation in waiting.values { continuation.resume(throwing: Failure.closed) }
    }

    // MARK: - Reading

    private func readFrames() async {
        while !isFinished, let socket {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await socket.receive()
            } catch {
                dropped()
                return
            }
            switch message {
            case .string(let text): handle(text)
            case .data(let data): handle(String(decoding: data, as: UTF8.self))
            @unknown default: break
            }
        }
    }

    private func dropped() {
        guard !isFinished else { return }
        isFinished = true
        socket = nil
        failEverythingPending()
        onDropped()
    }

    /// Centrifugo may batch several frames into one message, newline
    /// separated, so every read is a list of frames rather than one.
    private func handle(_ text: String) {
        for line in text.split(separator: "\n") {
            guard let data = line.data(using: .utf8),
                  let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { continue }

            // The keepalive is an empty object, and the server wants the same
            // back. Miss it and the connection is closed under us after a
            // ping interval or two — with no error, which is what makes it
            // such a confusing thing to debug.
            if frame["id"] == nil, frame["push"] == nil, frame["error"] == nil {
                pong()
                continue
            }

            if let id = frame["id"] as? Int {
                if let error = frame["error"] as? [String: Any] {
                    settle(id, with: Failure.rejected(
                        code: error["code"] as? Int ?? 0,
                        message: error["message"] as? String ?? "rejected"
                    ))
                } else {
                    settle(id, with: nil)
                }
                continue
            }

            guard let push = frame["push"] as? [String: Any] else { continue }

            // The server hands out a disconnect push when a token expires
            // rather than closing silently. Treat it as the close it is
            // about to become, so the caller re-negotiates instead of
            // reconnecting with the same dead token.
            if push["disconnect"] != nil {
                socket?.cancel(with: .goingAway, reason: nil)
                dropped()
                return
            }

            deliver(push)
        }
    }

    private func pong() {
        socket?.send(.string("{}")) { _ in }
    }

    private func deliver(_ push: [String: Any]) {
        guard let channel = push["channel"] as? String,
              let publication = push["pub"] as? [String: Any],
              let envelope = publication["data"] as? [String: Any],
              let type = envelope["type"] as? String
        else { return }

        // Typing and read receipts are dropped here rather than ignored
        // upstairs. This app draws neither, and someone holding a key down
        // would otherwise be the busiest thing on the socket — for a screen
        // whose only reaction would be to throw every one of them away.
        guard type == "message" || type == "event" else { return }

        let payload = envelope["payload"] as? [String: Any] ?? [:]
        onPush(LivePush(
            type: type,
            channel: channel,
            conversationID: payload["conversation_id"] as? String,
            messageID: payload["id"] as? String,
            senderType: payload["sender_type"] as? String,
            kind: payload["kind"] as? String
        ))
    }
}
