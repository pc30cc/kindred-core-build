import Foundation

/// A channel the operator is allowed to listen on.
///
/// The names are the platform's, not this app's: `server/services/realtime/
/// types.ts` builds exactly these two shapes, the web console subscribes to
/// exactly these two, and `/realtime/subscribe` refuses anything else. An app
/// that invented its own naming would be talking to nobody.
enum LiveChannel: Hashable, Sendable {

    /// Everything happening in the workspace's conversation list. Carries a
    /// `message` envelope for every new message on any thread — the server
    /// fans those out here as well as to the thread's own channel
    /// (`publishConversationEvent`) — plus `event` envelopes for status,
    /// assignment, tags and the AI lifecycle.
    case inbox(workspaceID: String)

    /// One open thread.
    case conversation(workspaceID: String, conversationID: String)

    var workspaceID: String {
        switch self {
        case .inbox(let workspaceID): return workspaceID
        case .conversation(let workspaceID, _): return workspaceID
        }
    }

    var name: String {
        switch self {
        case .inbox(let workspaceID):
            return "ws:\(workspaceID):inbox"
        case .conversation(let workspaceID, let conversationID):
            return "ws:\(workspaceID):conv:\(conversationID)"
        }
    }
}

/// Something that happened, reduced to the few fields the app acts on.
///
/// The envelope on the wire carries a whole message — body, sender, avatar,
/// attachments — and this app deliberately throws all of it away and re-reads
/// the thread instead. Patching a transcript from a push means two code paths
/// that can disagree about what a conversation contains; re-reading means
/// one. The push is a doorbell, not a delivery.
struct LivePush: Sendable {
    /// `message` or `event`. Typing and read receipts are dropped before they
    /// get this far — the app draws neither, and a typing storm would be the
    /// loudest thing on the socket.
    let type: String
    let channel: String
    let conversationID: String?
    /// The message's own id, on a `message` push. What lets a screen tell a
    /// message it already has from one it does not.
    let messageID: String?
    let senderType: String?
    /// `conversation_updated`, `spam_changed`, … on an `event` push.
    let kind: String?
}

/// Why a client is negotiating, in the server's own vocabulary.
///
/// It decides nothing about the answer — every intent gets the same token —
/// and exists so the platform's reconnect metric counts reconnections rather
/// than every connection. `policy_poll` is the web's separate policy
/// heartbeat and has no equivalent here.
enum LiveConnectIntent: String, Sendable {
    /// First connection for this workspace in this session.
    case initial
    /// A healthy socket, replaced ahead of its token expiring.
    case refresh
    /// The socket actually went.
    case reconnect
}

/// The platform's answer to "how should I stay up to date?".
///
/// The web console asks this on every tab before it opens anything
/// (`resolveClientRealtimeProvider.ts`) and so does this app, for the same
/// reason: which transport is in use is a deployment's decision, changeable
/// from Super Admin, and during an incident the platform can hold every
/// client on polling even while the socket layer looks healthy. A client that
/// assumed would be the one client that ignored the switch.
struct LiveNegotiation: Sendable {
    let vendor: String
    let socketURL: URL?
    let token: String?
    /// When the connection token stops being accepted.
    let expiresAt: Date?
    /// The platform is holding clients off sockets on purpose.
    let forcePolling: Bool

    var canOpenSocket: Bool {
        vendor == "centrifugo" && !forcePolling && socketURL != nil && token != nil
    }
}

extension LiveNegotiation: Decodable {
    private enum Key: String, CodingKey {
        case vendor
        case wsURL = "ws_url"
        case token
        case expiresAt = "expires_at"
        case effectivePolicy = "effective_policy"
    }

    private enum PolicyKey: String, CodingKey {
        case forcePolling = "force_polling"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        vendor = try c.decodeIfPresent(String.self, forKey: .vendor) ?? "disabled"
        socketURL = (try c.decodeIfPresent(String.self, forKey: .wsURL)).flatMap(URL.init(string:))
        token = try c.decodeIfPresent(String.self, forKey: .token)
        // Epoch milliseconds — `centrifugo.ts` multiplies the JWT's `exp` by
        // 1000 before it answers. Reading it as seconds would put every
        // token's expiry somewhere in the year 57000 and the app would never
        // renew one.
        if let milliseconds = try c.decodeIfPresent(Double.self, forKey: .expiresAt) {
            expiresAt = Date(timeIntervalSince1970: milliseconds / 1000)
        } else {
            expiresAt = nil
        }
        if let policy = try? c.nestedContainer(keyedBy: PolicyKey.self, forKey: .effectivePolicy),
           let forced = try? policy.decodeIfPresent(Bool.self, forKey: .forcePolling) {
            forcePolling = forced
        } else {
            forcePolling = false
        }
    }
}

/// Permission to listen on one channel, minted per channel and per operator.
struct LiveChannelGrant: Sendable {
    let vendor: String
    let channel: String?
    let token: String?
}

extension LiveChannelGrant: Decodable {
    private enum Key: String, CodingKey { case vendor, channel, token }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        vendor = try c.decodeIfPresent(String.self, forKey: .vendor) ?? "disabled"
        channel = try c.decodeIfPresent(String.self, forKey: .channel)
        token = try c.decodeIfPresent(String.self, forKey: .token)
    }
}
