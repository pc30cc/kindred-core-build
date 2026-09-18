import Foundation

/// A person in the workspace, as the transfer list needs them.
///
/// Mirrors `GET /api/workspace-members?workspaceId=…`, which is the same
/// list the web's assignee picker reads.
struct WorkspaceMember: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let userId: String
    let role: String?
    let suspendedAt: Date?
    let profile: MemberProfile?
    let departmentNames: [String]?

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case role
        case suspendedAt = "suspended_at"
        case profile
        case departmentNames = "department_names"
    }

    /// A suspended member can still be looked at but must never be handed a
    /// conversation — the server rejects it, and offering it would be a lie.
    var canReceiveWork: Bool { suspendedAt == nil }

    var displayName: String {
        if let name = profile?.fullName, !name.isEmpty { return name }
        if let email = profile?.email, !email.isEmpty { return email }
        return String(userId.prefix(8))
    }
}

struct MemberProfile: Codable, Hashable, Sendable {
    let id: String?
    let fullName: String?
    let email: String?
    let avatarURL: String?

    enum CodingKeys: String, CodingKey {
        case id
        case fullName = "full_name"
        case email
        case avatarURL = "avatar_url"
    }
}

struct WorkspaceMembersResponse: Codable, Sendable {
    let members: [WorkspaceMember]
}

/// An internal note — visible to the team, never to the visitor.
///
/// `GET`/`POST /api/conversations/:id/notes`.
struct ConversationNote: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let body: String
    let authorId: String?
    let author: MemberProfile?
    let createdAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, body, author
        case authorId = "author_id"
        case createdAt = "created_at"
    }

    var authorName: String {
        if let name = author?.fullName, !name.isEmpty { return name }
        if let email = author?.email, !email.isEmpty { return email }
        return ""
    }
}

struct NotesResponse: Codable, Sendable {
    let notes: [ConversationNote]
}

struct NoteResponse: Codable, Sendable {
    let note: ConversationNote?
}

/// An invitation asking the visitor to join a call.
///
/// The operator never dials the visitor directly: the web invites, the widget
/// accepts, and only then does a room exist. `POST /api/call-invitations`.
struct CallInvitation: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let status: String?
    let channel: String?
    let conversationId: String?
    let expiresAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, status, channel
        case conversationId = "conversation_id"
        case expiresAt = "expires_at"
    }

    var isPending: Bool { status == "pending" }
}

struct CallInvitationResponse: Codable, Sendable {
    let invitation: CallInvitation
}

/// Which call channels this workspace may actually offer.
///
/// Mirrors `SidebarCallCard`'s gating exactly, including its "not explicitly
/// false" reading: a key the plan has never heard of is allowed, and only a
/// resolved `false` closes the door. The server enforces the same rule on
/// create, so the two can never drift into offering a button that 403s.
struct CallChannels: Sendable {
    let voice: Bool
    let video: Bool

    var any: Bool { voice || video }

    static func resolve(_ entitlements: Entitlements?) -> CallChannels {
        guard let entitlements else { return CallChannels(voice: false, video: false) }
        let moduleOn = entitlements.modules?["voice_video"]?.value != false
        guard moduleOn else { return CallChannels(voice: false, video: false) }
        return CallChannels(
            voice: entitlements.channels?["voice"]?.value != false,
            video: entitlements.channels?["video"]?.value != false
        )
    }
}

/// Which kind of call an invitation asks for. The server's own spelling.
enum CallChannel: String, Codable, Sendable, CaseIterable, Identifiable {
    case audio, video

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .audio: "phone.fill"
        case .video: "video.fill"
        }
    }
}
