import Foundation

// The server is the schema of record. Every type here mirrors a response the
// existing REST API already returns to the web client, so the native app and
// the web app can never drift into disagreeing about what a conversation is.
//
// Fields the server may omit are optional here rather than defaulted, so a
// missing value stays visibly missing instead of silently becoming "".

// MARK: - User

struct User: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let email: String?
    let fullName: String?
    let emailVerified: Bool?

    enum CodingKeys: String, CodingKey {
        case id, email, fullName
        case emailVerified
        case emailConfirmedAt = "email_confirmed_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        email = try c.decodeIfPresent(String.self, forKey: .email)
        fullName = try c.decodeIfPresent(String.self, forKey: .fullName)
        // The backend expresses "verified" two different ways depending on the
        // code path; either one means the same thing.
        if let flag = try c.decodeIfPresent(Bool.self, forKey: .emailVerified) {
            emailVerified = flag
        } else {
            emailVerified = try c.decodeIfPresent(String.self, forKey: .emailConfirmedAt) != nil
        }
    }

    init(id: String, email: String?, fullName: String?, emailVerified: Bool?) {
        self.id = id
        self.email = email
        self.fullName = fullName
        self.emailVerified = emailVerified
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(email, forKey: .email)
        try c.encodeIfPresent(fullName, forKey: .fullName)
        try c.encodeIfPresent(emailVerified, forKey: .emailVerified)
    }

    /// What to show when we have to name this person in the UI.
    var displayName: String {
        if let fullName, !fullName.trimmingCharacters(in: .whitespaces).isEmpty { return fullName }
        if let email, !email.isEmpty { return email }
        return "—"
    }
}

// MARK: - Workspace

struct Workspace: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let slug: String
    /// Resolved server-side from `workspace_branding` — either a URL someone
    /// pasted or a signed link into our own storage. Absent for a workspace
    /// that never set one, which is most of them on the first day.
    let logoURL: String?

    enum CodingKeys: String, CodingKey {
        case id, name, slug
        case logoURL = "logo_url"
    }
}

// MARK: - Contact

struct Contact: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let workspaceId: String?
    let name: String?
    let email: String?
    let phone: String?
    let avatarURL: String?
    /// Stable anonymous code for a visitor who never gave a name.
    let visitorCode: String?
    let createdAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case name, email, phone
        case avatarURL = "avatar_url"
        case visitorCode = "visitor_code"
        case createdAt = "created_at"
    }
}

// MARK: - Conversation

enum ConversationStatus: String, Codable, Sendable {
    case open, pending, resolved, closed

    /// `unknown` keeps a status the server adds later from breaking decoding.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ConversationStatus(rawValue: raw) ?? .open
    }
}

/// The contact summary the list endpoint nests inside each conversation.
struct ConversationContact: Codable, Hashable, Sendable {
    let name: String?
    let email: String?
    let avatarURL: String?
    let visitorCode: String?

    enum CodingKeys: String, CodingKey {
        case name, email
        case avatarURL = "avatar_url"
        case visitorCode = "visitor_code"
    }
}

/// The last message preview the list endpoint computes server-side.
///
/// `body` alone is not enough to write a preview line with. A system notice's
/// body is an English sentence frozen into the row when it was written, and an
/// attachment-only message has no body at all — which is why the list endpoint
/// ships the pieces to rebuild both (`server/routes/conversations.ts`, the
/// `lastByConv` block).
struct MessagePreview: Codable, Hashable, Sendable {
    let body: String?
    let createdAt: Date?
    let senderType: String?
    let senderName: String?
    /// `image` / `audio` / `video` / `file` when the message is only an
    /// attachment.
    let attachmentKind: String?
    /// Which system notice this is, when it is one.
    let systemKind: String?
    /// Everything that notice needs to be written out again in any language.
    let systemMeta: [String: JSONValue]?

    enum CodingKeys: String, CodingKey {
        case body
        case createdAt = "created_at"
        case senderType = "sender_type"
        case senderName = "sender_name"
        case attachmentKind = "attachment_kind"
        case systemKind = "system_kind"
        case systemMeta = "system_meta"
    }

    /// Spelled out rather than left to the memberwise default so the fields
    /// that only a real server fills in can be omitted at a call site that is
    /// making up a plain text message.
    init(
        body: String?,
        createdAt: Date?,
        senderType: String?,
        senderName: String? = nil,
        attachmentKind: String? = nil,
        systemKind: String? = nil,
        systemMeta: [String: JSONValue]? = nil
    ) {
        self.body = body
        self.createdAt = createdAt
        self.senderType = senderType
        self.senderName = senderName
        self.attachmentKind = attachmentKind
        self.systemKind = systemKind
        self.systemMeta = systemMeta
    }
}

/// How urgent a thread is.
///
/// Only the two levels above normal are ever shown — badging the ordinary case
/// would make the badge mean nothing.
enum ConversationPriority: String, Codable, Sendable {
    case low, normal, high, urgent

    /// An unrecognised level degrades to normal rather than failing the whole
    /// response, the same way status does.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ConversationPriority(rawValue: raw) ?? .normal
    }

    var isElevated: Bool { self == .high || self == .urgent }
}

struct Conversation: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let workspaceId: String
    let contactId: String?
    let subject: String?
    let status: ConversationStatus
    let assignedTo: String?
    let priority: ConversationPriority?
    /// Free-form labels the team puts on a thread. The server normalizes
    /// them, so what comes back is what should be shown.
    let tags: [String]?
    let createdAt: Date?
    let updatedAt: Date?

    let contact: ConversationContact?
    let lastMessage: MessagePreview?
    let unreadCount: Int?
    let aiState: String?
    /// Only the keys the app reads are decoded; the rest of the object is
    /// server bookkeeping.
    let metadata: [String: JSONValue]?

    enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case contactId = "contact_id"
        case subject, status, priority, tags
        case assignedTo = "assigned_to"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case contact = "contacts"
        case lastMessage = "last_message"
        case unreadCount = "unread_count"
        case aiState = "ai_state"
        case metadata
    }

    var hasUnread: Bool { (unreadCount ?? 0) > 0 }

    /// Who is answering: `metadata.ai_state` first, then the top-level column.
    ///
    /// Both exist server-side and the nested one is authoritative — this is the
    /// same precedence `InboxPage.tsx` reads them in.
    var aiStateValue: String? {
        if let nested = metadata?["ai_state"]?.stringValue, !nested.isEmpty { return nested }
        return aiState
    }

    /// The timestamp the list sorts and labels by: when something last
    /// happened in the thread, not when it was created.
    var lastActivity: Date? { lastMessage?.createdAt ?? updatedAt ?? createdAt }
}

// MARK: - Message

enum SenderType: String, Codable, Sendable {
    /// A human operator — us.
    case agent
    /// The visitor.
    case contact
    /// An automated reply.
    case ai
    /// Legacy generic bot.
    case bot
    /// A state change note, not something a person typed.
    case system

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SenderType(rawValue: raw) ?? .system
    }

    /// Whether this message sits on our side of the transcript.
    var isOutgoing: Bool {
        switch self {
        case .agent, .ai, .bot: true
        case .contact, .system: false
        }
    }
}

/// A file hanging off a message — a photo, a voice note, a document.
///
/// Deliberately carries no URL. The server streams the bytes through
/// `GET /api/conversation-attachments/:id/file` and never lets a storage
/// provider's own URL reach a client, so the id is the only handle there is
/// (`server/routes/conversationAttachments.ts`).
struct MessageAttachment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let fileName: String?
    let mimeType: String?
    let sizeBytes: Int?
    /// What the server decided this is, from the MIME type.
    let kind: String?

    enum CodingKeys: String, CodingKey {
        case id, kind
        case fileName = "file_name"
        case mimeType = "mime_type"
        case sizeBytes = "size_bytes"
    }

    /// How to draw it.
    enum Kind: String, Sendable {
        case image, audio, video, file
    }

    /// The server sends `kind`, but an older row or a new channel might not,
    /// so the MIME type is the fallback and `file` is the floor — a card with
    /// a name on it is never wrong.
    var resolvedKind: Kind {
        if let kind, let known = Kind(rawValue: kind) { return known }
        let mime = mimeType ?? ""
        if mime.hasPrefix("image/") { return .image }
        if mime.hasPrefix("audio/") { return .audio }
        if mime.hasPrefix("video/") { return .video }
        return .file
    }

    /// A name worth showing. Some channels send a bare extension as the file
    /// name — a widget voice note arrives called `m4a` — and a card labelled
    /// "m4a" tells the operator nothing.
    var displayName: String? {
        let trimmed = (fileName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.contains("."), trimmed.count > 4 else { return nil }
        return trimmed
    }
}

struct Message: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let conversationId: String
    let senderType: SenderType
    let senderId: String?
    let body: String
    let createdAt: Date?
    /// When the server last changed this row — its metadata, its files, its
    /// seen state. Nil from a server not migrated yet and on a realtime row,
    /// which is the row as inserted. It is what decides which of two copies of
    /// one message is the newer (`ThreadSync`).
    let updatedAt: Date?
    let senderName: String?
    let senderAvatar: String?
    /// Server bookkeeping. For a system notice this is what the sentence has
    /// to be rebuilt from, because `body` is English and cannot change.
    let metadata: [String: JSONValue]?
    /// Files on this message. One inbound channel message can carry several —
    /// a WhatsApp album, a Telegram document with a caption.
    let attachments: [MessageAttachment]?

    enum CodingKeys: String, CodingKey {
        case id
        case conversationId = "conversation_id"
        case senderType = "sender_type"
        case senderId = "sender_id"
        case body
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case senderName = "sender_name"
        case senderAvatar = "sender_avatar"
        case metadata, attachments
    }

    init(
        id: String,
        conversationId: String,
        senderType: SenderType,
        senderId: String?,
        body: String,
        createdAt: Date?,
        updatedAt: Date? = nil,
        senderName: String?,
        senderAvatar: String?,
        metadata: [String: JSONValue]? = nil,
        attachments: [MessageAttachment]? = nil
    ) {
        self.id = id
        self.conversationId = conversationId
        self.senderType = senderType
        self.senderId = senderId
        self.body = body
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.senderName = senderName
        self.senderAvatar = senderAvatar
        self.metadata = metadata
        self.attachments = attachments
    }

    /// The idempotency key the sender chose, which the server keeps in the
    /// row's metadata. It is how a message this phone sent is recognised when
    /// it comes back — by a read, by realtime or by both — so it is shown once.
    var clientMessageID: String? {
        metadata?["client_message_id"]?.stringValue
    }

    /// This row, with what it lacks taken from an older copy of itself.
    ///
    /// A realtime row is the message as inserted: no sender name, no photo,
    /// and no files yet. Showing it bare over a copy that had them would make
    /// the bubble lose its face for the moment until the next read.
    func filling(from older: Message) -> Message {
        Message(
            id: id,
            conversationId: conversationId,
            senderType: senderType,
            senderId: senderId ?? older.senderId,
            body: body,
            createdAt: createdAt ?? older.createdAt,
            updatedAt: updatedAt ?? older.updatedAt,
            senderName: senderName ?? older.senderName,
            senderAvatar: senderAvatar ?? older.senderAvatar,
            metadata: metadata ?? older.metadata,
            attachments: attachments ?? older.attachments
        )
    }

    /// Whether this message is nothing but its files. The text bubble is
    /// skipped entirely for these — an empty rounded rectangle beside a photo
    /// is the bug this was.
    var isAttachmentOnly: Bool {
        body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !(attachments ?? []).isEmpty
    }
}

// MARK: - Response envelopes

struct LoginResponse: Decodable, Sendable {
    let sessionToken: String?
    let user: User?
}

struct SessionResponse: Decodable, Sendable {
    let user: User?
}

struct WorkspacesResponse: Decodable, Sendable {
    let workspaces: [Workspace]
}

struct ConversationsResponse: Decodable, Sendable {
    let conversations: [Conversation]
}

struct MessagesResponse: Decodable, Sendable {
    let messages: [Message]
    /// How the server answered a `?since=` read. Absent from a server that
    /// predates incremental sync, which is read as "the whole thread, no
    /// cursor" — exactly what it sent.
    let sync: MessageSyncInfo?
}

/// `sync` on the thread response (`server/services/messageSync.ts`).
struct MessageSyncInfo: Decodable, Sendable, Equatable {
    /// `delta`: only rows created or changed since the cursor sent. Anything
    /// else is the whole thread.
    let mode: String?
    /// The cursor to send next time; nil until the server's database has
    /// `updated_at`, in which case every read stays a whole one.
    let cursor: String?
}

/// `GET /api/conversations/:id` — one conversation in the list's own shape.
struct ConversationResponse: Decodable, Sendable {
    let conversation: Conversation
}

struct ContactsResponse: Decodable, Sendable {
    let contacts: [Contact]
}

/// The shape the API uses for every failure.
struct ErrorResponse: Decodable, Sendable {
    let error: String?
    let passwordSetupRequired: Bool?
}

/// Just enough of a JSON value to read a handful of keys out of a free-form
/// object without modelling the whole thing.
///
/// `metadata` carries server bookkeeping that changes independently of the
/// app; decoding it into a concrete struct would break the whole response the
/// first time a field was added.
enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode([String: JSONValue].self) { self = .object(value); return }
        if let value = try? container.decode([JSONValue].self) { self = .array(value); return }
        self = .null
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// A whole number, whether the server sent it as one or as a string.
    /// Postgres `jsonb` round-trips both, depending on who wrote the row.
    var intValue: Int? {
        switch self {
        // `Int(someDouble)` traps on NaN and on anything past `Int.max`, and
        // this value came off the wire.
        case .number(let value): Int(exactly: value.rounded())
        case .string(let value): Int(value)
        default: nil
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let value) = self { return value[key] }
        return nil
    }
}
