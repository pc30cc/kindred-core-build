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
    /// Files "uploaded" to the sample, so a photo sent from the composer
    /// comes back on its message like it does from the server.
    private var uploadedFiles: [String: (data: Data, fileName: String, mimeType: String)] = [:]
    /// Round-tripped in memory so the notification settings screen can be
    /// laid out and screenshotted with its switches actually working.
    private var samplePrefs = NotificationPrefs()

    /// Signed in, unless the run asked to see the sign-in screen.
    var hasToken: Bool { SampleRoute.current != .login }

    // MARK: - Auth

    func logIn(email: String, password: String) async throws -> User { Self.user }
    func currentUser() async throws -> User { Self.user }
    func logOut() async throws {}
    func discardSession() {}
    func requestPasswordReset(email: String, locale: String) async throws {}

    private static let user = User(
        id: "u-1",
        email: "operator@webyar.app",
        fullName: "Sara Karimi",
        emailVerified: true
    )

    // MARK: - Workspaces

    /// Two of them, on purpose.
    ///
    /// Settings shows the operator every workspace they belong to, and with a
    /// single one the list, the checkmark and the "switch to this one" tap all
    /// go untested — the one-workspace row is a different branch. Most real
    /// accounts have one; the interesting one is the account that has two.
    func workspaces() async throws -> [Workspace] {
        [
            Workspace(id: "ws-1", name: "Sample Workspace", slug: "sample", logoURL: nil),
            Workspace(id: "ws-2", name: "Second Workspace", slug: "second", logoURL: nil)
        ]
    }

    // MARK: - Conversations

    func conversations(workspaceID: String, filter: InboxFilter) async throws -> [Conversation] {
        // A visible delay would only make the skeleton harder to screenshot.
        let all = Self.conversations.map { conversation -> Conversation in
            guard let overridden = statuses[conversation.id] else { return conversation }
            return conversation.with(status: overridden)
        }
        // Every sample workspace shows the same threads, filed under the
        // workspace that asked — the app never shows a row of one workspace
        // in another, and the sample must not look like it does.
        .map { $0.with(workspaceID: workspaceID) }

        return switch filter {
        case .open: all.filter { $0.status == .open || $0.status == .pending }
        case .needsHuman: all.filter { ($0.status == .open || $0.status == .pending) && $0.assignedTo == nil }
        case .pending: all.filter { $0.status == .pending }
        case .resolved: all.filter { $0.status == .resolved || $0.status == .closed }
        case .ai: all.filter { $0.lastMessage?.senderType == "ai" }
        // Nothing in the sample set is spam, and an empty queue is the
        // honest picture of a healthy workspace.
        case .spam: []
        }
    }

    func messages(conversationID: String) async throws -> [Message] {
        (Self.messages[conversationID] ?? []) + (extraMessages[conversationID] ?? [])
    }

    func conversations(workspaceID: String, filter: InboxFilter, etag: String?) async throws -> ListPage {
        ListPage(conversations: try await conversations(workspaceID: workspaceID, filter: filter), etag: nil)
    }

    func conversation(id: String, workspaceID: String) async throws -> Conversation? {
        // Filed under the workspace that asked, as the list files them.
        Self.conversations.first { $0.id == id }.map { conversation in
            (statuses[id].map { conversation.with(status: $0) } ?? conversation).with(workspaceID: workspaceID)
        }
    }

    /// Always the whole thread, with no cursor: what a server without
    /// incremental sync answers, which the app has to handle anyway.
    func messagePage(conversationID: String, since: String?) async throws -> ThreadPage {
        ThreadPage(messages: try await messages(conversationID: conversationID), delta: false, cursor: nil)
    }

    /// The sample has no realtime, like a platform that runs without it:
    /// the app keeps to its polling and never opens a socket.
    func realtimeConnect(workspaceID: String, intent: String) async throws -> RealtimeConnect {
        RealtimeConnect(vendor: "disabled", wsURL: nil, token: nil, expiresAt: nil)
    }

    func realtimeInboxSubscribe(workspaceID: String) async throws -> RealtimeSubscribe {
        RealtimeSubscribe(vendor: "disabled", channel: nil, token: nil, expiresAt: nil)
    }

    func realtimeUserSubscribe(workspaceID: String) async throws -> RealtimeSubscribe {
        RealtimeSubscribe(vendor: "disabled", channel: nil, token: nil, expiresAt: nil)
    }

    func attachmentFile(id: String) async throws -> URL {
        let data = try await attachmentData(id: id)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("webyar-sample-\(UUID().uuidString)")
        try data.write(to: url)
        return url
    }

    func send(
        body: String,
        conversationID: String,
        workspaceID: String,
        clientMessageID: String,
        attachmentID: String?
    ) async throws {
        // The server collapses a replay of the same key; so does the sample.
        guard !(extraMessages[conversationID] ?? []).contains(where: { $0.clientMessageID == clientMessageID }) else { return }
        extraMessages[conversationID, default: []].append(
            Message(
                id: "sent-\(clientMessageID)",
                conversationId: conversationID,
                senderType: .agent,
                senderId: Self.user.id,
                body: body,
                createdAt: Date(),
                senderName: Self.user.fullName,
                senderAvatar: nil,
                metadata: ["client_message_id": .string(clientMessageID)],
                attachments: attachmentID.flatMap { id in
                    uploadedFiles[id].map { file in
                        [MessageAttachment(
                            id: id, fileName: file.fileName, mimeType: file.mimeType,
                            sizeBytes: file.data.count,
                            kind: file.mimeType.hasPrefix("image/") ? "image" : "file"
                        )]
                    }
                }
            )
        )
    }

    func markSeen(conversationID: String) async throws {}

    func setStatus(_ status: ConversationStatus, conversationID: String, workspaceID: String) async throws {
        statuses[conversationID] = status
    }

    // MARK: - The AI, on a thread it owns
    //
    // The sample backend exists so the app is screenshot-able and testable
    // without a server. Both of these are writes with nothing to read back,
    // so accepting them is the whole of what a stub owes here.

    func takeOverConversation(conversationID: String, workspaceID: String) async throws {}

    func aiSayNow(conversationID: String, body: String, voice: SayNowVoice) async throws {}

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
    /// The sample backend stores nothing, so a file "sends" and is forgotten.
    func uploadAttachment(
        conversationID: String?,
        workspaceID: String,
        fileName: String,
        mimeType: String,
        data: Data,
        onProgress: (@Sendable (Double) -> Void)?
    ) async throws -> String {
        // Slow enough to see the ring fill — slower still on a run that
        // stages a photo to screenshot the field while it uploads.
        let pause = SamplePhotoDemo.current == .stage ? 1500 : 150
        for step in 1...4 {
            try? await Task.sleep(for: .milliseconds(pause))
            onProgress?(Double(step) / 4)
        }
        let id = UUID().uuidString
        uploadedFiles[id] = (data, fileName, mimeType)
        return id
    }

    /// Sample contacts get the same treatment as sample conversations, so the
    /// Contacts list exercises the OS-mark and flag paths too.
    func visitorIntel(workspaceID: String, contactIDs: [String]) async throws -> [String: VisitorProfile] {
        let profiles: [VisitorProfile] = [
            .init(geo: .init(countryCode: "IR", country: "Iran", city: "Tehran"),
                  device: .init(browser: "Safari", os: "iOS", device: "mobile")),
            .init(geo: .init(countryCode: "DE", country: "Germany", city: "Berlin"),
                  device: .init(browser: "Chrome", os: "Windows", device: "desktop")),
            .init(geo: .init(countryCode: "TR", country: "Türkiye", city: "Istanbul"),
                  device: .init(browser: "Chrome", os: "Android", device: "mobile")),
            .init(geo: .init(countryCode: "NL", country: "Netherlands", city: "Utrecht"),
                  device: .init(browser: "Firefox", os: "Ubuntu", device: "desktop")),
        ]
        return Dictionary(uniqueKeysWithValues: contactIDs.enumerated().map { index, id in
            (id, profiles[index % profiles.count])
        })
    }

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

    // MARK: - Email inbox
    //
    // Two mailboxes, as a workspace with a Gmail and a Yahoo has them; Gmail
    // with folders and labels, an unread thread, a starred one, a thread with
    // an HTML mail, a quoted trail and a file, and one in Persian.

    private var sampleMail: [EmailThreadSummary] = SampleAPI.sampleMailThreads
    private var sampleSent: [String: [EmailMessageView]] = [:]

    private static let sampleMailThreads: [EmailThreadSummary] = [
        EmailThreadSummary(
            id: "e-1", provider: "gmail", subject: "Invoice for August",
            participants: [EmailAddress(email: "\"Northwind Billing\" <billing@northwind.example>"),
                           EmailAddress(email: "support@webyar.example")],
            lastMessageAt: Date().addingTimeInterval(-3_600), isRead: false, isStarred: true,
            labels: ["INBOX", "Label_1"], lastMessageSnippet: "Attached is the invoice for August.", messageCount: 1
        ),
        EmailThreadSummary(
            id: "e-2", provider: "gmail", subject: "Re: Widget not loading on Safari",
            participants: [EmailAddress(email: "Lena Fischer <lena@acme.example>"),
                           EmailAddress(email: "support@webyar.example")],
            lastMessageAt: Date().addingTimeInterval(-86_400), isRead: true, isStarred: false,
            labels: ["INBOX"], lastMessageSnippet: "That fixed it, thank you.", messageCount: 3
        ),
        EmailThreadSummary(
            id: "e-3", provider: "gmail", subject: "درخواست دمو برای تیم پشتیبانی",
            participants: [EmailAddress(email: "مریم رضایی <maryam@shop.example>")],
            lastMessageAt: Date().addingTimeInterval(-2 * 86_400), isRead: false, isStarred: false,
            labels: ["INBOX"], lastMessageSnippet: "سلام، می‌خواستیم برای هفتهٔ بعد یک جلسهٔ دمو هماهنگ کنیم.", messageCount: 1
        ),
    ]

    func emailThreadsPage(
        workspaceID: String, filter: EmailListFilter, before: String?, mailbox: String?, folder: String?
    ) async throws -> EmailThreadsResponse {
        guard before == nil else { return EmailThreadsResponse() }
        if mailbox == "yahoo" { return EmailThreadsResponse(threads: [], historyId: nil) }
        var threads = sampleMail
        switch folder ?? EmailMailFolder.inbox {
        case "starred": threads = threads.filter { $0.isStarred == true }
        case "label:Label_1": threads = threads.filter { $0.labels?.contains("Label_1") == true }
        case EmailMailFolder.inbox, "all": break
        default: threads = []
        }
        switch filter {
        case .all: break
        case .unread: threads = threads.filter { $0.isRead != true }
        case .starred: threads = threads.filter { $0.isStarred == true }
        }
        return EmailThreadsResponse(threads: threads, nextBefore: nil, historyId: "h-1")
    }

    func emailThread(workspaceID: String, threadID: String, mailbox: String?, folder: String?) async throws -> EmailThreadResponse {
        guard let summary = sampleMail.first(where: { $0.id == threadID }) else {
            throw APIError.server(status: 404, message: "thread_not_found")
        }
        let them = summary.participants?.first?.email ?? "someone@example.com"
        var messages: [EmailMessageView]
        switch threadID {
        case "e-1":
            messages = [
                EmailMessageView(
                    id: "em-11", externalMessageId: "x-11", direction: "inbound", fromAddress: them,
                    toAddresses: [EmailAddress(email: "support@webyar.example")], ccAddresses: [],
                    textBody: nil,
                    htmlBody: "<style>table{width:600px}</style><table><tr><td><h2>Invoice #2026-0914</h2>"
                        + "<p>Hello,</p><p>Attached is the invoice for <b>August</b>. The total is <b>€240.00</b>.</p>"
                        + "<p>Thanks &mdash; Northwind</p></td></tr></table>",
                    snippet: "Attached is the invoice for August.", isRead: false, deliveryStatus: nil,
                    deliveryError: nil, sentAt: Date().addingTimeInterval(-3_600),
                    attachments: [EmailAttachmentView(id: "ea-1", filename: "invoice-2026-0914.pdf",
                                                      contentType: "application/pdf", sizeBytes: 48_213, contentId: nil, url: nil)]
                ),
            ]
        case "e-2":
            messages = [
                EmailMessageView(
                    id: "em-21", externalMessageId: "x-21", direction: "inbound", fromAddress: them,
                    toAddresses: [EmailAddress(email: "support@webyar.example")], ccAddresses: [],
                    textBody: "Hi, the chat widget does not load on Safari 18 for us.", htmlBody: nil,
                    snippet: nil, isRead: true, deliveryStatus: nil, deliveryError: nil,
                    sentAt: Date().addingTimeInterval(-3 * 86_400), attachments: []
                ),
                EmailMessageView(
                    id: "em-22", externalMessageId: "x-22", direction: "outbound", fromAddress: "support@webyar.example",
                    toAddresses: [EmailAddress(email: them)], ccAddresses: [],
                    textBody: "Could you try clearing the site data once? We shipped a fix this morning.", htmlBody: nil,
                    snippet: nil, isRead: true, deliveryStatus: "sent", deliveryError: nil,
                    sentAt: Date().addingTimeInterval(-2 * 86_400), attachments: []
                ),
                EmailMessageView(
                    id: "em-23", externalMessageId: "x-23", direction: "inbound", fromAddress: them,
                    toAddresses: [EmailAddress(email: "support@webyar.example")], ccAddresses: [],
                    textBody: "That fixed it, thank you.\n\nOn Mon, Support <support@webyar.example> wrote:\n> Could you try clearing the site data once?",
                    htmlBody: nil, snippet: nil, isRead: true, deliveryStatus: nil, deliveryError: nil,
                    sentAt: Date().addingTimeInterval(-86_400), attachments: []
                ),
            ]
        default:
            messages = [
                EmailMessageView(
                    id: "em-31", externalMessageId: "x-31", direction: "inbound", fromAddress: them,
                    toAddresses: [EmailAddress(email: "support@webyar.example")], ccAddresses: [],
                    textBody: summary.lastMessageSnippet, htmlBody: nil, snippet: nil, isRead: summary.isRead,
                    deliveryStatus: nil, deliveryError: nil, sentAt: summary.lastMessageAt, attachments: []
                ),
            ]
        }
        messages += sampleSent[threadID] ?? []
        return EmailThreadResponse(thread: summary, messages: messages)
    }

    func setEmailThreadRead(workspaceID: String, threadID: String, isRead: Bool, mailbox: String?) async throws {
        if let index = sampleMail.firstIndex(where: { $0.id == threadID }) { sampleMail[index].isRead = isRead }
    }

    func setEmailThreadStarred(workspaceID: String, threadID: String, starred: Bool, mailbox: String?) async throws {
        if let index = sampleMail.firstIndex(where: { $0.id == threadID }) { sampleMail[index].isStarred = starred }
    }

    func sendEmailDraft(workspaceID: String, draft: EmailDraft, mailbox: String?) async throws {
        guard let threadID = draft.threadID else { return }
        sampleSent[threadID, default: []].append(EmailMessageView(
            id: "sent-\(UUID().uuidString.prefix(8))", externalMessageId: nil, direction: "outbound",
            fromAddress: "support@webyar.example", toAddresses: draft.to.map(EmailAddress.init(email:)),
            ccAddresses: draft.cc.map(EmailAddress.init(email:)), textBody: draft.body, htmlBody: nil, snippet: nil,
            isRead: true, deliveryStatus: "sent", deliveryError: nil, sentAt: Date(), attachments: []
        ))
        if let index = sampleMail.firstIndex(where: { $0.id == threadID }) {
            sampleMail[index].lastMessageAt = Date()
            sampleMail[index].lastMessageSnippet = draft.body
            sampleMail[index].messageCount = (sampleMail[index].messageCount ?? 1) + 1
        }
    }

    func stageEmailAttachment(
        workspaceID: String, data: Data, filename: String, contentType: String, mailbox: String?
    ) async throws -> StagedEmailAttachment {
        StagedEmailAttachment(storageKey: "sample/\(filename)", filename: filename, contentType: contentType, sizeBytes: data.count)
    }

    func emailAttachmentData(workspaceID: String, attachmentID: String, mailbox: String?) async throws -> Data {
        Data("%PDF-1.4\n% sample\n".utf8)
    }

    func emailMailboxes(workspaceID: String) async throws -> [EmailMailbox] {
        [
            EmailMailbox(provider: "gmail", address: "support@webyar.example", status: "connected",
                         unread: sampleMail.filter { $0.isRead != true }.count),
            EmailMailbox(provider: "yahoo", address: "sales@webyar.example", status: "connected", unread: 0),
        ]
    }

    func emailFolders(workspaceID: String, mailbox: String?) async throws -> [EmailMailFolder] {
        guard mailbox != "yahoo" else { return [EmailMailFolder(id: "inbox"), EmailMailFolder(id: "sent"), EmailMailFolder(id: "trash")] }
        return [
            EmailMailFolder(id: "inbox", unread: sampleMail.filter { $0.isRead != true }.count),
            EmailMailFolder(id: "starred"),
            EmailMailFolder(id: "important"),
            EmailMailFolder(id: "sent"),
            EmailMailFolder(id: "drafts", total: 0),
            EmailMailFolder(id: "all"),
            EmailMailFolder(id: "spam", unread: 0),
            EmailMailFolder(id: "trash"),
            EmailMailFolder(id: "label:Label_1", kind: "label", name: "Clients", unread: 1),
        ]
    }

    func emailChanges(workspaceID: String, since: String, mailbox: String?) async throws -> EmailChanges {
        EmailChanges(historyId: since, threadIds: [])
    }

    // MARK: - Channel inboxes, colleagues, availability

    func channelInboxes(workspaceID: String) async throws -> [ChannelInbox] {
        [ChannelInbox(key: "telegram"), ChannelInbox(key: "bale")]
    }

    func colleagues(workspaceID: String) async throws -> ColleaguesResponse {
        ColleaguesResponse(
            colleagues: [
                Colleague(
                    userId: "u-2", role: "agent", fullName: "سارا اجکم",
                    email: "sara@webyar.example", avatarURL: nil, unread: 2,
                    lastMessage: .init(
                        body: "این گفتگو را برایت فرستادم", createdAt: Date().addingTimeInterval(-900),
                        outgoing: false, attachmentKind: nil
                    )
                ),
                Colleague(
                    userId: "u-3", role: "admin", fullName: "Deniz Yılmaz",
                    email: "deniz@webyar.example", avatarURL: nil, unread: 0,
                    lastMessage: .init(
                        body: "Thanks — picked it up.", createdAt: Date().addingTimeInterval(-7_200),
                        outgoing: true, attachmentKind: nil
                    )
                ),
            ],
            totalUnread: 2,
            me: Self.user.id
        )
    }

    /// Long enough to fill the screen.
    ///
    /// Two messages was not: a transcript shorter than its viewport has
    /// nowhere to scroll, so every question about how it behaves when the
    /// keyboard opens had the same answer — it did not move, because it never
    /// had to. A thread that overflows is the ordinary case and the only one
    /// worth laying out against.
    func teamThread(workspaceID: String, peerID: String) async throws -> TeamThreadResponse {
        let script: [(String, Bool)] = [
            ("سلام، وقتت آزاد است؟", false),
            ("سلام. آره، بگو.", true),
            ("این گفتگو را برایت فرستادم — مشتری دوبار پیگیری کرده.", false),
            ("دیدم، دستت درد نکند.", true),
            ("فکر می‌کنی امروز جواب بدهیم؟", false),
            ("بله، تا ظهر می‌بندمش.", true),
            ("عالی. اگر خواستی من هم نگاه کنم بگو.", false),
            ("ممنون، فعلاً لازم نیست.", true),
            ("راستی فاکتورش را هم بررسی کن.", false),
            ("چشم، همان را هم نگاه می‌کنم.", true),
            ("مرسی.", false),
            ("خواهش می‌کنم.", true),
        ]
        let messages = script.enumerated().map { index, line -> TeamMessage in
            let (body, outgoing) = line
            return TeamMessage(
                id: "tm-\(index + 1)",
                senderId: outgoing ? Self.user.id : peerID,
                recipientId: outgoing ? peerID : Self.user.id,
                body: body,
                attachment: nil,
                readAt: outgoing ? Date() : nil,
                createdAt: Date().addingTimeInterval(Double(index - script.count) * 300)
            )
        }
        return TeamThreadResponse(messages: messages, me: Self.user.id)
    }

    func sendTeamMessage(
        workspaceID: String, recipientID: String, body: String, attachmentID: String?
    ) async throws {}

    func markTeamThreadRead(workspaceID: String, peerID: String) async throws {}

    /// Three of them, with a placeholder in one, so the picker, the search and
    /// the interpolation all have something to be.
    func cannedResponses(
        workspaceID: String, locale: String, query: String
    ) async throws -> [CannedResponse] {
        let all = [
            CannedResponse(
                id: "cr-1", shortcut: "hi", title: "Greeting",
                body: "Hello {{contact.name}}, thanks for getting in touch with {{workspace.name}}.",
                locale: locale, usageCount: 42
            ),
            CannedResponse(
                id: "cr-2", shortcut: "wait", title: "Asking for a moment",
                body: "Let me look into that for you — one moment.",
                locale: locale, usageCount: 17
            ),
            CannedResponse(
                id: "cr-3", shortcut: "bye", title: "Closing",
                body: "Glad that helped. {{agent.first_name}} here if you need anything else.",
                locale: locale, usageCount: 5
            ),
        ]
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return all }
        return all.filter {
            $0.shortcut.lowercased().hasPrefix(needle)
                || $0.title.lowercased().contains(needle)
                || $0.body.lowercased().contains(needle)
        }
    }

    func trackCannedResponseUse(id: String, workspaceID: String) async throws {}

    func availability() async throws -> AvailabilityResponse {
        AvailabilityResponse(
            prefs: AvailabilityPrefs(
                forceOffline: false, availableWhenUsingApp: true,
                scheduleEnabled: false, timezone: "Asia/Tehran"
            ),
            status: AvailabilityStatus(state: "online", reason: "using_app")
        )
    }

    func updateAvailability(_ update: AvailabilityUpdate) async throws -> AvailabilityResponse {
        AvailabilityResponse(
            prefs: AvailabilityPrefs(
                forceOffline: update.force_offline ?? false,
                availableWhenUsingApp: update.available_when_using_app ?? true,
                scheduleEnabled: update.schedule_enabled ?? false,
                timezone: "Asia/Tehran"
            ),
            status: AvailabilityStatus(
                state: (update.force_offline ?? false) ? "offline" : "online",
                reason: "manual"
            )
        )
    }

    /// Sample mode answers from memory, so there is no origin to resolve.
    func refreshOrigin() async {}

    func promotions(workspaceID: String, locale: String) async throws -> Promotions {
        Promotions(
            enabled: true,
            banner: PromoCreative(
                title: "Your plan is Free",
                body: "Upgrade for the AI queue, calls and the email inbox.",
                ctaLabel: nil, ctaURL: nil, imageURL: nil
            ),
            fullscreen: PromoCreative(
                title: "Everything in one inbox",
                body: "Telegram, WhatsApp and email beside your chat — on every plan above Free.",
                ctaLabel: nil, ctaURL: nil, imageURL: nil
            ),
            minIntervalMinutes: 360, maxPerDay: 3, startAfterLaunches: 2
        )
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
                // The website widget's own keys, as a real plan carries them.
                // They do not reach the operator's composer.
                "widget_attachments": on,
                "widget_voice_notes": on,
                "widget_emoji": on,
                "inbox_team_chat": on,
                // Sample mode is where the promotion surfaces get laid out,
                // so it carries them even though no real plan does yet.
                "mobile_promo_banner": on,
                "mobile_promo_fullscreen": on,
            ],
            modules: [
                "chat": on,
                "contacts": on,
                "call_center": on,
                "visitor_tracking": on,
                "web_analytics": on,
                "email_inbox": on,
                "voice_video": on,
            ],
            // Only a key that is exactly true is on, so every channel the
            // sample lays out is listed: the calls and the channel inboxes.
            channels: ["chat_widget": on, "voice": on, "video": on, "telegram": on, "bale": on],
            limits: [:],
            plan: Entitlements.PlanSummary(slug: "pro", name: "Pro", tier: "pro")
        )
    }

    /// An owner, with the AI switched on, shown to customers and answering, and
    /// the call center on — so every section the plan carries is laid out.
    func workspaceAccess(workspaceID: String) async -> WorkspaceAccess {
        WorkspaceAccess(role: "owner", aiAgentEnabled: true, aiCustomerVisible: true,
                        aiAutoAnswer: true, callCenterVisible: true)
    }

    // MARK: - Account

    /// The operator's photograph — present on the Profile screen's run, so
    /// "Remove photo" is there to be pressed (or not) and removing it really
    /// takes it away. Everywhere else the sample operator has none, as before.
    private var sampleAvatarURL: String? = SampleRoute.current == .profile ? SampleAPI.sampleFace : nil

    /// Inline, so nothing is fetched: the image loader only takes an HTTP
    /// answer, so it draws the silhouette. What matters here is that the
    /// operator HAS a photograph — the screen offers to remove it.
    static let sampleFace =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

    private var profile: AccountProfile {
        AccountProfile(id: Self.user.id, fullName: Self.user.fullName,
                       avatarURL: sampleAvatarURL, preferredLocale: "en")
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
        sampleAvatarURL = Self.sampleFace
        return profile
    }

    func deleteAvatar() async throws {
        sampleAvatarURL = nil
    }

    /// The sample backend has no files. A screenshot run that met one would
    /// draw the "could not load" card, which is the honest thing for a
    /// backend that genuinely has nothing to hand over.
    func attachmentData(id: String) async throws -> Data {
        guard let file = uploadedFiles[id] else { throw APIError.server(status: 404, message: nil) }
        return file.data
    }

    private var sampleSessions: [AccountSession] = [
        AccountSession(id: "s-1", browser: "Webyar", os: "iOS 26", device: "iPhone",
                       ip: "—", city: "Istanbul", country: "Türkiye", countryCode: "TR",
                       isCurrent: true, createdAt: SampleAPI.ago(20), lastActiveAt: SampleAPI.ago(1)),
        AccountSession(id: "s-2", browser: "Chrome", os: "macOS", device: nil,
                       ip: "—", city: "Tehran", country: "Iran", countryCode: "IR",
                       isCurrent: false, createdAt: SampleAPI.ago(4000), lastActiveAt: SampleAPI.ago(300)),
        AccountSession(id: "s-3", browser: "Webyar", os: "Android 16", device: "Mobile",
                       ip: "—", city: "Shiraz", country: "Iran", countryCode: "IR",
                       isCurrent: false, createdAt: SampleAPI.ago(9000), lastActiveAt: SampleAPI.ago(2000)),
    ]

    func sessions() async throws -> AccountSessionsResponse {
        AccountSessionsResponse(sessions: sampleSessions, currentSessionId: "s-1")
    }

    func revokeSession(id: String) async throws {
        sampleSessions.removeAll { $0.id == id && $0.isCurrent != true }
    }

    /// The sample platform names no default language: a sample run is in
    /// the one it was launched with.
    /// Legal links only: a sample run's language is its launch argument's.
    func mobilePublicConfig() async -> MobilePublicConfig? {
        MobilePublicConfig(defaultLanguage: nil, legal: LegalLinks(
            privacyPolicy: URL(string: "https://webyar.ai/privacy"),
            terms: URL(string: "https://webyar.ai/terms")
        ))
    }

    func revokeOtherSessions(keepingDevice deviceID: String?) async throws -> Int {
        let others = sampleSessions.filter { $0.isCurrent != true }.count
        sampleSessions.removeAll { $0.isCurrent != true }
        return others
    }

    func changePassword(current: String, new: String) async throws {}

    // MARK: - Notifications
    //
    // Registration is a no-op: a UI test runs on a simulator that has no APNs
    // address to give, and a sample run must never put a real device in the
    // real registry. The preferences round-trip in memory so the settings
    // screen can be laid out and screenshotted with the switches working.

    func registerPushDevice(
        token: String,
        deviceID: String,
        deviceName: String,
        appVersion: String,
        permission: String,
        workspaceID: String?
    ) async throws -> PushRegistration {
        PushRegistration(pushEnabled: true, voipEnabled: true)
    }

    func unregisterPushDevice(deviceID: String) async throws {}

    /// The sample operator owns both sample workspaces, so this is the
    /// blocked branch — which is the one worth being able to look at.
    func deleteAccount(password: String) async throws -> AccountDeletion {
        .blockedByOwnedWorkspaces(["Sample Workspace", "Second Workspace"])
    }

    func notificationPrefs() async throws -> NotificationPrefs {
        samplePrefs
    }

    func updateNotificationPrefs(_ prefs: NotificationPrefs) async throws -> NotificationPrefs {
        samplePrefs = prefs
        return prefs
    }

    // MARK: - App configuration

    func mobileAppConfig() async throws -> MobileAppConfig {
        // The website link at the foot of Settings, named as Super Admin might name it.
        var config = MobileAppConfig.defaults
        config.websiteURL = URL(string: "https://webyar.ai")
        config.websiteLabel = ["fa": "سایت وبیار"]
        return config
    }

    // MARK: - Online support
    //
    // The chat with the platform's team as a real operator meets it: an open
    // conversation an agent joined and answered, one that was resolved and
    // rated, one closed and still waiting for its stars. `supportOffline`
    // has the team away, with its hours, and nothing open — the fresh page.

    private var supportConversations: [SupportConversation] = SampleAPI.sampleSupportConversations
    private var supportItems: [SupportItem] = SampleAPI.sampleSupportItems
    private var supportActive: String? = SampleRoute.current == .supportOffline ? nil : "sc-3"
    private var supportUnread = SampleRoute.current == .supportOffline ? 0 : 1
    private var supportFiles: [String: Data] = [:]

    func supportStatus() async throws -> SupportStatus {
        let offline = SampleRoute.current == .supportOffline
        return SupportStatus(
            enabled: true,
            available: true,
            online: !offline,
            teamName: "Webyar Support",
            teamAvatar: nil,
            unread: supportUnread,
            hours: SupportHours(timezone: "Asia/Tehran", weekly: [
                "sat": [SupportInterval(from: "09:00", to: "17:00")],
                "sun": [SupportInterval(from: "09:00", to: "17:00")],
                "mon": [SupportInterval(from: "09:00", to: "17:00")],
                "tue": [SupportInterval(from: "09:00", to: "17:00")],
                "wed": [SupportInterval(from: "09:00", to: "17:00")],
                "thu": [SupportInterval(from: "09:00", to: "13:00")],
            ]),
            nextOpenAt: offline ? Date().addingTimeInterval(14 * 3600) : nil
        )
    }

    func supportHistory() async throws -> SupportHistory {
        let visible = SampleRoute.current == .supportOffline
            ? supportConversations.filter(\.ended)
            : supportConversations
        let ids = Set(visible.map(\.id))
        return SupportHistory(
            conversations: visible,
            items: supportItems.filter { ids.contains($0.conversationID) },
            activeConversationID: supportActive
        )
    }

    func sendSupportMessage(
        body: String, clientMessageID: String, conversationID: String?, workspaceID: String?
    ) async throws -> SupportPostResult {
        try supportPost(body: body, attachment: nil, clientMessageID: clientMessageID, conversationID: conversationID)
    }

    func sendSupportAttachment(
        fileName: String, mimeType: String, data: Data,
        clientMessageID: String, conversationID: String?, workspaceID: String?
    ) async throws -> SupportPostResult {
        let id = "sf-\(clientMessageID)"
        supportFiles[id] = data
        let kind = mimeType.hasPrefix("image/") ? "image" : "file"
        let file = SupportAttachment(id: id, fileName: fileName, mimeType: mimeType, sizeBytes: data.count, kind: kind)
        return try supportPost(body: "", attachment: file, clientMessageID: clientMessageID, conversationID: conversationID)
    }

    /// The server's rules, in memory: the same client id is the same item,
    /// an ended conversation takes nothing more, and no conversation named
    /// starts a new one.
    private func supportPost(
        body: String, attachment: SupportAttachment?, clientMessageID: String, conversationID: String?
    ) throws -> SupportPostResult {
        if let landed = supportItems.first(where: { $0.clientMessageID == clientMessageID }),
           let conversation = supportConversations.first(where: { $0.id == landed.conversationID }) {
            return SupportPostResult(conversation: conversation, item: landed)
        }
        let conversation: SupportConversation
        if let conversationID {
            guard let named = supportConversations.first(where: { $0.id == conversationID }) else {
                throw APIError.server(status: 404, message: "conversation_not_found")
            }
            guard !named.ended else { throw APIError.server(status: 409, message: "conversation_ended") }
            conversation = named
        } else if let active = supportActive, let open = supportConversations.first(where: { $0.id == active }) {
            conversation = open
        } else {
            conversation = SupportConversation(id: "sc-\(clientMessageID.prefix(8))", status: SupportConversation.open, createdAt: Date())
            supportConversations.append(conversation)
            supportActive = conversation.id
        }
        let item = SupportItem(
            id: "si-\(clientMessageID)",
            conversationID: conversation.id,
            body: body,
            createdAt: Date(),
            clientMessageID: clientMessageID,
            attachments: attachment.map { [$0] } ?? []
        )
        supportItems.append(item)
        return SupportPostResult(conversation: conversation, item: item)
    }

    func supportAttachmentData(id: String) async throws -> Data {
        guard let data = supportFiles[id] else { throw APIError.server(status: 404, message: "attachment_not_found") }
        return data
    }

    func supportAttachmentFile(id: String) async throws -> URL {
        let data = try await supportAttachmentData(id: id)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("webyar-sample-\(UUID().uuidString)")
        try data.write(to: url)
        return url
    }

    func rateSupportConversation(id: String, score: Int, comment: String?) async throws -> SupportConversation {
        guard let index = supportConversations.firstIndex(where: { $0.id == id }) else {
            throw APIError.server(status: 404, message: "conversation_not_found")
        }
        guard supportConversations[index].canRate else { throw APIError.server(status: 409, message: "already_rated") }
        supportConversations[index].rating = SupportRating(score: score, comment: comment, ratedAt: Date())
        supportConversations[index].canRate = false
        return supportConversations[index]
    }

    func markSupportRead() async throws {
        supportUnread = 0
    }

    private static let sampleSupportConversations: [SupportConversation] = [
        SupportConversation(
            id: "sc-1", status: SupportConversation.resolved,
            createdAt: ago(60 * 24 * 20), endedAt: ago(60 * 24 * 20 - 90),
            rating: SupportRating(score: 5, comment: "Quick and clear, thank you!", ratedAt: ago(60 * 24 * 19)),
            canRate: false
        ),
        SupportConversation(
            id: "sc-2", status: SupportConversation.closed,
            createdAt: ago(60 * 24 * 5), endedAt: ago(60 * 24 * 5 - 45),
            rating: nil, canRate: true
        ),
        SupportConversation(id: "sc-3", status: SupportConversation.open, createdAt: ago(42)),
    ]

    private static let sampleSupportItems: [SupportItem] = [
        SupportItem(id: "si-1", conversationID: "sc-1", body: "سلام، چطور دامنهٔ اختصاصی خودم را به ویجت وصل کنم؟",
                    createdAt: ago(60 * 24 * 20)),
        SupportItem(id: "si-2", conversationID: "sc-1", kind: SupportItem.kindJoined, author: SupportItem.authorTeam,
                    senderName: "Neda Ahmadi", createdAt: ago(60 * 24 * 20 - 5)),
        SupportItem(id: "si-3", conversationID: "sc-1", author: SupportItem.authorTeam,
                    body: "سلام! از تنظیمات ← ویجت ← دامنه‌ها، دامنه را اضافه و رکورد CNAME را ثبت کنید.",
                    senderName: "Neda Ahmadi", createdAt: ago(60 * 24 * 20 - 8)),
        SupportItem(id: "si-4", conversationID: "sc-2", body: "Can I get last month's invoice as a PDF?",
                    createdAt: ago(60 * 24 * 5)),
        SupportItem(id: "si-5", conversationID: "sc-2", author: SupportItem.authorTeam,
                    body: "Of course — it is under Billing → Invoices, with a download button on each row.",
                    senderName: "Ali Rezaei", createdAt: ago(60 * 24 * 5 - 20)),
        SupportItem(id: "si-6", conversationID: "sc-3",
                    body: "The AI keeps answering in English on my Persian site. Where do I change that?",
                    createdAt: ago(42)),
        SupportItem(id: "si-7", conversationID: "sc-3", kind: SupportItem.kindJoined, author: SupportItem.authorTeam,
                    senderName: "Ali Rezaei", createdAt: ago(40)),
        SupportItem(id: "si-8", conversationID: "sc-3", author: SupportItem.authorTeam,
                    body: "Hi Sara! Open AI agent → Language and choose «Match the visitor». It takes effect at once.",
                    senderName: "Ali Rezaei", createdAt: ago(38)),
    ]

    // MARK: - Online visitors
    //
    // A spread the screens have to cope with: several countries, one visitor
    // already in a chat, a named contact, an idle tab, a visitor nobody could
    // place on the map, a Persian slug and a very long address.

    func liveVisitors(workspaceID: String, includeOffline: Bool) async throws -> [LiveVisitor] {
        includeOffline ? Self.visitors : Self.visitors.filter { $0.presence != .offline }
    }

    func visitorPageHistory(workspaceID: String, sessionID: String) async throws -> VisitorPageHistory {
        let visitor = Self.visitors.first { $0.id == sessionID }
        let now = visitor?.lastActivityAt ?? Self.ago(1)
        let current = VisitorPageView(url: visitor?.currentPage, title: "Pricing — Webyar", viewedAt: now)
        return VisitorPageHistory(
            items: [
                current,
                VisitorPageView(url: "https://webyar.app/features/live-chat", title: "Live chat", viewedAt: now.addingTimeInterval(-160)),
                VisitorPageView(url: "https://webyar.app/blog/%D8%B1%D8%A7%D9%87%D9%86%D9%85%D8%A7", title: "راهنمای شروع", viewedAt: now.addingTimeInterval(-420)),
            ],
            entry: VisitorPageEntry(
                landingURL: "https://webyar.app/",
                landingTitle: "Webyar — customer messaging",
                landedAt: now.addingTimeInterval(-600),
                referrer: visitor?.referrer
            ),
            current: current
        )
    }

    func visitorMap(workspaceID: String) async throws -> VisitorMap {
        let markers = Self.visitors.compactMap(VisitorMapMarker.init(visitor:))
        return VisitorMap(markers: markers, total: Self.visitors.count, withoutLocation: Self.visitors.count - markers.count)
    }

    func startChatWithVisitor(workspaceID: String, sessionID: String) async throws -> StartVisitorChatResult {
        if let existing = Self.visitors.first(where: { $0.id == sessionID })?.conversation {
            return StartVisitorChatResult(conversationID: existing.id, created: false)
        }
        return StartVisitorChatResult(conversationID: Self.conversations.first?.id, created: true)
    }

    private static let visitors: [LiveVisitor] = [
        LiveVisitor(
            id: "vs-1", presence: .online, currentPage: "https://webyar.app/pricing",
            lastActivityAt: ago(0), startedAt: ago(9), browser: "Chrome 128", device: "desktop", os: "Windows",
            referrer: "https://www.google.com/",
            geo: VisitorGeo(country: "Iran", countryCode: "IR", region: "Tehran", city: "Tehran", latitude: 35.6892, longitude: 51.389),
            ipDisplay: "5.160.xxx.xxx",
            contact: VisitorContactRef(id: "p-1", name: "مریم حسینی", email: "maryam@example.com"),
            conversation: VisitorConversationRef(id: "c-1", status: "open")
        ),
        LiveVisitor(
            id: "vs-2", presence: .online, currentPage: "https://webyar.app/features/live-chat",
            lastActivityAt: ago(1), startedAt: ago(4), browser: "Safari 18", device: "mobile", os: "iOS",
            referrer: "https://www.instagram.com/",
            geo: VisitorGeo(country: "Türkiye", countryCode: "TR", region: "Istanbul", city: "Istanbul", latitude: 41.0082, longitude: 28.9784),
            ipDisplay: "88.241.xxx.xxx",
            contact: VisitorContactRef(id: "ct-2", code: "K7Q2")
        ),
        LiveVisitor(
            id: "vs-3", presence: .idle,
            currentPage: "https://webyar.app/blog/%D8%B1%D8%A7%D9%87%D9%86%D9%85%D8%A7-%DB%8C-%D8%B4%D8%B1%D9%88%D8%B9",
            lastActivityAt: ago(6), startedAt: ago(22), browser: "Firefox 130", device: "desktop", os: "macOS",
            geo: VisitorGeo(country: "Iran", countryCode: "IR", region: "Isfahan", city: "Isfahan", latitude: 32.6546, longitude: 51.668),
            ipDisplay: "151.232.xxx.xxx"
        ),
        LiveVisitor(
            id: "vs-4", presence: .online,
            currentPage: "https://webyar.app/docs/integrations/telegram-and-bale-bots-for-customer-support?utm_source=newsletter",
            lastActivityAt: ago(2), startedAt: ago(14), browser: "Chrome 127", device: "mobile", os: "Android",
            referrer: "https://t.me/",
            geo: VisitorGeo(country: "Germany", countryCode: "DE", region: "Berlin", city: "Berlin", latitude: 52.52, longitude: 13.405),
            ipDisplay: "91.64.xxx.xxx"
        ),
        LiveVisitor(
            id: "vs-5", presence: .online, currentPage: "https://webyar.app/",
            lastActivityAt: ago(0), startedAt: ago(1), browser: "Edge 128", device: "desktop", os: "Windows",
            geo: VisitorGeo(country: "United Arab Emirates", countryCode: "AE", city: "Dubai", latitude: 25.2048, longitude: 55.2708),
            ipDisplay: "94.200.xxx.xxx"
        ),
        LiveVisitor(
            id: "vs-6", presence: .online, currentPage: "https://webyar.app/signup",
            lastActivityAt: ago(3), startedAt: ago(5), browser: "Safari 17", device: "tablet", os: "iPadOS",
            ipDisplay: "—", ipLocked: true
        ),
        LiveVisitor(
            id: "vs-7", presence: .offline, currentPage: "https://webyar.app/contact",
            lastActivityAt: ago(27), startedAt: ago(40), browser: "Chrome 128", device: "desktop", os: "Linux",
            geo: VisitorGeo(country: "Canada", countryCode: "CA", region: "Ontario", city: "Toronto", latitude: 43.6532, longitude: -79.3832),
            ipDisplay: "142.112.xxx.xxx"
        ),
    ]

    // MARK: - Website analytics
    //
    // Numbers with a shape — a weekly rhythm and a slow climb — so the trend
    // reads as a real site rather than as noise.

    func analyticsOverview(workspaceID: String, range: AnalyticsDateRange) async throws -> WebAnalyticsOverview {
        let days = Self.days(range)
        // The period before is a little quieter, so the change chips have
        // something to say in both directions.
        let scale = range.end < Self.todayUTC ? 0.86 : 1.0
        let trend = days.enumerated().map { index, day in
            let weekday = [1.0, 1.08, 1.12, 1.1, 1.02, 0.72, 0.66][index % 7]
            let sessions = Int((180 + Double(index) * 2.4) * weekday * scale)
            return WebAnalyticsDay(date: day, sessions: sessions, pageviews: Int(Double(sessions) * 2.7))
        }
        let sessions = trend.reduce(0) { $0 + $1.sessions }
        let pageviews = trend.reduce(0) { $0 + $1.pageviews }
        return WebAnalyticsOverview(
            sessions: sessions,
            pageviews: pageviews,
            avgPagesPerSession: Double(pageviews) / Double(max(1, sessions)),
            uniqueVisitors: Int(Double(sessions) * 0.74),
            bounceRate: scale < 1 ? 44.8 : 41.2,
            avgVisitDurationSeconds: scale < 1 ? 131 : 154,
            trend: trend,
            topChannels: Self.channels(scale: Double(sessions) / 1000),
            topPages: Array(Self.pages(scale: Double(pageviews) / 1000).prefix(6))
        )
    }

    func analyticsLiveVisitors(workspaceID: String) async throws -> Int {
        Self.visitors.filter { $0.presence == .online }.count
    }

    func analyticsBreakdown(
        workspaceID: String, report: WebAnalyticsBreakdown, dimension: String, range: AnalyticsDateRange
    ) async throws -> WebAnalyticsRows<WebAnalyticsRow> {
        let scale = Double(Self.days(range).count) / 28
        func rows(_ pairs: [(String, Int)]) -> WebAnalyticsRows<WebAnalyticsRow> {
            WebAnalyticsRows(rows: pairs.map { key, n in
                let sessions = Int(Double(n) * scale)
                return WebAnalyticsRow(key: key, label: key, sessions: sessions, pageviews: Int(Double(sessions) * 2.6))
            })
        }
        switch (report, dimension) {
        case (.trafficSources, "channel"):
            return WebAnalyticsRows(rows: Self.channels(scale: scale * 5))
        case (.trafficSources, "source"):
            return rows([("google.com", 1840), ("(direct)", 1320), ("instagram.com", 610), ("t.me", 402), ("bing.com", 96), ("chatgpt.com", 71)])
        case (.trafficSources, _):
            return rows([("autumn-sale", 380), ("newsletter-2026-09", 214), ("(unknown)", 88)])
        case (.geography, "city"):
            return rows([("Tehran", 1710), ("Istanbul", 640), ("Isfahan", 390), ("Mashhad", 288), ("Dubai", 170), ("Berlin", 96)])
        case (.geography, "language"):
            return rows([("fa-IR", 2410), ("tr-TR", 690), ("en-US", 520), ("de-DE", 110), ("ar-AE", 64)])
        case (.geography, "continent"):
            return rows([("Asia", 3420), ("Europe", 520), ("North America", 140)])
        case (.geography, _):
            return rows([("Iran", 2560), ("Turkey", 720), ("Germany", 240), ("United Arab Emirates", 190), ("Canada", 88), ("(unknown)", 42)])
        case (.technology, "device"):
            return rows([("mobile", 2380), ("desktop", 1460), ("tablet", 170)])
        case (.technology, "os"):
            return rows([("Android", 1630), ("Windows", 1120), ("iOS", 760), ("macOS", 330), ("Linux", 90)])
        case (.technology, _):
            return rows([("Chrome", 2410), ("Safari", 820), ("Edge", 360), ("Firefox", 240), ("Samsung Internet", 130)])
        }
    }

    func analyticsPages(workspaceID: String, kind: String, range: AnalyticsDateRange) async throws -> WebAnalyticsRows<WebAnalyticsPage> {
        let scale = Double(Self.days(range).count) / 28 * (kind == "top" ? 5 : 2)
        var pages = Self.pages(scale: scale)
        if kind == "exit" { pages.reverse() }
        return WebAnalyticsRows(rows: pages)
    }

    func analyticsEvents(workspaceID: String, range: AnalyticsDateRange) async throws -> WebAnalyticsRows<WebAnalyticsEvent> {
        WebAnalyticsRows(rows: [
            WebAnalyticsEvent(eventName: "signup_started", count: 412, uniqueSessions: 377, conversionRate: 0.094),
            WebAnalyticsEvent(eventName: "pricing_cta_click", count: 298, uniqueSessions: 251, conversionRate: 0.063),
            WebAnalyticsEvent(eventName: "demo_booked", count: 64, uniqueSessions: 61, conversionRate: 0.015),
            WebAnalyticsEvent(eventName: "chat_opened", count: 1_120, uniqueSessions: 806, conversionRate: 0.201),
        ])
    }

    private static func channels(scale: Double) -> [WebAnalyticsRow] {
        [("organic_search", 410), ("direct", 290), ("organic_social", 150), ("referral", 72), ("paid_search", 38), ("email", 21)]
            .map { key, n in
                let sessions = Int(Double(n) * scale)
                return WebAnalyticsRow(key: key, label: key, sessions: sessions, pageviews: Int(Double(sessions) * 2.8))
            }
    }

    private static func pages(scale: Double) -> [WebAnalyticsPage] {
        [("/", 520), ("/pricing", 344), ("/features/live-chat", 262), ("/blog/راهنمای-شروع", 198),
         ("/docs/integrations/telegram-and-bale-bots-for-customer-support", 121), ("/signup", 96), ("/contact", 44)]
            .map { WebAnalyticsPage(path: $0.0, views: Int(Double($0.1) * scale)) }
    }

    private static var todayUTC: String { dayString(Date()) }

    private static func dayString(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// Every day of a range, oldest first.
    private static func days(_ range: AnalyticsDateRange) -> [String] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        let parser = DateFormatter()
        parser.calendar = calendar
        parser.timeZone = calendar.timeZone
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        guard let start = parser.date(from: range.start), let end = parser.date(from: range.end), start <= end else { return [] }
        var out: [String] = []
        var day = start
        while day <= end, out.count < 400 {
            out.append(parser.string(from: day))
            guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
            day = next
        }
        return out
    }

    // MARK: - Fixtures

    /// The card at the top of the sample support conversation: two
    /// workspaces, one on a paid plan twelve days from running out.
    private static var requesterCard: [String: JSONValue] {
        let day: TimeInterval = 86_400
        let iso = ISO8601DateFormatter()
        func at(_ days: Double) -> String { iso.string(from: Date().addingTimeInterval(days * day)) }
        let json = """
        {"kind":"platform_support_requester","internal":true,
         "user":{"id":"u-9","name":"Alexander Konstantinopoulos","email":"alexander.konstantinopoulos@verylongcompanyname.example",
                 "phone":"+49 30 1234567","company":"Konstantinopoulos Trading","website":"konstantinopoulos.example",
                 "member_since":"\(at(-400))","client_platform":"android","source_workspace":"Trading Shop"},
         "workspace_count":3,
         "workspaces":[
          {"id":"w-a","name":"Trading Shop","role":"owner","status":"active","created_at":"\(at(-400))",
           "plan":{"name":"Business","names":{"fa":"تجاری","tr":"İşletme"},"slug":"business","is_free":false,"status":"active",
                   "period_start":"\(at(-18))","period_end":"\(at(12))","trial_end":null,"cancel_at_period_end":false,
                   "billing_interval":"monthly","started_at":"\(at(-380))"},
           "operators":{"used":4,"limit":5},"contacts":{"used":1820,"limit":5000},
           "usage":{"period":"2026-10","conversations":{"used":930,"limit":1000},"visitors":{"used":12400,"limit":-1},
                    "messages":5210,"ai_credits":{"used":310,"limit":1000},"call_minutes":42,
                    "storage_bytes":3221225472,"storage_limit_gb":10}},
          {"id":"w-b","name":"Second Store","role":"agent","status":"active","created_at":"\(at(-90))",
           "plan":null,"operators":{"used":2,"limit":null},"contacts":{"used":40,"limit":null},
           "usage":{"period":"2026-10","conversations":{"used":12,"limit":null},"visitors":{"used":300,"limit":null},
                    "messages":80,"ai_credits":{"used":0,"limit":null},"call_minutes":0,"storage_bytes":1048576,"storage_limit_gb":null}}],
         "captured_at":"\(at(-0.22))"}
        """
        return (try? JSONDecoder().decode([String: JSONValue].self, from: Data(json.utf8))) ?? [:]
    }

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
            // An operator of another workspace writing to the platform's
            // support from the Android app: «Site user · Android» on the row.
            metadata: ["channel": .string("platform_support"), "client_platform": .string("android")]
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
            metadata: ["channel": .string("telegram")]
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
            metadata: ["channel": .string("whatsapp")]
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
                    body: "ممنون، منتظر می‌مانم.", createdAt: SampleAPI.ago(10),
                    senderName: nil, senderAvatar: nil),
            Message(id: "m-7", conversationId: "c-1", senderType: .agent, senderId: "u-1",
                    body: "بررسی کردم. سفارش در انبار آماده شده ولی هنوز تحویل پست نشده.",
                    createdAt: SampleAPI.ago(9), senderName: "Sara Karimi", senderAvatar: nil),
            Message(id: "m-8", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "یعنی چند روز دیگر طول می‌کشد؟", createdAt: SampleAPI.ago(8),
                    senderName: nil, senderAvatar: nil),
            Message(id: "m-9", conversationId: "c-1", senderType: .agent, senderId: "u-1",
                    body: "امروز تحویل پست می‌شود و معمولاً دو تا سه روز کاری طول می‌کشد.",
                    createdAt: SampleAPI.ago(7), senderName: "Sara Karimi", senderAvatar: nil),
            Message(id: "m-10", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "کد رهگیری‌اش را هم می‌فرستید؟", createdAt: SampleAPI.ago(6),
                    senderName: nil, senderAvatar: nil),
            Message(id: "m-11", conversationId: "c-1", senderType: .agent, senderId: "u-1",
                    body: "بله، به محض ثبت در سامانهٔ پست برایتان می‌فرستم.",
                    createdAt: SampleAPI.ago(5), senderName: "Sara Karimi", senderAvatar: nil),
            Message(id: "m-12", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "ممنون می‌شم", createdAt: SampleAPI.ago(4), senderName: nil, senderAvatar: nil),
            Message(id: "m-13", conversationId: "c-1", senderType: .contact, senderId: nil,
                    body: "سلام، سفارش من هنوز ارسال نشده. می‌تونید وضعیتش رو بررسی کنید؟",
                    createdAt: SampleAPI.ago(3), senderName: nil, senderAvatar: nil),
        ],
        "c-2": [
            // Who is asking, as the server writes it before a support
            // conversation's first message (docs/PLATFORM_SUPPORT.md).
            Message(id: "n-0", conversationId: "c-2", senderType: .system, senderId: nil,
                    body: "Site user: Alexander Konstantinopoulos", createdAt: SampleAPI.ago(321),
                    senderName: nil, senderAvatar: nil, metadata: SampleAPI.requesterCard),
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
    func with(workspaceID newWorkspace: String) -> Conversation {
        Conversation(
            id: id,
            workspaceId: newWorkspace,
            contactId: contactId,
            subject: subject,
            status: status,
            assignedTo: assignedTo,
            priority: priority,
            tags: tags,
            createdAt: createdAt,
            updatedAt: updatedAt,
            contact: contact,
            lastMessage: lastMessage,
            unreadCount: unreadCount,
            aiState: aiState,
            metadata: metadata
        )
    }

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
