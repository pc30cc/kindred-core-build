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

        enum CodingKeys: String, CodingKey {
            case body
            case createdAt = "created_at"
            case outgoing
            case attachmentKind = "attachment_kind"
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

    enum CodingKeys: String, CodingKey {
        case id
        case senderId = "sender_id"
        case recipientId = "recipient_id"
        case body
        case attachment
        case readAt = "read_at"
        case createdAt = "created_at"
    }
}

struct TeamThreadResponse: Decodable, Sendable {
    let messages: [TeamMessage]
    let me: String?
}
