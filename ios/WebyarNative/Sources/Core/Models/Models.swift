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

    enum CodingKeys: String, CodingKey { case id, name, slug }
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
struct MessagePreview: Codable, Hashable, Sendable {
    let body: String?
    let createdAt: Date?
    let senderType: String?

    enum CodingKeys: String, CodingKey {
        case body
        case createdAt = "created_at"
        case senderType = "sender_type"
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
        case subject, status, priority
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

struct Message: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let conversationId: String
    let senderType: SenderType
    let senderId: String?
    let body: String
    let createdAt: Date?
    let senderName: String?
    let senderAvatar: String?

    enum CodingKeys: String, CodingKey {
        case id
        case conversationId = "conversation_id"
        case senderType = "sender_type"
        case senderId = "sender_id"
        case body
        case createdAt = "created_at"
        case senderName = "sender_name"
        case senderAvatar = "sender_avatar"
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

    subscript(key: String) -> JSONValue? {
        if case .object(let value) = self { return value[key] }
        return nil
    }
}
