import Foundation

// The server is the schema of record. These mirror the responses the web
// console, the iOS app and the Windows app already read, field for field
// (windows-native/src/Webyar.Core/Api/Models*.cs), so no client disagrees
// about what a conversation is. Everything optional stays optional: an older
// server that omits a field must not break decoding.

struct User: Codable, Hashable, Sendable {
    var id: String
    var email: String?
    var fullName: String?
    var emailVerified: Bool?
}

struct Workspace: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var slug: String?
    var logoUrl: String?

    init(id: String, name: String, slug: String? = nil, logoUrl: String? = nil) {
        self.id = id
        self.name = name
        self.slug = slug
        self.logoUrl = logoUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        slug = try? c.decodeIfPresent(String.self, forKey: .slug)
        logoUrl = try? c.decodeIfPresent(String.self, forKey: .logoUrl)
    }
}

struct ConversationContact: Codable, Hashable, Sendable {
    var name: String?
    var email: String?
    var avatarUrl: String?
    var visitorCode: String?
}

struct MessagePreview: Codable, Hashable, Sendable {
    var body: String?
    var createdAt: Date?
    var senderType: String?
    var senderName: String?
    var attachmentKind: String?
    var systemKind: String?
}

enum SenderType {
    static let agent = "agent"
    static let contact = "contact"
    static let ai = "ai"
    static let bot = "bot"
    static let system = "system"

    static func isOperatorSide(_ t: String?) -> Bool { t == agent || t == ai || t == bot }
}

enum ConversationStatus {
    static let open = "open"
    static let pending = "pending"
    static let resolved = "resolved"
    static let closed = "closed"
}

enum ConversationPriority {
    static let low = "low"
    static let normal = "normal"
    static let high = "high"
    static let urgent = "urgent"
    static let all = [low, normal, high, urgent]
}

struct Conversation: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var workspaceId: String
    var status: String
    var contactId: String?
    var subject: String?
    var assignedTo: String?
    var priority: String?
    var tags: [String]?
    var createdAt: Date?
    var updatedAt: Date?
    var contacts: ConversationContact?
    var lastMessage: MessagePreview?
    @Lenient var unreadCount: Int? = nil
    var aiState: String?
    var metadata: JSONValue?
    /// Marked as spam: in the Spam queue, and the AI does not answer it.
    var isSpam: Bool?

    // Filled in from the visitor's network profile (not part of the response).
    var visitorOs: String?
    var visitorDevice: String?
    var visitorCountryCode: String?
    var visitorCountryName: String?
    var visitorCity: String?
    var visitorRegion: String?

    /// When anything last happened, for sorting and "5m ago".
    var lastActivity: Date? { lastMessage?.createdAt ?? updatedAt ?? createdAt }

    /// ai_managed, needs_human or human_active — metadata.ai_state first, as
    /// the iOS app and the web read it, then the column.
    var aiStateValue: String? { metadata?["ai_state"]?.string ?? aiState }

    /// The AI is answering this visitor: the operator steers it instead of writing directly.
    var isAiManaged: Bool { aiStateValue == "ai_managed" }

    var isResolved: Bool { status == ConversationStatus.resolved || status == ConversationStatus.closed }

    private static let channels = ["telegram", "bale", "whatsapp", "instagram", "x", "email", "phone", "widget"]

    /// Where the visitor wrote from, as the web's resolveChannelKey reads it:
    /// metadata.channel, else metadata.source, else the chat widget.
    var channelKey: String {
        for key in ["channel", "source"] {
            if let raw = metadata?[key]?.string?.lowercased(), Self.channels.contains(raw) { return raw }
        }
        return "widget"
    }
}

struct MessageAttachment: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var fileName: String?
    var mimeType: String?
    @Lenient var sizeBytes: Int64? = nil
    var kind: String?

    init(id: String, fileName: String? = nil, mimeType: String? = nil, sizeBytes: Int64? = nil, kind: String? = nil) {
        self.id = id
        self.fileName = fileName
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.kind = kind
    }
}

struct Message: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var conversationId: String?
    var senderType: String
    var body: String
    var senderId: String?
    var createdAt: Date?
    var senderName: String?
    var senderAvatar: String?
    var attachments: [MessageAttachment]?
    var metadata: JSONValue?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        conversationId = try? c.decodeIfPresent(String.self, forKey: .conversationId)
        senderType = (try? c.decodeIfPresent(String.self, forKey: .senderType)) ?? SenderType.contact
        body = (try? c.decodeIfPresent(String.self, forKey: .body)) ?? ""
        senderId = try? c.decodeIfPresent(String.self, forKey: .senderId)
        createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
        senderName = try? c.decodeIfPresent(String.self, forKey: .senderName)
        senderAvatar = try? c.decodeIfPresent(String.self, forKey: .senderAvatar)
        attachments = try? c.decodeIfPresent([MessageAttachment].self, forKey: .attachments)
        metadata = try? c.decodeIfPresent(JSONValue.self, forKey: .metadata)
    }

    /// Operator-side messages sit on the trailing edge of the thread.
    var isOutgoing: Bool { SenderType.isOperatorSide(senderType) }
    var isSystem: Bool { senderType == SenderType.system }
}

struct SidebarCounts: Codable, Hashable, Sendable {
    @Lenient var main: Int? = nil
    @Lenient var automated: Int? = nil
    @Lenient var needsHuman: Int? = nil
    @Lenient var spam: Int? = nil
}

struct InboxCounts: Codable, Hashable, Sendable {
    @Lenient var open: Int? = nil
    @Lenient var pending: Int? = nil
    @Lenient var resolved: Int? = nil
    @Lenient var all: Int? = nil
    @Lenient var needsHuman: Int? = nil
    @Lenient var automated: Int? = nil
}

struct NotificationPrefs: Codable, Hashable, Sendable {
    var disableAll: Bool = false
    var pushScope: String = "all"
    var pushPreview: Bool = true
    var playSound: Bool = true
    var quietHoursEnabled: Bool = false
    var quietHoursStart: String?
    var quietHoursEnd: String?
    var quietHoursTimezone: String?

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        disableAll = (try? c.decodeIfPresent(Bool.self, forKey: .disableAll)) ?? false
        pushScope = (try? c.decodeIfPresent(String.self, forKey: .pushScope)) ?? "all"
        pushPreview = (try? c.decodeIfPresent(Bool.self, forKey: .pushPreview)) ?? true
        playSound = (try? c.decodeIfPresent(Bool.self, forKey: .playSound)) ?? true
        quietHoursEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .quietHoursEnabled)) ?? false
        quietHoursStart = try? c.decodeIfPresent(String.self, forKey: .quietHoursStart)
        quietHoursEnd = try? c.decodeIfPresent(String.self, forKey: .quietHoursEnd)
        quietHoursTimezone = try? c.decodeIfPresent(String.self, forKey: .quietHoursTimezone)
    }
}

struct RealtimeConnect: Codable, Sendable {
    var vendor: String
    var wsUrl: String?
    var token: String?
    @Lenient var expiresAt: Int64? = nil
}

struct RealtimeSubscribe: Codable, Sendable {
    var vendor: String
    var channel: String?
    var token: String?
    @Lenient var expiresAt: Int64? = nil
}

/// The inbox queues, as the web console and the other apps split them.
enum InboxFilter: String, CaseIterable, Sendable {
    case open = "Open"
    case needsHuman = "NeedsHuman"
    case pending = "Pending"
    case ai = "Ai"
    case resolved = "Resolved"
    case spam = "Spam"
}

// MARK: - People, notes, contacts, colleagues, saved replies, calls

struct MemberProfile: Codable, Hashable, Sendable {
    var id: String?
    var fullName: String?
    var email: String?
    var avatarUrl: String?
}

struct WorkspaceMember: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var userId: String
    var role: String?
    var suspendedAt: Date?
    var profile: MemberProfile?
    var departmentNames: [String]?

    var displayName: String {
        if let n = profile?.fullName, !n.isEmpty { return n }
        return profile?.email ?? userId
    }
}

struct ConversationNote: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var body: String
    var authorId: String?
    var author: MemberProfile?
    var createdAt: Date?
}

struct Contact: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var workspaceId: String?
    var name: String?
    var email: String?
    var phone: String?
    var avatarUrl: String?
    var visitorCode: String?
    var createdAt: Date?
    var updatedAt: Date?
    var notes: String?
    var tags: [String]?
    var metadata: JSONValue?

    /// metadata.company | org | organization, as the web contacts table reads it.
    var company: String? { metaString("company") ?? metaString("org") ?? metaString("organization") }

    func metaString(_ key: String) -> String? { metadata?[key]?.text }
}

/// One of a contact's conversations, from /api/contacts/:id/conversations.
struct ContactConversation: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var status: String?
    var subject: String?
    var aiState: String?
    var createdAt: Date?
    var updatedAt: Date?
    var handledByAi: Bool?
    var handledByOperator: Bool?
    var operatorName: String?
    var operatorAvatar: String?
    var lastMessageBody: String?
    @Lenient var messageCount: Int? = nil
}

/// A call with the contact, from /api/workspace-integrations/:ws/contacts/:id/calls.
struct ContactCall: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var callType: String?
    var direction: String?
    var state: String?
    @Lenient var durationSeconds: Int? = nil
    @Lenient var waitSeconds: Int? = nil
    var createdAt: Date?
    var agentName: String?
    var agentAvatar: String?
    var recordingAvailable: Bool?
    var conversationId: String?
}

struct VisitorGeo: Codable, Hashable, Sendable {
    var countryCode: String?
    var country: String?
    var city: String?
    var region: String?
}

struct VisitorDevice: Codable, Hashable, Sendable {
    var browser: String?
    var os: String?
    var device: String?
}

struct VisitorProfile: Codable, Hashable, Sendable {
    var geo: VisitorGeo?
    var device: VisitorDevice?
}

struct ColleagueLastMessage: Codable, Hashable, Sendable {
    var body: String?
    var createdAt: Date?
    var outgoing: Bool?
    var attachmentKind: String?
}

struct Colleague: Codable, Hashable, Sendable, Identifiable {
    var userId: String
    var role: String?
    var fullName: String?
    var email: String?
    var avatarUrl: String?
    @Lenient var unread: Int? = nil
    var lastMessage: ColleagueLastMessage?

    var id: String { userId }

    var displayName: String {
        if let n = fullName, !n.isEmpty { return n }
        return email ?? userId
    }
}

struct ColleaguesResponse: Codable, Sendable {
    var colleagues: [Colleague]?
    @Lenient var totalUnread: Int? = nil
    var me: String?
}

struct TeamMessage: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var senderId: String
    var recipientId: String?
    var body: String?
    var attachment: MessageAttachment?
    var readAt: Date?
    var createdAt: Date?
}

struct TeamThread: Codable, Sendable {
    var messages: [TeamMessage]?
    var me: String?
}

struct CannedResponse: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var shortcut: String
    var title: String
    var body: String
    var locale: String?
    @Lenient var usageCount: Int? = nil
}

struct CallInvitation: Codable, Hashable, Sendable {
    var id: String
    var status: String?
    var channel: String?
    var callSessionId: String?
    var conversationId: String?
    var expiresAt: Date?
}

struct TurnServer: Codable, Hashable, Sendable {
    var urls: [String]?
    var username: String?
    var credential: String?
}

struct CallToken: Codable, Hashable, Sendable {
    var token: String
    var provider: String?
    var wsUrl: String?
    var rtcUrl: String?
    var turn: TurnServer?
    var icePolicy: String?
    var warnings: [String]?
}

/// An ad or announcement from Super Admin → Desktop app, already in one locale.
struct DesktopCampaign: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var kind: String
    var placements: [String]?
    var title: String?
    var body: String?
    var ctaLabel: String?
    var ctaUrl: String?
    var imageUrl: String?
    var severity: String?
    var dismissible: Bool = true
    @Lenient var priority: Int? = nil
    var endsAt: Date?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "ad"
        placements = try? c.decodeIfPresent([String].self, forKey: .placements)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        body = try? c.decodeIfPresent(String.self, forKey: .body)
        ctaLabel = try? c.decodeIfPresent(String.self, forKey: .ctaLabel)
        ctaUrl = try? c.decodeIfPresent(String.self, forKey: .ctaUrl)
        imageUrl = try? c.decodeIfPresent(String.self, forKey: .imageUrl)
        severity = try? c.decodeIfPresent(String.self, forKey: .severity)
        dismissible = (try? c.decodeIfPresent(Bool.self, forKey: .dismissible)) ?? true
        _priority = try c.decode(Lenient<Int>.self, forKey: .priority)
        endsAt = try? c.decodeIfPresent(Date.self, forKey: .endsAt)
    }

    var isAnnouncement: Bool { kind == "announcement" }
    func shows(_ placement: String) -> Bool { placements?.contains(placement) == true }
}

struct DesktopBroadcast: Codable, Hashable, Sendable, Identifiable {
    var id: String
    @Lenient var seq: Int64? = nil
    var title: String
    var body: String?
    var severity: String?
    var url: String?
    var createdAt: Date?
}

struct DesktopHeartbeat: Codable, Sendable {
    @Lenient var intervalSeconds: Int? = nil
    @Lenient var latestSeq: Int64? = nil
    var broadcasts: [DesktopBroadcast]?
}

// MARK: - Account and presence

/// `GET /api/account/me` — the signed-in operator, with the photo the server already resolved to a URL.
struct Account: Codable, Hashable, Sendable {
    var id: String
    var email: String?
    var profile: AccountProfile?

    var avatarUrl: String? { profile?.avatarUrl }
}

struct AccountProfile: Codable, Hashable, Sendable {
    var fullName: String?
    var avatarUrl: String?
}

/// The operator's own availability (`/api/availability`), exactly as the web
/// console stores it.
struct AvailabilityPrefs: Codable, Hashable, Sendable {
    var forceOffline: Bool?
    var availableWhenUsingApp: Bool?
    var scheduleEnabled: Bool?
    var timezone: String?
}

struct AvailabilityStatus: Codable, Hashable, Sendable {
    var state: String
    var reason: String?

    var isOnline: Bool { state == "online" }
}

struct Availability: Codable, Hashable, Sendable {
    var prefs: AvailabilityPrefs
    var status: AvailabilityStatus
}

enum PresenceState {
    static let active = "active"
    static let away = "away"
    static let disconnected = "disconnected"
    static let offline = "offline"
}

/// One teammate in `GET /api/availability/team/:workspaceId`.
struct TeamPresence: Codable, Hashable, Sendable {
    var userId: String
    var state: String?
    var presenceState: String?
    var customerAvailability: String?
    var manual: String?
    var connected: Bool?
    var reason: String?
    var lastSeenAt: Date?
    var lastActivityAt: Date?
    var fullName: String?
    var email: String?
    var avatarUrl: String?

    /// Older servers only send online/offline; online then means active.
    var effective: String { presenceState ?? (state == "online" ? PresenceState.active : PresenceState.offline) }
}

// MARK: - Visitors (`/api/visitor-intel`), as the web Visitors page reads them

struct VisitorGeoInfo: Codable, Hashable, Sendable {
    var country: String?
    var countryCode: String?
    var region: String?
    var city: String?
    @Lenient var latitude: Double? = nil
    @Lenient var longitude: Double? = nil
    var source: String?
}

struct VisitorContact: Codable, Hashable, Sendable {
    var id: String
    var name: String?
    var email: String?
    var avatarUrl: String?
    var visitorCode: String?
    var metadata: JSONValue?

    /// The short code the widget gave this visitor, as the web resolves it.
    var code: String? {
        if let c = visitorCode?.trimmingCharacters(in: .whitespaces), !c.isEmpty { return c }
        return metadata?["anon_code"]?.text
    }
}

struct VisitorConversation: Codable, Hashable, Sendable {
    var id: String
    var status: String?
    var subject: String?
}

/// One live visitor session. `id` is the session id, the key everywhere.
struct LiveVisitor: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var visitorId: String?
    var workspaceId: String?
    var status: String?
    var currentPage: String?
    var lastActivityAt: Date?
    var startedAt: Date?
    var browser: String?
    var device: String?
    var os: String?
    var referrer: String?
    var geo: VisitorGeoInfo?
    var ipDisplay: String?
    var ipLocked: Bool?
    var contact: VisitorContact?
    var conversation: VisitorConversation?
}

struct PageView: Codable, Hashable, Sendable, Identifiable {
    @Lenient var rawId: Int64? = nil
    var url: String?
    var title: String?
    var viewedAt: Date?

    var id: String { "\(rawId ?? 0)-\(url ?? "")-\(viewedAt?.timeIntervalSince1970 ?? 0)" }

    enum CodingKeys: String, CodingKey {
        case rawId = "id"
        case url, title, viewedAt
    }
}

struct PageEntry: Codable, Hashable, Sendable {
    var landingUrl: String?
    var landingTitle: String?
    var landedAt: Date?
    var referrer: String?
}

struct PageHistory: Codable, Sendable {
    var items: [PageView]?
    var entry: PageEntry?
    var current: PageView?
}

struct StartChatResult: Codable, Sendable {
    var ok: Bool?
    var conversationId: String?
    var created: Bool?
}

// MARK: - Call center (`/api/call-center`)

struct CallSession: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var workspaceId: String?
    var state: String?
    var callType: String?
    var visitorName: String?
    var visitorEmail: String?
    var visitorPhone: String?
    var subject: String?
    var pageUrl: String?
    var pageTitle: String?
    var createdAt: Date?
    var endedAt: Date?
    @Lenient var durationSeconds: Int? = nil
    var endReason: String?
    var visitorSessionId: String?
    var contactId: String?
    var assignedAgentId: String?
    /// Set by a transfer: who handed the call on, and why.
    var transferFromAgentId: String?
    var transferReason: String?
    var metadata: JSONValue?

    var isVideo: Bool { callType == "video" }

    /// Marked as spam on the desk (`metadata.spam`).
    var isSpam: Bool {
        guard let v = metadata?["spam"] else { return false }
        if case .null = v { return false }
        return true
    }
}

struct QueueEntry: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var callSessionId: String
    var state: String?
    var channel: String?
    @Lenient var priority: Int? = nil
    var createdAt: Date?
    var visitorSessionId: String?
    var contactId: String?
    var conversationId: String?
    var offeredToUserId: String?
    var assignedAgentId: String?
    var callSession: CallSession?

    var isVideo: Bool { channel == "video" || callSession?.isVideo == true }
}

struct CallProvider: Codable, Hashable, Sendable {
    var provider: String?
    var ready: Bool?
    var error: String?
}

struct CallCenterOverview: Codable, Hashable, Sendable {
    @Lenient var todayCalls: Int? = nil
    @Lenient var waitingCalls: Int? = nil
    @Lenient var activeCalls: Int? = nil
    @Lenient var missedToday: Int? = nil
    @Lenient var callbacksPending: Int? = nil
    var provider: CallProvider?
}

struct AgentCallStatus: Codable, Hashable, Sendable {
    var userId: String
    var status: String?
}

struct CallConnect: Codable, Hashable, Sendable {
    var supported: Bool?
    var provider: String?
    var serverUrl: String?
    var roomId: String?
    var identity: String?
    var reason: String?
}

/// `POST /api/call-center/calls/:id/accept`: a LiveKit token for the operator.
struct CallAccept: Codable, Hashable, Sendable {
    var ok: Bool?
    var provider: String?
    var providerRoomId: String?
    var token: String?
    var takeover: Bool?
    var connect: CallConnect?
}

struct CallEvent: Codable, Hashable, Sendable {
    var id: String?
    var eventType: String?
    var actorType: String?
    var createdAt: Date?
}

struct CallDetail: Codable, Sendable {
    var call: CallSession
    var events: [CallEvent]?
}

/// `GET /api/call-center/agents/presence`: an operator the transfer menu can offer.
struct CallAgentPresence: Codable, Hashable, Sendable {
    var userId: String
    /// available | busy | away | offline
    var status: String?
    @Lenient var activeCallCount: Int? = nil
    var fullName: String?
    var email: String?
}

/// `GET /api/call-center/departments`: a department a call can be handed to.
struct CallDepartment: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String?
    var enabled: Bool?
    var ccVoiceEnabled: Bool?
    var ccVideoEnabled: Bool?
}

struct CallNote: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var note: String
    var authorName: String?
    var createdAt: Date?
}
