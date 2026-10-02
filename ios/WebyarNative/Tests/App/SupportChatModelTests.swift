import Foundation
import XCTest
@testable import WebyarNative

/// `/api/platform-support` in memory, with the server's rules: the same
/// client id is the same item, an ended conversation takes nothing more, and
/// no conversation named starts a new one.
private actor SupportServer: TestAPIBase {
    var conversations: [SupportConversation] = []
    var items: [SupportItem] = []
    var active: String?
    var unread = 0
    /// Every write, as it arrived.
    private(set) var posts: [(body: String, client: String, conversation: String?)] = []
    private(set) var files: [(name: String, mime: String, bytes: Int)] = []
    private(set) var reads = 0
    private(set) var historyReads = 0
    private(set) var ratings: [(id: String, score: Int, comment: String?)] = []
    /// The next writes fail this way, once each.
    var failures: [APIError] = []
    var ratingFailure: APIError?

    func set(conversations: [SupportConversation], items: [SupportItem] = [], active: String?, unread: Int = 0) {
        self.conversations = conversations
        self.items = items
        self.active = active
        self.unread = unread
    }

    func fail(_ errors: [APIError]) { failures = errors }
    func failRating(_ error: APIError?) { ratingFailure = error }

    /// The team closes a conversation from its inbox.
    func end(_ id: String, status: String = SupportConversation.resolved, answered: Bool = true) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].status = status
        conversations[index].endedAt = Date()
        conversations[index].canRate = answered
        if active == id { active = nil }
    }

    func teamWrites(_ body: String, in id: String) {
        items.append(SupportItem(id: "t\(items.count)", conversationID: id, author: SupportItem.authorTeam,
                                 body: body, senderName: "Ali", createdAt: Date()))
        unread += 1
    }

    func supportStatus() async throws -> SupportStatus {
        SupportStatus(enabled: true, available: true, online: true, teamName: "Support", unread: unread)
    }

    func supportHistory() async throws -> SupportHistory {
        historyReads += 1
        return SupportHistory(conversations: conversations, items: items, activeConversationID: active)
    }

    func sendSupportMessage(body: String, clientMessageID: String, conversationID: String?, workspaceID: String?) async throws -> SupportPostResult {
        posts.append((body, clientMessageID, conversationID))
        return try post(body: body, client: clientMessageID, conversationID: conversationID, attachment: nil)
    }

    func sendSupportAttachment(fileName: String, mimeType: String, data: Data, clientMessageID: String, conversationID: String?, workspaceID: String?) async throws -> SupportPostResult {
        files.append((fileName, mimeType, data.count))
        let file = SupportAttachment(id: "f-\(clientMessageID)", fileName: fileName, mimeType: mimeType, sizeBytes: data.count, kind: "image")
        return try post(body: "", client: clientMessageID, conversationID: conversationID, attachment: file)
    }

    private func post(body: String, client: String, conversationID: String?, attachment: SupportAttachment?) throws -> SupportPostResult {
        if !failures.isEmpty { throw failures.removeFirst() }
        let conversation: SupportConversation
        if let conversationID {
            guard let named = conversations.first(where: { $0.id == conversationID }) else {
                throw APIError.server(status: 404, message: "conversation_not_found")
            }
            guard !named.ended else { throw APIError.server(status: 409, message: "conversation_ended") }
            conversation = named
        } else if let active, let open = conversations.first(where: { $0.id == active }) {
            conversation = open
        } else {
            conversation = SupportConversation(id: "new-\(conversations.count)", createdAt: Date())
            conversations.append(conversation)
            active = conversation.id
        }
        let item = SupportItem(id: "i-\(client)", conversationID: conversation.id, body: body, createdAt: Date(),
                               clientMessageID: client, attachments: attachment.map { [$0] } ?? [])
        items.append(item)
        return SupportPostResult(conversation: conversation, item: item)
    }

    func rateSupportConversation(id: String, score: Int, comment: String?) async throws -> SupportConversation {
        ratings.append((id, score, comment))
        if let ratingFailure { throw ratingFailure }
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { throw APIError.server(status: 404, message: nil) }
        conversations[index].rating = SupportRating(score: score, comment: comment, ratedAt: Date())
        conversations[index].canRate = false
        return conversations[index]
    }

    func markSupportRead() async throws {
        reads += 1
        unread = 0
    }
}

@MainActor
final class SupportChatModelTests: XCTestCase {
    private var server: SupportServer!
    private var ids = 0

    override func setUp() async throws {
        server = SupportServer()
        ids = 0
    }

    private func model() -> SupportChatModel {
        SupportChatModel(api: server, makeClientID: { [unowned self] in
            ids += 1
            return "client-\(ids)"
        })
    }

    private let open = SupportConversation(id: "c1", status: SupportConversation.open, createdAt: Date(timeIntervalSinceNow: -600))
    private let resolved = SupportConversation(
        id: "c0", status: SupportConversation.resolved,
        createdAt: Date(timeIntervalSinceNow: -86_400), endedAt: Date(timeIntervalSinceNow: -80_000), canRate: true
    )

    // MARK: Arriving

    func testAnOpenConversationIsWhatTheChatShows() async {
        await server.set(conversations: [resolved, open],
                         items: [SupportItem(id: "i1", conversationID: "c1", body: "Hi", createdAt: Date())], active: "c1")
        let chat = model()
        await chat.open(workspaceID: "w1")
        XCTAssertEqual(chat.content?.composer, .active)
        XCTAssertEqual(chat.content?.shown?.id, "c1")
        XCTAssertEqual(chat.content?.shownItems.map(\.id), ["i1"])
        XCTAssertEqual(chat.content?.closed.map(\.id), ["c0"], "the ended one is behind Closed, not in the chat")
        XCTAssertEqual(chat.status?.teamName, "Support")
    }

    func testWithNothingOpenThePageIsFresh() async {
        await server.set(conversations: [resolved], active: nil)
        let chat = model()
        await chat.open(workspaceID: "w1")
        XCTAssertEqual(chat.content?.composer, .fresh)
        XCTAssertNil(chat.content?.shown)
        XCTAssertEqual(chat.content?.isEmpty, true)
    }

    func testAChatThatNeverArrivedSaysWhyAndOneOnScreenStays() async {
        await server.set(conversations: [open], active: "c1")
        let failing = SupportChatModel(api: FailingSupport())
        failing.language = .en
        await failing.open(workspaceID: nil)
        XCTAssertEqual(failing.state, .failed(SupportStr.unavailable(.en)))

        let chat = model()
        await chat.open(workspaceID: nil)
        XCTAssertNotNil(chat.content)
    }

    // MARK: Writing

    func testAMessageGoesToTheOpenConversationAndBecomesTheServers() async {
        await server.set(conversations: [open], active: "c1")
        let chat = model()
        await chat.open(workspaceID: "w1")
        chat.draft = "  Where are my invoices?  "
        chat.send()
        XCTAssertEqual(chat.draft, "")
        XCTAssertEqual(chat.content?.pending.map(\.body), ["Where are my invoices?"], "shown at once, as sending")
        await chat.settle()
        let posts = await server.posts
        XCTAssertEqual(posts.map(\.conversation), ["c1"])
        XCTAssertEqual(chat.content?.pending, [])
        XCTAssertEqual(chat.content?.shownItems.map(\.clientMessageID), ["client-1"])
    }

    func testTheFirstMessageOnAFreshPageStartsAConversation() async {
        await server.set(conversations: [resolved], active: nil)
        let chat = model()
        await chat.open(workspaceID: "w1")
        chat.draft = "Hello"
        chat.send()
        await chat.settle()
        let posts = await server.posts
        XCTAssertEqual(posts.count, 1)
        XCTAssertNil(posts[0].conversation, "names no conversation")
        XCTAssertEqual(chat.content?.composer, .active)
        XCTAssertEqual(chat.content?.shown?.id, "new-1")
    }

    func testAMessageThatFailedIsRetriedWithItsOwnID() async {
        await server.set(conversations: [open], active: "c1")
        await server.fail([.transport])
        let chat = model()
        chat.language = .en
        await chat.open(workspaceID: "w1")
        chat.draft = "One"
        chat.send()
        await chat.settle()
        XCTAssertEqual(chat.content?.pending.map(\.failed), [true])
        XCTAssertEqual(chat.notice, Str.offlineBody(.en))

        chat.retry("client-1")
        XCTAssertEqual(chat.content?.pending.map(\.failed), [false])
        await chat.settle()
        let posts = await server.posts
        XCTAssertEqual(posts.map(\.client), ["client-1", "client-1"], "the same message, never a second one")
        XCTAssertEqual(chat.content?.pending, [])
    }

    func testMessagesGoInTheOrderTheyWereWritten() async {
        await server.set(conversations: [open], active: "c1")
        let chat = model()
        await chat.open(workspaceID: "w1")
        for text in ["one", "two", "three"] {
            chat.draft = text
            chat.send()
        }
        await chat.settle()
        let posts = await server.posts
        XCTAssertEqual(posts.map(\.body), ["one", "two", "three"])
    }

    func testTooLongIsRefusedBeforeItIsSent() async {
        await server.set(conversations: [open], active: "c1")
        let chat = model()
        chat.language = .en
        await chat.open(workspaceID: "w1")
        chat.draft = String(repeating: "a", count: SupportLimits.maxBody + 1)
        chat.send()
        XCTAssertEqual(chat.notice, SupportStr.messageTooLong(.en, limit: SupportLimits.maxBody))
        XCTAssertEqual(chat.draft.count, SupportLimits.maxBody + 1, "kept, to be shortened")
        XCTAssertEqual(chat.content?.pending, [])
    }

    func testAFileTheServerWouldRefuseIsRefusedHere() async {
        await server.set(conversations: [open], active: "c1")
        let chat = model()
        chat.language = .en
        await chat.open(workspaceID: "w1")

        chat.sendFile(data: Data(count: 10), fileName: "clip.mp4", mimeType: "video/mp4")
        XCTAssertEqual(chat.notice, Str.fileTypeNotAllowed(.en))
        chat.notice = nil
        chat.sendFile(data: Data(count: SupportLimits.maxFileBytes + 1), fileName: "big.png", mimeType: "image/png")
        XCTAssertEqual(chat.notice, SupportStr.fileTooLarge(.en))
        XCTAssertEqual(chat.content?.pending, [])

        chat.sendFile(data: Data(count: 100), fileName: "shot.jpg", mimeType: "image/jpg")
        await chat.settle()
        let files = await server.files
        XCTAssertEqual(files.map(\.mime), ["image/jpeg"], "sent as the server spells it")
        XCTAssertEqual(chat.content?.shownItems.last?.attachments.first?.fileName, "shot.jpg")
    }

    // MARK: Ending

    func testAMessageTheTeamsCloseOvertookGoesBackToTheComposer() async {
        await server.set(conversations: [open], active: "c1")
        let chat = model()
        chat.language = .en
        await chat.open(workspaceID: "w1")
        await server.end("c1")
        chat.draft = "One more thing"
        chat.send()
        await chat.settle()
        XCTAssertEqual(chat.draft, "One more thing", "handed back, never moved to another conversation")
        XCTAssertEqual(chat.notice, SupportStr.conversationEnded(.en))
        XCTAssertEqual(chat.content?.pending, [])
        XCTAssertEqual(chat.content?.composer, .ended, "the end shows, with Start a new conversation")
        XCTAssertEqual(chat.content?.shown?.id, "c1")
        let posts = await server.posts
        XCTAssertEqual(posts.count, 1)
    }

    func testAConversationThatEndsOnScreenStaysUntilANewOneIsStarted() async {
        await server.set(conversations: [open], active: "c1")
        let chat = model()
        await chat.open(workspaceID: "w1")
        await server.end("c1")
        await chat.loadHistory()
        XCTAssertEqual(chat.content?.composer, .ended)
        XCTAssertEqual(chat.content?.shown?.status, SupportConversation.resolved)

        // Nothing is written to it.
        chat.draft = "Hello?"
        chat.send()
        XCTAssertEqual(chat.content?.pending, [])

        let focus = chat.focusRequest
        chat.startNewConversation()
        XCTAssertEqual(chat.content?.composer, .fresh)
        XCTAssertEqual(chat.focusRequest, focus + 1, "straight to typing")

        // A later read keeps the fresh page.
        await chat.loadHistory()
        XCTAssertEqual(chat.content?.composer, .fresh)

        chat.send()
        await chat.settle()
        let posts = await server.posts
        XCTAssertEqual(posts.last?.conversation, nil, "the next message starts a new conversation")
        XCTAssertEqual(chat.content?.composer, .active)
    }

    func testTheTeamReopeningAConversationOpensItAgain() async {
        await server.set(conversations: [resolved], active: nil)
        let chat = model()
        await chat.open(workspaceID: "w1")
        var reopened = resolved
        reopened.status = SupportConversation.open
        reopened.endedAt = nil
        await server.set(conversations: [reopened], active: "c0")
        await chat.loadHistory()
        XCTAssertEqual(chat.content?.composer, .active)
        XCTAssertEqual(chat.content?.shown?.id, "c0")
    }

    // MARK: Rating

    func testAnEndedConversationIsRatedOnce() async {
        await server.set(conversations: [resolved], active: nil)
        let chat = model()
        await chat.open(workspaceID: "w1")
        await chat.rate("c0", score: 4, comment: "  Thanks!  ")
        XCTAssertEqual(chat.content?.conversations.first?.rating?.score, 4)
        XCTAssertEqual(chat.content?.conversations.first?.canRate, false)
        await chat.rate("c0", score: 5, comment: nil)
        let ratings = await server.ratings
        XCTAssertEqual(ratings.count, 1, "rated already: nothing sent")
        XCTAssertEqual(ratings.first?.comment, "Thanks!")
    }

    func testARatingTheServerAlreadyHasReadsTheChatAgain() async {
        await server.set(conversations: [resolved], active: nil)
        await server.failRating(.server(status: 409, message: "already_rated"))
        let chat = model()
        await chat.open(workspaceID: "w1")
        let before = await server.historyReads
        await chat.rate("c0", score: 3, comment: nil)
        let after = await server.historyReads
        XCTAssertEqual(after, before + 1)
        XCTAssertNil(chat.notice)
    }

    func testAScoreOutOfRangeIsNotSent() async {
        await server.set(conversations: [resolved], active: nil)
        let chat = model()
        await chat.open(workspaceID: "w1")
        await chat.rate("c0", score: 0, comment: nil)
        await chat.rate("c0", score: 6, comment: nil)
        let ratings = await server.ratings
        XCTAssertTrue(ratings.isEmpty)
    }

    // MARK: Reading

    func testTheChatIsMarkedReadOnlyWhileOnScreenAndOnlyWhenSomethingIsUnread() async throws {
        await server.set(conversations: [open], active: "c1", unread: 2)
        let chat = model()
        await chat.open(workspaceID: "w1")
        var reads = await server.reads
        XCTAssertEqual(reads, 0, "not on screen yet")

        let (signals, feed) = AsyncStream.makeStream(of: SupportSignal.self)
        let following = Task { await chat.follow(signals) }
        try await Task.sleep(nanoseconds: 300_000_000)
        reads = await server.reads
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(chat.status?.unread, 0)

        // Nothing new: no second read on the next look.
        feed.yield(SupportSignal(kind: SupportSignal.update))
        try await Task.sleep(nanoseconds: 200_000_000)
        reads = await server.reads
        XCTAssertEqual(reads, 1)

        // The team answers: heard, read, and marked.
        await server.teamWrites("Here you go", in: "c1")
        feed.yield(SupportSignal(kind: SupportSignal.message, threadID: "c1"))
        try await Task.sleep(nanoseconds: 300_000_000)
        reads = await server.reads
        XCTAssertEqual(reads, 2)
        XCTAssertEqual(chat.content?.shownItems.last?.body, "Here you go")

        following.cancel()
        feed.finish()
        _ = await following.value
        XCTAssertFalse(chat.isVisible)
    }
}

/// Support switched off on the server.
private struct FailingSupport: TestAPIBase {
    func supportStatus() async throws -> SupportStatus { throw APIError.server(status: 404, message: "support_disabled") }
    func supportHistory() async throws -> SupportHistory { throw APIError.server(status: 404, message: "support_disabled") }
}

/// The closed conversations' screen.
@MainActor
final class SupportArchiveModelTests: XCTestCase {
    func testTheListIsTheEndedOnesAndARatingLandsInIt() async {
        let server = SupportServer()
        let older = SupportConversation(id: "a", status: SupportConversation.closed,
                                        createdAt: Date(timeIntervalSinceNow: -9_000), endedAt: Date(timeIntervalSinceNow: -8_000), canRate: true)
        let newer = SupportConversation(id: "b", status: SupportConversation.resolved,
                                        createdAt: Date(timeIntervalSinceNow: -5_000), endedAt: Date(timeIntervalSinceNow: -4_000))
        let live = SupportConversation(id: "c", createdAt: Date())
        await server.set(
            conversations: [older, newer, live],
            items: [SupportItem(id: "i", conversationID: "a", body: "Invoice?\nthanks", createdAt: Date())],
            active: "c"
        )
        let archive = SupportArchiveModel(api: server)
        await archive.open()
        XCTAssertEqual(archive.closed.map(\.id), ["b", "a"])
        XCTAssertEqual(archive.preview("a"), "Invoice?")
        XCTAssertEqual(archive.items(of: "a").count, 1)

        await archive.rate("a", score: 5, comment: "")
        XCTAssertEqual(archive.conversation("a")?.rating?.score, 5)
        let ratings = await server.ratings
        XCTAssertNil(ratings.first?.comment, "an empty comment is no comment")
    }
}
