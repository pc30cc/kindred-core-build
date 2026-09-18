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
    private var extraMessages: [String: [Message]] = [:]

    var hasToken: Bool { true }

    // MARK: - Auth

    func logIn(email: String, password: String) async throws -> User { Self.user }
    func currentUser() async throws -> User { Self.user }
    func logOut() async throws {}
    func discardSession() {}

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
            createdAt: ago(90),
            updatedAt: ago(4),
            contact: ConversationContact(
                name: "مریم حسینی",
                email: "maryam@example.com",
                avatarURL: nil,
                visitorCode: nil
            ),
            lastMessage: MessagePreview(
                body: "سلام، سفارش من هنوز ارسال نشده. می‌تونید وضعیتش رو بررسی کنید؟",
                createdAt: ago(4),
                senderType: "contact"
            ),
            unreadCount: 3
        ),
        Conversation(
            id: "c-2",
            workspaceId: "ws-1",
            contactId: "p-2",
            subject: nil,
            status: .open,
            assignedTo: "u-1",
            createdAt: ago(300),
            updatedAt: ago(52),
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
                createdAt: ago(52),
                senderType: "contact"
            ),
            unreadCount: 128
        ),
        Conversation(
            id: "c-3",
            workspaceId: "ws-1",
            contactId: "p-3",
            subject: nil,
            status: .open,
            assignedTo: nil,
            createdAt: ago(600),
            updatedAt: ago(140),
            contact: ConversationContact(name: nil, email: nil, avatarURL: nil, visitorCode: "8F2C"),
            lastMessage: MessagePreview(
                body: "Merhaba, fiyatlandırma hakkında bilgi alabilir miyim?",
                createdAt: ago(140),
                senderType: "contact"
            ),
            unreadCount: 0
        ),
        Conversation(
            id: "c-4",
            workspaceId: "ws-1",
            contactId: "p-4",
            subject: "Refund request",
            status: .open,
            assignedTo: nil,
            createdAt: ago(1500),
            updatedAt: ago(1400),
            contact: ConversationContact(
                name: "Deniz Yılmaz",
                email: "deniz@example.com",
                avatarURL: nil,
                visitorCode: nil
            ),
            // No body at all — the row must fall back to the subject rather
            // than render an empty second line.
            lastMessage: MessagePreview(body: "", createdAt: ago(1400), senderType: "ai"),
            unreadCount: 0
        ),
        Conversation(
            id: "c-5",
            workspaceId: "ws-1",
            contactId: "p-5",
            subject: nil,
            status: .resolved,
            assignedTo: "u-1",
            createdAt: ago(5000),
            updatedAt: ago(4300),
            contact: ConversationContact(
                name: "Jonas Müller",
                email: "jonas@example.com",
                avatarURL: nil,
                visitorCode: nil
            ),
            lastMessage: MessagePreview(
                body: "Perfect, that fixed it. Thank you!",
                createdAt: ago(4300),
                senderType: "contact"
            ),
            unreadCount: 0
        ),
        Conversation(
            id: "c-6",
            workspaceId: "ws-1",
            contactId: "p-6",
            subject: nil,
            status: .open,
            assignedTo: nil,
            createdAt: ago(200),
            updatedAt: ago(28),
            contact: ConversationContact(name: nil, email: nil, avatarURL: nil, visitorCode: "A19D"),
            lastMessage: MessagePreview(
                body: "Your order #48120 has shipped and should arrive on Thursday.",
                createdAt: ago(28),
                senderType: "ai"
            ),
            unreadCount: 1
        ),
    ]

    private static let messages: [String: [Message]] = [
        "c-1": [
            Message(id: "m-1", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "سلام وقت بخیر", createdAt: ago(95), senderName: nil, senderAvatar: nil),
            Message(id: "m-2", conversationId: "c-1", senderType: .ai, senderId: nil,
                    body: "سلام! چطور می‌تونم کمکتون کنم؟", createdAt: ago(94),
                    senderName: nil, senderAvatar: nil),
            Message(id: "m-3", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "سفارش شمارهٔ ۴۸۱۲۰ رو دو هفته پیش ثبت کردم و هنوز چیزی به دستم نرسیده.",
                    createdAt: ago(92), senderName: nil, senderAvatar: nil),
            Message(id: "m-4", conversationId: "c-1", senderType: .system, senderId: nil,
                    body: "Sara Karimi joined the conversation", createdAt: ago(60),
                    senderName: nil, senderAvatar: nil),
            Message(id: "m-5", conversationId: "c-1", senderType: .agent, senderId: "u-1",
                    body: "سلام مریم جان، الان بررسی می‌کنم و چند لحظهٔ دیگر خبر می‌دهم.",
                    createdAt: ago(58), senderName: "Sara Karimi", senderAvatar: nil),
            Message(id: "m-6", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "ممنون می‌شم", createdAt: ago(10), senderName: nil, senderAvatar: nil),
            Message(id: "m-7", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "سلام، سفارش من هنوز ارسال نشده. می‌تونید وضعیتش رو بررسی کنید؟",
                    createdAt: ago(4), senderName: nil, senderAvatar: nil),
        ],
        "c-2": [
            Message(id: "n-1", conversationId: "c-2", senderType: .contact, senderId: nil,
                    body: "Hi — we're hitting an issue exporting our reports.",
                    createdAt: ago(320), senderName: nil, senderAvatar: nil),
            Message(id: "n-2", conversationId: "c-2", senderType: .agent, senderId: "u-1",
                    body: "Sorry about that. Could you tell me roughly how large the export is, and whether it fails at the same point every time?",
                    createdAt: ago(300), senderName: "Sara Karimi", senderAvatar: nil),
            Message(id: "n-3", conversationId: "c-2", senderType: .contact, senderId: nil,
                    body: "Thanks for getting back to me. I tried the steps you suggested but the export still fails at around 80% with a timeout, and it happens on both of our accounts.",
                    createdAt: ago(52), senderName: nil, senderAvatar: nil),
        ],
    ]

    private static let contacts: [Contact] = [
        Contact(id: "p-1", workspaceId: "ws-1", name: "مریم حسینی", email: "maryam@example.com",
                phone: "+98 912 000 1122", avatarURL: nil, visitorCode: nil, createdAt: ago(20000)),
        Contact(id: "p-2", workspaceId: "ws-1", name: "Alexander Konstantinopoulos",
                email: "alexander.konstantinopoulos@verylongcompanyname.example",
                phone: nil, avatarURL: nil, visitorCode: nil, createdAt: ago(41000)),
        Contact(id: "p-3", workspaceId: "ws-1", name: nil, email: nil, phone: nil,
                avatarURL: nil, visitorCode: "8F2C", createdAt: ago(900)),
        Contact(id: "p-4", workspaceId: "ws-1", name: "Deniz Yılmaz", email: "deniz@example.com",
                phone: "+90 532 000 44 55", avatarURL: nil, visitorCode: nil, createdAt: ago(60000)),
        Contact(id: "p-5", workspaceId: "ws-1", name: "Jonas Müller", email: "jonas@example.com",
                phone: nil, avatarURL: nil, visitorCode: nil, createdAt: ago(80000)),
        Contact(id: "p-6", workspaceId: "ws-1", name: nil, email: nil, phone: nil,
                avatarURL: nil, visitorCode: "A19D", createdAt: ago(300)),
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
            createdAt: createdAt,
            updatedAt: updatedAt,
            contact: contact,
            lastMessage: lastMessage,
            unreadCount: newStatus == .resolved ? 0 : unreadCount
        )
    }
}
