import Foundation

// Platform support: the operator talking to the team that runs the platform
// (docs/PLATFORM_SUPPORT.md, `/api/platform-support`).
//
// The team answers from its own workspace's inbox; the operator is not a
// member of it, so nothing here belongs to a workspace of theirs. Keys are
// camelCase, as the endpoint writes them, and every one of them is read
// leniently: a field this build does not know, or one an older server leaves
// out, falls back to its default rather than failing the whole answer.

/// Whether support is offered, and whether the team is there now.
struct SupportStatus: Equatable, Sendable {
    /// Super Admin has turned support on and chosen who answers.
    var enabled = false
    /// This operator may use it.
    var available = false
    /// Somebody on the team is reachable now; otherwise the app says "leave a message".
    var online = false
    var teamName: String?
    /// The support workspace's logo; nil while it has none.
    var teamAvatar: String?
    /// The team's messages the operator has not read.
    var unread = 0
    /// Nil when the support workspace keeps no business hours.
    var hours: SupportHours?
    /// Set while the hours have the team closed: when it opens again.
    var nextOpenAt: Date?

    /// Whether the server offers support to this operator at all.
    var shown: Bool { enabled && available }
}

extension SupportStatus: Decodable {
    private enum CodingKeys: String, CodingKey {
        case enabled, available, online, teamName, teamAvatar, unread, hours, nextOpenAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        available = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? false
        online = (try? c.decodeIfPresent(Bool.self, forKey: .online)) ?? false
        teamName = (try? c.decodeIfPresent(String.self, forKey: .teamName))?.nonBlank
        teamAvatar = (try? c.decodeIfPresent(String.self, forKey: .teamAvatar))?.nonBlank
        unread = max(0, (try? c.decodeIfPresent(Int.self, forKey: .unread)) ?? 0)
        hours = try? c.decodeIfPresent(SupportHours.self, forKey: .hours)
        nextOpenAt = try? c.decodeIfPresent(Date.self, forKey: .nextOpenAt)
    }
}

/// The support workspace's week, in its own time zone.
struct SupportHours: Equatable, Sendable {
    /// IANA, e.g. `Asia/Tehran`.
    var timezone = ""
    /// Keys `sat`…`fri`; a day that is absent or empty is closed.
    var weekly: [String: [SupportInterval]] = [:]
}

extension SupportHours: Decodable {
    private enum CodingKeys: String, CodingKey { case timezone, weekly }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        timezone = (try? c.decodeIfPresent(String.self, forKey: .timezone)) ?? ""
        weekly = (try? c.decodeIfPresent([String: [SupportInterval]].self, forKey: .weekly)) ?? [:]
    }
}

/// One opening on one day, as `HH:mm` wall-clock times.
struct SupportInterval: Equatable, Sendable {
    var from = ""
    var to = ""
}

extension SupportInterval: Decodable {
    private enum CodingKeys: String, CodingKey { case from, to }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = (try? c.decodeIfPresent(String.self, forKey: .from)) ?? ""
        to = (try? c.decodeIfPresent(String.self, forKey: .to)) ?? ""
    }
}

/// Everything the operator has said to the team and heard back: the last
/// conversations, oldest first, and their items across them.
struct SupportHistory: Equatable, Sendable {
    var conversations: [SupportConversation] = []
    var items: [SupportItem] = []
    /// The newest `open` or `pending` conversation, which a message goes to.
    var activeConversationID: String?
}

extension SupportHistory: Decodable {
    private enum CodingKeys: String, CodingKey {
        case conversations, items
        case activeConversationID = "activeConversationId"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversations = (try? c.decodeIfPresent([Lenient<SupportConversation>].self, forKey: .conversations))?
            .compactMap(\.value) ?? []
        items = (try? c.decodeIfPresent([Lenient<SupportItem>].self, forKey: .items))?.compactMap(\.value) ?? []
        activeConversationID = (try? c.decodeIfPresent(String.self, forKey: .activeConversationID))?.nonBlank
    }
}

struct SupportConversation: Identifiable, Equatable, Sendable {
    static let open = "open"
    static let pending = "pending"
    static let resolved = "resolved"
    static let closed = "closed"

    let id: String
    /// open, pending, resolved or closed.
    var status = SupportConversation.open
    var createdAt: Date?
    /// When it was resolved or closed.
    var endedAt: Date?
    var rating: SupportRating?
    /// Ended, answered by the team, and not rated yet.
    var canRate = false

    /// Resolved or closed: the operator's next message starts a new one.
    var ended: Bool { status == Self.resolved || status == Self.closed }
}

extension SupportConversation: Decodable {
    private enum CodingKeys: String, CodingKey { case id, status, createdAt, endedAt, rating, canRate }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? Self.open
        createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
        endedAt = try? c.decodeIfPresent(Date.self, forKey: .endedAt)
        rating = try? c.decodeIfPresent(SupportRating.self, forKey: .rating)
        canRate = (try? c.decodeIfPresent(Bool.self, forKey: .canRate)) ?? false
    }
}

struct SupportRating: Equatable, Sendable {
    /// 1 to 5.
    var score = 0
    var comment: String?
    var ratedAt: Date?
}

extension SupportRating: Decodable {
    private enum CodingKeys: String, CodingKey { case score, comment, ratedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        score = (try? c.decodeIfPresent(Int.self, forKey: .score)) ?? 0
        comment = (try? c.decodeIfPresent(String.self, forKey: .comment))?.nonBlank
        ratedAt = try? c.decodeIfPresent(Date.self, forKey: .ratedAt)
    }
}

/// A message in the chat, or a line saying who joined it.
struct SupportItem: Identifiable, Equatable, Sendable {
    static let kindMessage = "message"
    static let kindJoined = "joined"
    static let authorMe = "me"
    static let authorTeam = "team"

    let id: String
    var conversationID = ""
    /// `message` or `joined`.
    var kind = SupportItem.kindMessage
    /// `me` — the operator — or `team`; a join is the team's.
    var author = SupportItem.authorMe
    /// Empty for a join.
    var body = ""
    /// The agent who wrote it; for a join, who joined.
    var senderName: String?
    var senderAvatar: String?
    var createdAt: Date?
    var clientMessageID: String?
    var attachments: [SupportAttachment] = []

    var fromTeam: Bool { author == Self.authorTeam }
    var isJoin: Bool { kind == Self.kindJoined }
}

extension SupportItem: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, kind, author, body, senderName, senderAvatar, createdAt, attachments
        case conversationID = "conversationId"
        case clientMessageID = "clientMessageId"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        conversationID = (try? c.decodeIfPresent(String.self, forKey: .conversationID)) ?? ""
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? Self.kindMessage
        author = (try? c.decodeIfPresent(String.self, forKey: .author)) ?? Self.authorMe
        body = (try? c.decodeIfPresent(String.self, forKey: .body)) ?? ""
        senderName = (try? c.decodeIfPresent(String.self, forKey: .senderName))?.nonBlank
        senderAvatar = (try? c.decodeIfPresent(String.self, forKey: .senderAvatar))?.nonBlank
        createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
        clientMessageID = (try? c.decodeIfPresent(String.self, forKey: .clientMessageID))?.nonBlank
        attachments = (try? c.decodeIfPresent([Lenient<SupportAttachment>].self, forKey: .attachments))?
            .compactMap(\.value) ?? []
    }
}

/// A file on a support message, fetched by id through `GET /attachments/:id`.
struct SupportAttachment: Identifiable, Equatable, Sendable {
    let id: String
    var fileName = ""
    var mimeType = ""
    var sizeBytes = 0
    /// image, audio, video or file.
    var kind = "file"

    /// The shape the chat's own attachment views draw — fetched from the
    /// support endpoint, never the workspace's (`MessageAttachment.Origin`).
    var messageAttachment: MessageAttachment {
        MessageAttachment(
            id: id,
            fileName: fileName.nonBlank,
            mimeType: mimeType.nonBlank,
            sizeBytes: sizeBytes > 0 ? sizeBytes : nil,
            kind: kind.nonBlank,
            origin: .support
        )
    }
}

extension SupportAttachment: Decodable {
    private enum CodingKeys: String, CodingKey { case id, fileName, mimeType, sizeBytes, kind }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        fileName = (try? c.decodeIfPresent(String.self, forKey: .fileName)) ?? ""
        mimeType = (try? c.decodeIfPresent(String.self, forKey: .mimeType)) ?? ""
        sizeBytes = (try? c.decodeIfPresent(Int.self, forKey: .sizeBytes)) ?? 0
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "file"
    }
}

/// What `POST /messages` and `POST /attachments` answer with.
struct SupportPostResult: Decodable, Equatable, Sendable {
    let conversation: SupportConversation
    let item: SupportItem
}

/// What `POST /conversations/:id/rating` answers with.
struct SupportRatingResult: Decodable, Equatable, Sendable {
    let conversation: SupportConversation
}

/// The endpoints behind Settings → Online support. Every backend the app can
/// run against answers them (`WebyarAPI` refines this); the support screens
/// ask for nothing more, which is what lets a test hand them only these.
protocol SupportAPI: Sendable {
    func supportStatus() async throws -> SupportStatus
    func supportHistory() async throws -> SupportHistory
    /// `conversationID`: the open conversation the message is written to, or
    /// nil to start a new one. `workspaceID`: where the operator writes from.
    func sendSupportMessage(
        body: String, clientMessageID: String, conversationID: String?, workspaceID: String?
    ) async throws -> SupportPostResult
    func sendSupportAttachment(
        fileName: String, mimeType: String, data: Data,
        clientMessageID: String, conversationID: String?, workspaceID: String?
    ) async throws -> SupportPostResult
    func supportAttachmentData(id: String) async throws -> Data
    /// The same bytes on disk, in a temporary file the caller then owns.
    func supportAttachmentFile(id: String) async throws -> URL
    func rateSupportConversation(id: String, score: Int, comment: String?) async throws -> SupportConversation
    func markSupportRead() async throws
}

/// Something moved in the operator's support chat: a message
/// (`support_message`), a conversation resolved, closed, reopened or passed
/// on (`support_update`), or the chat read on another device
/// (`support_read`) — heard on the operator's own channel or by push. Ids
/// only: whoever shows support reads `/history` again.
struct SupportSignal: Equatable, Sendable {
    static let message = "support_message"
    static let update = "support_update"
    static let read = "support_read"
    /// Not the server's: back in front of the operator, or the channel back
    /// after a gap — anything may have been missed.
    static let resync = "resync"

    var kind: String
    /// The conversation, when the event named one.
    var threadID: String?

    /// The `{ type: "event", payload: { kind, thread_id, … } }` envelope, if
    /// it is a support event.
    static func parse(_ data: JSONValue) -> SupportSignal? {
        let payload = data["payload"]
        guard let kind = payload?["kind"]?.stringValue, kind.hasPrefix("support_") else { return nil }
        return SupportSignal(kind: kind, threadID: payload?["thread_id"]?.stringValue)
    }
}

/// One element of a list, or nothing when that element does not decode — so
/// one odd row never costs the operator the whole history.
private struct Lenient<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

private extension String {
    var nonBlank: String? {
        trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self
    }
}
