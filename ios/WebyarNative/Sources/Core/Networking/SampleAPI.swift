// Compiled only into Debug builds — see Backend in WebyarAPI.swift.
#if DEBUG
import Foundation

/// A backend that answers from memory.
///
/// It exists so every screen can be laid out, reviewed and screenshotted
/// without a live server or a real account. The content is deliberately
/// awkward rather than tidy — very long names, mixed Persian and Latin in one
/// thread, an empty preview, a 3-digit unread count — because a layout only
/// proves itself against the cases that break it, not against neat sample
/// rows that fit by luck.
actor SampleAPI: WebyarAPI {

    private var statuses: [String: ConversationStatus] = [:]
    private var sampleTags: [String: [String]] = [:]
    private var sampleNotes: [String: [ConversationNote]] = [:]
    private var extraMessages: [String: [Message]] = [:]

    var hasToken: Bool { true }

    // MARK: - Auth

    func logIn(email: String, password: String) async throws -> User { Self.user }
    func currentUser() async throws -> User { Self.user }
    func logOut() async throws {}
    func discardSession() {}
    func requestPasswordReset(email: String) async throws {}

    private static let user = User(
        id: "u-1",
        email: "operator@webyar.app",
        fullName: "Sara Karimi",
        emailVerified: true
    )

    // MARK: - Workspaces

    func workspaces() async throws -> [Workspace] {
        [Workspace(id: "ws-1", name: "Destekly", slug: "destekly")]
    }

    // MARK: - Conversations

    func conversations(workspaceID: String, filter: InboxFilter) async throws -> [Conversation] {
        // A visible delay would only make the skeleton harder to screenshot.
        let all = Self.conversations.map { conversation -> Conversation in
            guard let overridden = statuses[conversation.id] else { return conversation }
            return conversation.with(status: overridden)
        }

        return switch filter {
        case .open: all.filter { $0.status == .open || $0.status == .pending }
        case .needsHuman: all.filter { ($0.status == .open || $0.status == .pending) && $0.assignedTo == nil }
        case .resolved: all.filter { $0.status == .resolved || $0.status == .closed }
        case .ai: all.filter { $0.lastMessage?.senderType == "ai" }
        }
    }

    func messages(conversationID: String) async throws -> [Message] {
        (Self.messages[conversationID] ?? []) + (extraMessages[conversationID] ?? [])
    }

    func send(body: String, conversationID: String, workspaceID: String, clientMessageID: String) async throws {
        extraMessages[conversationID, default: []].append(
            Message(
                id: clientMessageID,
                conversationId: conversationID,
                senderType: .agent,
                senderId: Self.user.id,
                body: body,
                createdAt: Date(),
                senderName: Self.user.fullName,
                senderAvatar: nil
            )
        )
    }

    func markSeen(conversationID: String) async throws {}

    func setStatus(_ status: ConversationStatus, conversationID: String, workspaceID: String) async throws {
        statuses[conversationID] = status
    }

    func contacts(workspaceID: String) async throws -> [Contact] { Self.contacts }

    func claim(conversationID: String, workspaceID: String) async throws {}

    func updateConversation(
        conversationID: String,
        workspaceID: String,
        status: ConversationStatus?,
        priority: ConversationPriority?,
        assignedTo: String??,
        tags: [String]?
    ) async throws {
        if let status { statuses[conversationID] = status }
        if let tags { sampleTags[conversationID] = tags }
    }

    func workspaceMembers(workspaceID: String) async throws -> [WorkspaceMember] {
        [
            WorkspaceMember(
                id: "m-1", userId: "u-1", role: "owner", suspendedAt: nil,
                profile: MemberProfile(id: "u-1", fullName: "Sara Karimi",
                                       email: "operator@webyar.app", avatarURL: nil),
                departmentNames: ["Support"]
            ),
            WorkspaceMember(
                id: "m-2", userId: "u-2", role: "agent", suspendedAt: nil,
                profile: MemberProfile(id: "u-2", fullName: "Emre Demir",
                                       email: "emre@webyar.app", avatarURL: nil),
                departmentNames: ["Sales"]
            ),
        ]
    }

    func notes(conversationID: String, workspaceID: String) async throws -> [ConversationNote] {
        sampleNotes[conversationID] ?? []
    }

    func addNote(conversationID: String, workspaceID: String, body: String) async throws {
        var existing = sampleNotes[conversationID] ?? []
        existing.append(
            ConversationNote(
                id: UUID().uuidString,
                body: body,
                authorId: "u-1",
                author: MemberProfile(id: "u-1", fullName: "Sara Karimi",
                                      email: "operator@webyar.app", avatarURL: nil),
                createdAt: Date()
            )
        )
        sampleNotes[conversationID] = existing
    }

    func deleteNote(conversationID: String, workspaceID: String, noteID: String) async throws {
        sampleNotes[conversationID]?.removeAll { $0.id == noteID }
    }

    func inviteToCall(
        conversationID: String,
        workspaceID: String,
        channel: CallChannel
    ) async throws -> CallInvitation {
        CallInvitation(
            id: UUID().uuidString,
            status: "pending",
            channel: channel.rawValue,
            conversationId: conversationID,
            // No session yet: the sample visitor "accepts" on the next poll.
            callSessionId: nil,
            expiresAt: Date().addingTimeInterval(60)
        )
    }

    func cancelInvitation(id: String) async throws {}

    /// The sample visitor always accepts, so the call screen can be laid out
    /// and screenshotted without a browser open somewhere.
    func invitation(id: String) async throws -> CallInvitation {
        CallInvitation(
            id: id, status: "joined", channel: "audio",
            conversationId: "c-1", callSessionId: "cs-\(id)",
            expiresAt: Date().addingTimeInterval(120)
        )
    }

    /// No room to join, so the sample call stops at "connecting" — which is
    /// the state worth being able to look at. Reaching "connected" needs a
    /// real visitor in a real room, and pretending otherwise would make this
    /// screen look finished when it had never carried a voice.
    func callToken(callSessionID: String, displayName: String?) async throws -> CallToken {
        CallToken(
            token: "sample", provider: "livekit",
            wsURL: nil, rtcURL: nil, turn: nil, icePolicy: "all",
            warnings: ["turn_missing"]
        )
    }

    func hangUp(callSessionID: String) async throws {}


    /// Gives each sample thread a different device and country so the avatar's
    /// OS-mark and flag paths are actually exercised.
    func visitorIntel(workspaceID: String, conversationIDs: [String]) async throws -> [String: VisitorProfile] {
        [
            "c-1": VisitorProfile(geo: .init(countryCode: "IR", country: "Iran", city: "Tehran"),
                                  device: .init(browser: "Safari", os: "iOS", device: "mobile")),
            "c-2": VisitorProfile(geo: .init(countryCode: "DE", country: "Germany", city: "Berlin"),
                                  device: .init(browser: "Chrome", os: "Windows", device: "desktop")),
            "c-3": VisitorProfile(geo: .init(countryCode: "TR", country: "Türkiye", city: "Istanbul"),
                                  device: .init(browser: "Chrome", os: "Android", device: "mobile")),
            "c-4": VisitorProfile(geo: .init(countryCode: "NL", country: "Netherlands", city: "Utrecht"),
                                  device: .init(browser: "Firefox", os: "Ubuntu", device: "desktop")),
            "c-6": VisitorProfile(geo: .init(countryCode: "US", country: "United States", city: "Austin"),
                                  device: .init(browser: "Safari", os: "macOS", device: "desktop")),
        ]
    }

    func inboxCounts(workspaceID: String, scope: String) async throws -> InboxCounts {
        InboxCounts(open: 4, pending: 0, resolved: 1, all: 6, needsHuman: 2, automated: 1)
    }

    // MARK: - Plan
    //
    // The sample plan turns everything on, because the point of sample mode is
    // to lay out every screen — including the ones a Free plan hides.

    func entitlements(workspaceID: String) async throws -> Entitlements {
        let on = EffectiveState<Bool>(value: true, source: "plan", note: nil)
        return Entitlements(
            workspaceId: workspaceID,
            features: [
                "inbox_ai_queue": on,
                "inbox_needs_human": on,
                "contact_notes": on,
                "contact_tags": on,
                // The three composer capabilities, so both states of the
                // composer can be laid out: granted-and-human-active shows the
                // controls, granted-but-AI-managed shows the notice instead.
                "widget_attachments": on,
                "widget_voice_notes": on,
                "widget_emoji": on,
            ],
            modules: [
                "chat": on,
                "contacts": on,
                "call_center": on,
                "visitor_tracking": on,
            ],
            channels: ["chat_widget": on],
            limits: [:],
            plan: Entitlements.PlanSummary(slug: "pro", name: "Pro", tier: "pro")
        )
    }

    // MARK: - Account

    private var profile: AccountProfile {
        AccountProfile(id: Self.user.id, fullName: Self.user.fullName,
                       avatarURL: nil, preferredLocale: "en")
    }

    func account() async throws -> Account {
        Account(id: Self.user.id, email: Self.user.email, phone: nil,
                emailConfirmedAt: "2026-01-01T00:00:00Z", createdAt: SampleAPI.ago(100000),
                profile: profile)
    }

    func updateProfile(fullName: String?, preferredLocale: String?) async throws -> Account {
        try await account()
    }

    func uploadAvatar(imageData: Data, contentType: String, fileName: String?) async throws -> AccountProfile? {
        profile
    }

    func deleteAvatar() async throws {}

    /// The sample backend has no files. A screenshot run that met one would
    /// draw the "could not load" card, which is the honest thing for a
    /// backend that genuinely has nothing to hand over.
    func attachmentData(id: String) async throws -> Data {
        throw APIError.server(status: 404, message: nil)
    }

    func sessions() async throws -> AccountSessionsResponse {
        AccountSessionsResponse(
            sessions: [
                AccountSession(id: "s-1", browser: "Webyar", os: "iOS 26", device: "iPhone",
                               ip: "—", city: "Istanbul", country: "Türkiye", countryCode: "TR",
                               isCurrent: true, createdAt: SampleAPI.ago(20), lastActiveAt: SampleAPI.ago(1)),
                AccountSession(id: "s-2", browser: "Chrome", os: "macOS", device: nil,
                               ip: "—", city: "Tehran", country: "Iran", countryCode: "IR",
                               isCurrent: false, createdAt: SampleAPI.ago(4000), lastActiveAt: SampleAPI.ago(300)),
            ],
            currentSessionId: "s-1"
        )
    }

    func revokeSession(id: String) async throws {}

    func changePassword(current: String, new: String) async throws {}

    // MARK: - Fixtures

    private static func ago(_ minutes: Int) -> Date {
        Date().addingTimeInterval(TimeInterval(-minutes * 60))
    }

    private static let conversations: [Conversation] = [
        Conversation(
            id: "c-1",
            workspaceId: "ws-1",
            contactId: "p-1",
            subject: nil,
            status: .open,
            assignedTo: nil,
            priority: .urgent,
            tags: [],
            createdAt: SampleAPI.ago(90),
            updatedAt: SampleAPI.ago(4),
            contact: ConversationContact(
                name: "مریم حسینی",
                email: "maryam@example.com",
                avatarURL: nil,
                visitorCode: nil
            ),
            lastMessage: MessagePreview(
                body: "سلام، سفارش من هنوز ارسال نشده. می‌تونید وضعیتش رو بررسی کنید؟",
                createdAt: SampleAPI.ago(4),
                senderType: "contact"
            ),
            unreadCount: 3,
            aiState: "human_active",
            metadata: nil
        ),
        Conversation(
            id: "c-2",
            workspaceId: "ws-1",
            contactId: "p-2",
            subject: nil,
            status: .open,
            assignedTo: "u-1",
            priority: .high,
            tags: [],
            createdAt: SampleAPI.ago(300),
            updatedAt: SampleAPI.ago(52),
            contact: ConversationContact(
                name: "Alexander Konstantinopoulos",
                email: "alexander.konstantinopoulos@verylongcompanyname.example",
                avatarURL: nil,
                visitorCode: nil
            ),
            // Deliberately long: proves the preview truncates at two lines
            // instead of pushing the timestamp or the badge out of the row.
            lastMessage: MessagePreview(
                body: "Thanks for getting back to me. I tried the steps you suggested but the export still fails at around 80% with a timeout, and it happens on both of our accounts.",
                createdAt: SampleAPI.ago(52),
                senderType: "contact"
            ),
            unreadCount: 128,
            aiState: "human_active",
            metadata: nil
        ),
        Conversation(
            id: "c-3",
            workspaceId: "ws-1",
            contactId: "p-3",
            subject: nil,
            status: .open,
            assignedTo: nil,
            priority: .normal,
            tags: [],
            createdAt: SampleAPI.ago(600),
            updatedAt: SampleAPI.ago(140),
            contact: ConversationContact(name: nil, email: nil, avatarURL: nil, visitorCode: "8F2C"),
            lastMessage: MessagePreview(
                body: "Merhaba, fiyatlandırma hakkında bilgi alabilir miyim?",
                createdAt: SampleAPI.ago(140),
                senderType: "contact"
            ),
            unreadCount: 0,
            aiState: nil,
            metadata: nil
        ),
        Conversation(
            id: "c-4",
            workspaceId: "ws-1",
            contactId: "p-4",
            subject: "Refund request",
            status: .open,
            assignedTo: nil,
            priority: .normal,
            tags: [],
            createdAt: SampleAPI.ago(1500),
            updatedAt: SampleAPI.ago(1400),
            contact: ConversationContact(
                name: "Deniz Yılmaz",
                email: "deniz@example.com",
                avatarURL: nil,
                visitorCode: nil
            ),
            // No body at all — the row must fall back to the subject rather
            // than render an empty second line.
            lastMessage: MessagePreview(body: "", createdAt: SampleAPI.ago(1400), senderType: "ai"),
            unreadCount: 0,
            aiState: "ai_managed",
            metadata: nil
        ),
        Conversation(
            id: "c-5",
            workspaceId: "ws-1",
            contactId: "p-5",
            subject: nil,
            status: .resolved,
            assignedTo: "u-1",
            priority: .normal,
            tags: [],
            createdAt: SampleAPI.ago(5000),
            updatedAt: SampleAPI.ago(4300),
            contact: ConversationContact(
                name: "Jonas Müller",
                email: "jonas@example.com",
                avatarURL: nil,
                visitorCode: nil
            ),
            lastMessage: MessagePreview(
                body: "Perfect, that fixed it. Thank you!",
                createdAt: SampleAPI.ago(4300),
                senderType: "contact"
            ),
            unreadCount: 0,
            aiState: "human_active",
            metadata: nil
        ),
        Conversation(
            id: "c-6",
            workspaceId: "ws-1",
            contactId: "p-6",
            subject: nil,
            status: .open,
            assignedTo: nil,
            priority: .normal,
            tags: [],
            createdAt: SampleAPI.ago(200),
            updatedAt: SampleAPI.ago(28),
            contact: ConversationContact(name: nil, email: nil, avatarURL: nil, visitorCode: "A19D"),
            lastMessage: MessagePreview(
                body: "Your order #48120 has shipped and should arrive on Thursday.",
                createdAt: SampleAPI.ago(28),
                senderType: "ai"
            ),
            unreadCount: 1,
            aiState: "ai_managed",
            metadata: nil
        ),
    ]

    private static let messages: [String: [Message]] = [
        "c-1": [
            Message(id: "m-1", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "سلام وقت بخیر", createdAt: SampleAPI.ago(95), senderName: nil, senderAvatar: nil),
            Message(id: "m-2", conversationId: "c-1", senderType: .ai, senderId: nil,
                    body: "سلام! چطور می‌تونم کمکتون کنم؟", createdAt: SampleAPI.ago(94),
                    senderName: nil, senderAvatar: nil),
            Message(id: "m-3", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "سفارش شمارهٔ ۴۸۱۲۰ رو دو هفته پیش ثبت کردم و هنوز چیزی به دستم نرسیده.",
                    createdAt: SampleAPI.ago(92), senderName: nil, senderAvatar: nil),
            Message(id: "m-4", conversationId: "c-1", senderType: .system, senderId: nil,
                    body: "Sara Karimi joined the conversation", createdAt: SampleAPI.ago(60),
                    senderName: nil, senderAvatar: nil),
            Message(id: "m-5", conversationId: "c-1", senderType: .agent, senderId: "u-1",
                    body: "سلام مریم جان، الان بررسی می‌کنم و چند لحظهٔ دیگر خبر می‌دهم.",
                    createdAt: SampleAPI.ago(58), senderName: "Sara Karimi", senderAvatar: nil),
            Message(id: "m-6", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "ممنون می‌شم", createdAt: SampleAPI.ago(10), senderName: nil, senderAvatar: nil),
            Message(id: "m-7", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "سلام، سفارش من هنوز ارسال نشده. می‌تونید وضعیتش رو بررسی کنید؟",
                    createdAt: SampleAPI.ago(4), senderName: nil, senderAvatar: nil),
        ],
        "c-2": [
            Message(id: "n-1", conversationId: "c-2", senderType: .contact, senderId: nil,
                    body: "Hi — we're hitting an issue exporting our reports.",
                    createdAt: SampleAPI.ago(320), senderName: nil, senderAvatar: nil),
            Message(id: "n-2", conversationId: "c-2", senderType: .agent, senderId: "u-1",
                    body: "Sorry about that. Could you tell me roughly how large the export is, and whether it fails at the same point every time?",
                    createdAt: SampleAPI.ago(300), senderName: "Sara Karimi", senderAvatar: nil),
            Message(id: "n-3", conversationId: "c-2", senderType: .contact, senderId: nil,
                    body: "Thanks for getting back to me. I tried the steps you suggested but the export still fails at around 80% with a timeout, and it happens on both of our accounts.",
                    createdAt: SampleAPI.ago(52), senderName: nil, senderAvatar: nil),
        ],
    ]

    private static let contacts: [Contact] = [
        Contact(id: "p-1", workspaceId: "ws-1", name: "مریم حسینی", email: "maryam@example.com",
                phone: "+98 912 000 1122", avatarURL: nil, visitorCode: nil, createdAt: SampleAPI.ago(20000)),
        Contact(id: "p-2", workspaceId: "ws-1", name: "Alexander Konstantinopoulos",
                email: "alexander.konstantinopoulos@verylongcompanyname.example",
                phone: nil, avatarURL: nil, visitorCode: nil, createdAt: SampleAPI.ago(41000)),
        Contact(id: "p-3", workspaceId: "ws-1", name: nil, email: nil, phone: nil,
                avatarURL: nil, visitorCode: "8F2C", createdAt: SampleAPI.ago(900)),
        Contact(id: "p-4", workspaceId: "ws-1", name: "Deniz Yılmaz", email: "deniz@example.com",
                phone: "+90 532 000 44 55", avatarURL: nil, visitorCode: nil, createdAt: SampleAPI.ago(60000)),
        Contact(id: "p-5", workspaceId: "ws-1", name: "Jonas Müller", email: "jonas@example.com",
                phone: nil, avatarURL: nil, visitorCode: nil, createdAt: SampleAPI.ago(80000)),
        Contact(id: "p-6", workspaceId: "ws-1", name: nil, email: nil, phone: nil,
                avatarURL: nil, visitorCode: "A19D", createdAt: SampleAPI.ago(300)),
    ]
}

private extension Conversation {
    /// The sample backend's status changes have to produce a new value,
    /// because every field is `let`.
    func with(status newStatus: ConversationStatus) -> Conversation {
        Conversation(
            id: id,
            workspaceId: workspaceId,
            contactId: contactId,
            subject: subject,
            status: newStatus,
            assignedTo: assignedTo,
            priority: priority,
            tags: [],
            createdAt: createdAt,
            updatedAt: updatedAt,
            contact: contact,
            lastMessage: lastMessage,
            // Carried over: resolving a thread does not change who was
            // answering it.
            unreadCount: newStatus == .resolved ? 0 : unreadCount,
            aiState: aiState,
            metadata: metadata
        )
    }
}
#endif
