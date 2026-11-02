import Foundation

// Operator-to-operator messages — the console calls this the internal inbox,
// and its Colleagues tab. Mirrors `/api/team-chat` and `src/hooks/useTeamChat.ts`.

struct Colleague: Decodable, Identifiable, Hashable, Sendable {
    let userId: String
    let role: String?
    let fullName: String?
    let email: String?
    let avatarURL: String?
    let unread: Int?
    let lastMessage: LastTeamMessage?

    var id: String { userId }

    var displayName: String {
        if let name = fullName, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        if let email, !email.isEmpty { return email }
        return "—"
    }

    struct LastTeamMessage: Decodable, Hashable, Sendable {
        let body: String?
        let createdAt: Date?
        let outgoing: Bool?
        let attachmentKind: String?
        /// The colleague call this line stands for, when it is one: the list
        /// previews it by its icon and title, never its body (`TeamCallLog`).
        var call: TeamChatCall? = nil

        enum CodingKeys: String, CodingKey {
            case body
            case createdAt = "created_at"
            case outgoing
            case attachmentKind = "attachment_kind"
            case call
        }
    }

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case role
        case fullName = "full_name"
        case email
        case avatarURL = "avatar_url"
        case unread
        case lastMessage = "last_message"
    }
}

struct ColleaguesResponse: Decodable, Sendable {
    let colleagues: [Colleague]
    let totalUnread: Int?
    let me: String?

    enum CodingKeys: String, CodingKey {
        case colleagues
        case totalUnread = "total_unread"
        case me
    }
}

struct TeamMessage: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let senderId: String
    let recipientId: String?
    let body: String?
    let attachment: MessageAttachment?
    let readAt: Date?
    let createdAt: Date?
    /// The colleague call this line stands for, when it is one: the thread
    /// draws it as a call bubble, and its body (the older apps' fallback) is
    /// never shown (`TeamCallLog`).
    var call: TeamChatCall? = nil

    enum CodingKeys: String, CodingKey {
        case id
        case senderId = "sender_id"
        case recipientId = "recipient_id"
        case body
        case attachment
        case readAt = "read_at"
        case createdAt = "created_at"
        case call
    }
}

struct TeamThreadResponse: Decodable, Sendable {
    let messages: [TeamMessage]
    let me: String?
}

// MARK: - The call in the chat

/// The colleague call a team-chat line stands for: `call` on a message of
/// `GET /api/team-chat/thread` and on `last_message` of
/// `GET /api/team-chat/colleagues` (docs/operations/TEAM_CALLS.md, "The call
/// in the chat"). Only the server writes such a line, once, when the call is
/// over: from the caller to the callee, placed where the call rang.
///
/// `{ id, channel: "audio"|"video", outcome:
/// "completed"|"missed"|"declined"|"cancelled"|"failed", duration_seconds:
/// number|null, caller_id }`. One this build cannot read in full — a channel
/// or an outcome it does not know, no caller — is no call at all: the line
/// reads as the message it also is, its body the language-neutral fallback
/// (📞 or 📹), as the web panel's `teamChatCallOf` reads it.
struct TeamChatCall: Decodable, Hashable, Sendable {
    let id: String
    let channel: CallChannel
    let outcome: TeamCallOutcome
    /// `ended_at − connected_at`, in whole seconds, for a completed call;
    /// nil for any other outcome, or a duration the server did not know.
    let durationSeconds: Int?
    /// Who placed the call: the line's sender.
    let callerID: String

    enum CodingKeys: String, CodingKey {
        case id, channel, outcome
        case durationSeconds = "duration_seconds"
        case callerID = "caller_id"
    }

    init(id: String, channel: CallChannel, outcome: TeamCallOutcome, durationSeconds: Int? = nil, callerID: String) {
        self.id = id
        self.channel = channel
        self.outcome = outcome
        self.durationSeconds = durationSeconds
        self.callerID = callerID
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id).trimmingCharacters(in: .whitespacesAndNewlines)
        let callerID = try c.decode(String.self, forKey: .callerID).trimmingCharacters(in: .whitespacesAndNewlines)
        let rawChannel = try c.decode(String.self, forKey: .channel)
        let rawOutcome = try c.decode(String.self, forKey: .outcome)
        // The raw values, not `TeamCallOutcome`'s own decoding, which reads
        // an unknown outcome as `failed`: here an unknown one is no call.
        guard !id.isEmpty, !callerID.isEmpty,
              let channel = CallChannel(rawValue: rawChannel),
              let outcome = TeamCallOutcome(rawValue: rawOutcome)
        else {
            throw DecodingError.dataCorruptedError(
                forKey: .outcome, in: c, debugDescription: "not a colleague call this build can draw"
            )
        }
        self.id = id
        self.channel = channel
        self.outcome = outcome
        self.callerID = callerID
        // A number, finite and not negative, as the web reads it; anything
        // else is a duration nobody knows.
        let seconds = try? c.decodeIfPresent(Double.self, forKey: .durationSeconds)
        durationSeconds = seconds.flatMap { value -> Int? in
            guard value.isFinite, value >= 0, value < 1e9 else { return nil }
            return Int(value.rounded(.down))
        }
    }

    /// `call` as a line carries it: absent, null or unreadable is nil, and
    /// never fails the message around it — a thread that will not decode
    /// because of one line it cannot draw would hide every other line too.
    static func lenient<Key: CodingKey>(_ container: KeyedDecodingContainer<Key>, forKey key: Key) -> TeamChatCall? {
        try? container.decodeIfPresent(TeamChatCall.self, forKey: key)
    }
}

// Decoded by hand, in extensions so the memberwise initialisers stay, only
// to read `call` leniently (`TeamChatCall.lenient`); every other field as
// the synthesised decoding read it.

extension TeamMessage {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        senderId = try c.decode(String.self, forKey: .senderId)
        recipientId = try c.decodeIfPresent(String.self, forKey: .recipientId)
        body = try c.decodeIfPresent(String.self, forKey: .body)
        attachment = try c.decodeIfPresent(MessageAttachment.self, forKey: .attachment)
        readAt = try c.decodeIfPresent(Date.self, forKey: .readAt)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt)
        call = TeamChatCall.lenient(c, forKey: .call)
    }
}

extension Colleague.LastTeamMessage {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        body = try c.decodeIfPresent(String.self, forKey: .body)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt)
        outgoing = try c.decodeIfPresent(Bool.self, forKey: .outgoing)
        attachmentKind = try c.decodeIfPresent(String.self, forKey: .attachmentKind)
        call = TeamChatCall.lenient(c, forKey: .call)
    }
}
