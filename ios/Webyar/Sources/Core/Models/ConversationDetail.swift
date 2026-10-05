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
    /// Only set once the visitor has accepted: the invitation is the offer,
    /// the session is the call. Everything after this point keys off the
    /// session, not the invitation.
    let callSessionId: String?
    let expiresAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, status, channel
        case conversationId = "conversation_id"
        case callSessionId = "call_session_id"
        case expiresAt = "expires_at"
    }

    var isPending: Bool { status == "pending" }
    var isJoined: Bool { status == "joined" }

    /// Statuses that mean this invitation will never become a call.
    var isTerminal: Bool {
        switch status {
        case "expired", "cancelled", "declined": true
        default: false
        }
    }

    var kind: CallChannel { CallChannel(rawValue: channel ?? "") ?? .audio }
}

/// Everything needed to join the media room, exactly as the operator console
/// receives it from `POST /api/calls/:id/token`.
struct CallToken: Codable, Sendable {
    let token: String
    let provider: String?
    /// The signalling URL. `rtc_url` is the fallback the web uses too.
    let wsURL: String?
    let rtcURL: String?
    let turn: TurnConfig?
    let icePolicy: String?
    /// Non-fatal notes from the server — `turn_missing` above all, which is
    /// the difference between a call that connects everywhere and one that
    /// connects on friendly networks.
    let warnings: [String]?

    struct TurnConfig: Codable, Sendable {
        let urls: [String]?
        let username: String?
        let credential: String?
    }

    enum CodingKeys: String, CodingKey {
        case token, provider, turn, warnings
        case wsURL = "ws_url"
        case rtcURL = "rtc_url"
        case icePolicy = "ice_policy"
    }

    /// The URL to actually dial. The server sends both and the web prefers
    /// `ws_url`; falling back keeps a workspace configured only with
    /// `rtc_url` working rather than failing with an empty address.
    var signallingURL: String? {
        if let wsURL, !wsURL.isEmpty { return wsURL }
        if let rtcURL, !rtcURL.isEmpty { return rtcURL }
        return nil
    }

    var relayOnly: Bool { icePolicy == "relay" }
}

struct CallInvitationResponse: Codable, Sendable {
    let invitation: CallInvitation
}

/// Which call channels this workspace may actually offer.
///
/// Mirrors `SidebarCallCard`'s gating exactly: the Voice & Video module and
/// the call's own channel, each exactly `true` in a snapshot that is in. A key
/// the plan does not carry is not available, and nothing is offered while the
/// snapshot loads or cannot be read — the server would refuse the call.
struct CallChannels: Sendable {
    let voice: Bool
    let video: Bool

    var any: Bool { voice || video }

    static func resolve(_ entitlements: Entitlements?) -> CallChannels {
        guard let entitlements, entitlements.moduleEnabled("voice_video") else {
            return CallChannels(voice: false, video: false)
        }
        return CallChannels(
            voice: entitlements.channelEnabled("voice"),
            video: entitlements.channelEnabled("video")
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
