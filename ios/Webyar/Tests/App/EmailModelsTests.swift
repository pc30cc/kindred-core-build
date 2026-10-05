import Foundation
import XCTest
@testable import Webyar

/// `/api/email-inbox` in memory: two mailboxes, folders, pages of threads,
/// and every write as it arrived.
private actor MailServer: EmailAPI {
    var mailboxes: [EmailMailbox] = [
        EmailMailbox(provider: "gmail", address: "shop@acme.com", status: "connected", unread: 2),
        EmailMailbox(provider: "yahoo", address: "shop@yahoo.com", status: "connected", unread: 1),
    ]
    var folders: [EmailMailFolder] = [
        EmailMailFolder(id: "inbox", unread: 2), EmailMailFolder(id: "sent"),
        EmailMailFolder(id: "label:L1", kind: "label", name: "Clients", unread: 1),
    ]
    /// Threads by "provider|folder".
    var threads: [String: [EmailThreadSummary]] = [:]
    var bodies: [String: EmailThreadResponse] = [:]
    var pageSize = 30
    var historyId: String? = "100"
    var changes = EmailChanges(historyId: "100")
    /// The next list read fails this way, once.
    var listFailure: APIError?
    var writeFailure: APIError?
    var stageFailure: APIError?

    private(set) var pageReads: [(filter: EmailListFilter, before: String?, mailbox: String?, folder: String?)] = []
    private(set) var threadReads: [String] = []
    private(set) var reads: [(id: String, read: Bool)] = []
    private(set) var stars: [(id: String, starred: Bool)] = []
    private(set) var sent: [(draft: EmailDraft, mailbox: String?)] = []
    private(set) var changeReads: [String] = []

    func set(threads: [EmailThreadSummary], provider: String = "gmail", folder: String = "inbox") {
        self.threads["\(provider)|\(folder)"] = threads
    }
    func set(body: EmailThreadResponse) { bodies[body.thread.id] = body }
    /// What moved since a cursor; the mailbox's own cursor moves with it.
    func set(changes: EmailChanges) {
        self.changes = changes
        if let next = changes.historyId { historyId = next }
    }
    func set(pageSize: Int) { self.pageSize = pageSize }
    func failList(_ error: APIError?) { listFailure = error }
    func failWrites(_ error: APIError?) { writeFailure = error }
    func failStaging(_ error: APIError?) { stageFailure = error }

    func emailThreadsPage(
        workspaceID: String, filter: EmailListFilter, before: String?, mailbox: String?, folder: String?
    ) async throws -> EmailThreadsResponse {
        pageReads.append((filter, before, mailbox, folder))
        if let failure = listFailure {
            listFailure = nil
            throw failure
        }
        var all = threads["\(mailbox ?? "gmail")|\(folder ?? "inbox")"] ?? []
        switch filter {
        case .all: break
        case .unread: all = all.filter { $0.isRead != true }
        case .starred: all = all.filter { $0.isStarred == true }
        }
        let start = before.flatMap { id in all.firstIndex { $0.id == id }.map { $0 + 1 } } ?? 0
        let page = Array(all.dropFirst(start).prefix(pageSize))
        let more = start + page.count < all.count
        return EmailThreadsResponse(threads: page, nextBefore: more ? page.last?.id : nil, historyId: historyId)
    }

    func emailThread(workspaceID: String, threadID: String, mailbox: String?, folder: String?) async throws -> EmailThreadResponse {
        threadReads.append(threadID)
        guard let body = bodies[threadID] else { throw APIError.server(status: 404, message: "thread_not_found") }
        return body
    }

    func setEmailThreadRead(workspaceID: String, threadID: String, isRead: Bool, mailbox: String?) async throws {
        reads.append((threadID, isRead))
        if let writeFailure { throw writeFailure }
    }

    func setEmailThreadStarred(workspaceID: String, threadID: String, starred: Bool, mailbox: String?) async throws {
        stars.append((threadID, starred))
        if let writeFailure { throw writeFailure }
    }

    func sendEmailDraft(workspaceID: String, draft: EmailDraft, mailbox: String?) async throws {
        if let writeFailure { throw writeFailure }
        sent.append((draft, mailbox))
    }

    func stageEmailAttachment(
        workspaceID: String, data: Data, filename: String, contentType: String, mailbox: String?
    ) async throws -> StagedEmailAttachment {
        if let stageFailure { throw stageFailure }
        return StagedEmailAttachment(storageKey: "k-\(filename)", filename: filename, contentType: contentType, sizeBytes: data.count)
    }

    func emailAttachmentData(workspaceID: String, attachmentID: String, mailbox: String?) async throws -> Data { Data() }

    func emailMailboxes(workspaceID: String) async throws -> [EmailMailbox] { mailboxes }

    func emailFolders(workspaceID: String, mailbox: String?) async throws -> [EmailMailFolder] { folders }

    func emailChanges(workspaceID: String, since: String, mailbox: String?) async throws -> EmailChanges {
        changeReads.append(since)
        return changes
    }
}

private func thread(
    _ id: String, unread: Bool = false, starred: Bool = false, minutesAgo: Double = 0, count: Int = 1,
    subject: String = "Order", people: [String] = ["sara@x.com"]
) -> EmailThreadSummary {
    EmailThreadSummary(
        id: id, provider: "gmail", subject: subject, participants: people.map(EmailAddress.init),
        lastMessageAt: Date(timeIntervalSince1970: 1_790_000_000 - minutesAgo * 60),
        isRead: !unread, isStarred: starred, labels: nil, lastMessageSnippet: "…", historyId: nil, messageCount: count
    )
}

private func mail(
    _ id: String, from: String, to: [String], cc: [String] = [], outbound: Bool = false, text: String = "Hello"
) -> EmailMessageView {
    EmailMessageView(
        id: id, externalMessageId: nil, direction: outbound ? "outbound" : "inbound", fromAddress: from,
        toAddresses: to.map(EmailAddress.init), ccAddresses: cc.map(EmailAddress.init), textBody: text, htmlBody: nil,
        snippet: nil, isRead: true, deliveryStatus: nil, deliveryError: nil,
        sentAt: Date(timeIntervalSince1970: 1_790_000_000), attachments: nil
    )
}

@MainActor
final class EmailInboxModelTests: XCTestCase {
    private func bound(_ threads: [EmailThreadSummary], pageSize: Int = 30) async -> (EmailInboxModel, MailServer) {
        let server = MailServer()
        await server.set(threads: threads)
        await server.set(pageSize: pageSize)
        let model = EmailInboxModel(api: server)
        await model.bind("w1")
        return (model, server)
    }

    func testTheFirstMailboxWithItsCountsAndItsMenu() async {
        let (model, _) = await bound([thread("t1", unread: true), thread("t2")])
        XCTAssertEqual(model.provider, "gmail")
        XCTAssertEqual(model.address, "shop@acme.com")
        XCTAssertEqual(model.unread, 3, "every mailbox's unread, for the strip")
        XCTAssertEqual(model.state.threads?.map(\.id), ["t1", "t2"])
        XCTAssertEqual(model.folders.map(\.id), ["inbox", "sent", "label:L1"])
        XCTAssertEqual(model.labelNames, ["L1": "Clients"])
        XCTAssertFalse(model.notConnected)
    }

    func testCountingWithoutLoadingAList() async {
        let server = MailServer()
        let model = EmailInboxModel(api: server)
        await model.track("w1")
        XCTAssertEqual(model.unread, 3)
        XCTAssertEqual(model.mailboxes.map(\.provider), ["gmail", "yahoo"])
        XCTAssertEqual(model.state, .loading, "the list is read only when the mailbox opens")
        let reads = await server.pageReads.count
        XCTAssertEqual(reads, 0)
    }

    func testAnotherMailboxOpensOnItsInbox() async {
        let (model, server) = await bound([thread("t1")])
        await server.set(threads: [thread("y1"), thread("y2")], provider: "yahoo")
        await model.selectFolder("sent")
        await model.selectMailbox("yahoo")
        XCTAssertEqual(model.provider, "yahoo")
        XCTAssertEqual(model.address, "shop@yahoo.com")
        XCTAssertEqual(model.folder, "inbox")
        XCTAssertEqual(model.state.threads?.map(\.id), ["y1", "y2"])
    }

    func testFiltersAndFoldersAreTheServers() async {
        let (model, server) = await bound([thread("t1", unread: true), thread("t2", starred: true)])
        await model.selectFilter(.starred)
        XCTAssertEqual(model.state.threads?.map(\.id), ["t2"])
        await model.selectFolder("label:L1")
        XCTAssertEqual(model.filter, .all, "another folder shows everything in it")
        let last = await server.pageReads.last
        XCTAssertEqual(last?.folder, "label:L1")
        XCTAssertEqual(last?.filter, .all)
        XCTAssertEqual(model.shownFolder?.name, "Clients")
    }

    func testTheNextPageWithoutRepeats() async {
        let (model, _) = await bound((1...5).map { thread("t\($0)", minutesAgo: Double($0)) }, pageSize: 2)
        XCTAssertEqual(model.state.threads?.count, 2)
        XCTAssertTrue(model.hasMore)
        await model.loadMore()
        await model.loadMore()
        XCTAssertEqual(model.state.threads?.map(\.id), ["t1", "t2", "t3", "t4", "t5"])
        XCTAssertFalse(model.hasMore)
    }

    func testNoMailboxConnectedIsASetupStepNotAFailure() async {
        let server = MailServer()
        await server.failList(.server(status: 409, message: "email_not_connected"))
        let model = EmailInboxModel(api: server)
        await model.bind("w1")
        XCTAssertTrue(model.notConnected)
        XCTAssertEqual(model.state, .loaded([]))
    }

    func testAFailureIsSaid() async {
        let server = MailServer()
        await server.failList(.server(status: 500, message: nil))
        let model = EmailInboxModel(api: server)
        await model.bind("w1")
        guard case .failed = model.state else { return XCTFail("\(model.state)") }
        await model.retry()
        XCTAssertEqual(model.state, .loaded([]))
    }

    func testTheStarFlipsAtOnceAndBackWhenRefused() async {
        let (model, server) = await bound([thread("t1")])
        await model.toggleStar("t1")
        XCTAssertEqual(model.thread("t1")?.isStarred, true)
        await server.failWrites(.server(status: 500, message: nil))
        await model.toggleStar("t1")
        XCTAssertEqual(model.thread("t1")?.isStarred, true, "refused: back as it was")
        let stars = await server.stars.map(\.starred)
        XCTAssertEqual(stars, [true, false])
    }

    func testOpeningARowTakesItOffTheCounts() async {
        let (model, server) = await bound([thread("t1", unread: true)])
        model.markReadLocally("t1")
        XCTAssertEqual(model.thread("t1")?.isRead, true)
        XCTAssertEqual(model.unread, 2)
        XCTAssertEqual(model.mailboxes.first?.unread, 1)
        XCTAssertEqual(model.folders.first?.unread, 1)
        // Only the row: opening the thread is what tells the server.
        let reads = await server.reads.count
        XCTAssertEqual(reads, 0)
        model.markReadLocally("t1")
        XCTAssertEqual(model.unread, 2, "once")
    }

    func testMarkedUnreadAndBackWhenRefused() async {
        let (model, server) = await bound([thread("t1")])
        await model.setRead("t1", read: false)
        XCTAssertEqual(model.thread("t1")?.isRead, false)
        XCTAssertEqual(model.unread, 4)
        await server.failWrites(.server(status: 500, message: nil))
        await model.setRead("t1", read: true)
        XCTAssertEqual(model.thread("t1")?.isRead, false)
        XCTAssertEqual(model.unread, 4)
    }

    func testWhatChangedIsReadByIdAndTheOpenThreadIsTold() async {
        let (model, server) = await bound([thread("t1")])
        await server.set(threads: [thread("t1", count: 2), thread("t0", unread: true)])
        await server.set(changes: EmailChanges(historyId: "101", threadIds: ["t1", "t0"], contentThreadIds: ["t1"]))
        await model.checkChanges()
        XCTAssertEqual(model.threadChange.threads, ["t1"])
        XCTAssertTrue(model.consumeStale("t1"))
        XCTAssertFalse(model.consumeStale("t1"), "asking clears it")
        XCTAssertEqual(model.state.threads?.map(\.id), ["t1", "t0"])
        // The cursor moved on.
        await model.checkChanges()
        let since = await server.changeReads
        XCTAssertEqual(since, ["100", "101"])
    }

    func testNothingChangedReadsNothing() async {
        let (model, server) = await bound([thread("t1")])
        let before = await server.pageReads.count
        await model.checkChanges()
        let after = await server.pageReads.count
        XCTAssertEqual(before, after)
        XCTAssertEqual(model.threadChange.id, 0)
    }

    func testASignalAboutTheMailboxOnScreenAsksWhatChanged() async {
        let (model, server) = await bound([thread("t1")])
        model.onSignal(EmailSignal(workspaceID: "w1", provider: "gmail"))
        await model.answerSignals(for: "w1")
        let reads = await server.changeReads
        XCTAssertEqual(reads, ["100"])
    }

    func testASignalAboutAnotherMailboxOnlyRecounts() async {
        let (model, server) = await bound([thread("t1")])
        model.onSignal(EmailSignal(workspaceID: "w1", provider: "yahoo"))
        await model.answerSignals(for: "w1")
        let reads = await server.changeReads
        XCTAssertEqual(reads, [])
    }

    func testAThreadReadOnceIsKeptWhileItsContentIsTheSame() async {
        let (model, _) = await bound([thread("t1")])
        let summary = thread("t1", count: 2)
        let response = EmailThreadResponse(thread: summary, messages: [mail("m1", from: "sara@x.com", to: ["shop@acme.com"])])
        model.rememberThread(response, provider: "gmail")
        XCTAssertEqual(model.cachedThread("t1", provider: "gmail", version: summary.version), response)
        XCTAssertNil(model.cachedThread("t1", provider: "gmail", version: thread("t1", count: 3).version))
        XCTAssertNil(model.cachedThread("t1", provider: "gmail", version: summary.version, folder: "spam"), "per folder")
        model.noteChanged("t1")
        XCTAssertNil(model.cachedThread("t1", provider: "gmail", version: summary.version))
        XCTAssertTrue(model.consumeStale("t1"))
    }

    func testAMailSentIsCountedAndItsThreadReadAgain() async {
        let (model, server) = await bound([thread("t1")])
        let before = await server.pageReads.count
        await model.noteSent(answering: "t1")
        XCTAssertEqual(model.sentCount, 1)
        XCTAssertTrue(model.consumeStale("t1"))
        let after = await server.pageReads.count
        XCTAssertEqual(after, before + 1, "the list is read again")
    }
}

@MainActor
final class EmailThreadModelTests: XCTestCase {
    func testOpeningReadsTheTrailAndSaysItWasRead() async {
        let server = MailServer()
        let summary = thread("t1", unread: true)
        await server.set(body: EmailThreadResponse(thread: summary, messages: [mail("m1", from: "sara@x.com", to: ["shop@acme.com"])]))
        let model = EmailThreadModel(api: server)
        var remembered: EmailThreadResponse?
        await model.open(
            workspaceID: "w1", threadID: "t1", known: summary, mailbox: "gmail", cached: nil, folder: nil,
            remember: { remembered = $0 }
        )
        XCTAssertEqual(model.messages.map(\.id), ["m1"])
        XCTAssertEqual(remembered?.thread.id, "t1")
        let reads = await server.reads
        XCTAssertEqual(reads.map(\.id), ["t1"])
        XCTAssertEqual(reads.map(\.read), [true])
    }

    func testAThreadKeptOnThePhoneAsksTheServerNothing() async {
        let server = MailServer()
        let summary = thread("t1")
        let cached = EmailThreadResponse(thread: summary, messages: [mail("m1", from: "sara@x.com", to: ["shop@acme.com"])])
        let model = EmailThreadModel(api: server)
        await model.open(
            workspaceID: "w1", threadID: "t1", known: summary, mailbox: "gmail", cached: cached, folder: nil, remember: { _ in }
        )
        XCTAssertEqual(model.messages.map(\.id), ["m1"])
        let (threadReads, reads) = (await server.threadReads, await server.reads)
        XCTAssertEqual(threadReads, [])
        XCTAssertTrue(reads.isEmpty, "already read")
    }

    func testAFailureIsSaidAndRetried() async {
        let server = MailServer()
        let model = EmailThreadModel(api: server)
        await model.open(workspaceID: "w1", threadID: "t9", known: nil, mailbox: nil, cached: nil, folder: nil, remember: { _ in })
        guard case .failed = model.state else { return XCTFail("\(model.state)") }
        await server.set(body: EmailThreadResponse(thread: thread("t9"), messages: []))
        await model.retry()
        XCTAssertEqual(model.state, .loaded([]))
    }

    func testTheStar() async {
        let server = MailServer()
        let summary = thread("t1")
        await server.set(body: EmailThreadResponse(thread: summary, messages: []))
        let model = EmailThreadModel(api: server)
        await model.open(workspaceID: "w1", threadID: "t1", known: summary, mailbox: "gmail", cached: nil, folder: nil, remember: { _ in })
        await model.toggleStar()
        XCTAssertTrue(model.isStarred)
        let stars = await server.stars.map(\.starred)
        XCTAssertEqual(stars, [true])
    }
}

@MainActor
final class EmailComposeModelTests: XCTestCase {
    private let trail = [
        mail("m1", from: #""Sara" <sara@x.com>"#, to: ["shop@acme.com"], cc: ["ali@x.com"]),
        mail("m2", from: "shop@acme.com", to: ["sara@x.com"], cc: ["ali@x.com", "Shop <SHOP@acme.com>"], outbound: true),
    ]

    func testReplyGoesToTheLastPersonWhoWroteIn() {
        let prefill = EmailComposeModel.prefill(.reply, thread: thread("t1", subject: "Order 42"), messages: trail, mailbox: "shop@acme.com", language: .en)
        XCTAssertEqual(prefill.threadID, "t1")
        XCTAssertEqual(prefill.to, ["sara@x.com"])
        XCTAssertEqual(prefill.cc, [])
        XCTAssertEqual(prefill.subject, "Re: Order 42")
    }

    func testReplyAllCopiesEveryoneElseButTheMailbox() {
        let prefill = EmailComposeModel.prefill(.replyAll, thread: thread("t1", subject: "Re: Order 42"), messages: trail, mailbox: "shop@acme.com", language: .en)
        XCTAssertEqual(prefill.to, ["sara@x.com"])
        XCTAssertEqual(prefill.cc, ["ali@x.com"])
        XCTAssertEqual(prefill.subject, "Re: Order 42", "never «Re: Re:»")
        XCTAssertEqual(
            EmailComposeModel.prefill(.reply, thread: thread("t1", subject: "پاسخ: سفارش"), messages: trail, mailbox: nil, language: .fa).subject,
            "پاسخ: سفارش"
        )
    }

    func testAThreadOnlyEverSentToIsAnsweredToItsPeople() {
        let sentOnly = [mail("m1", from: "shop@acme.com", to: ["deniz@x.com"], outbound: true)]
        let prefill = EmailComposeModel.prefill(
            .reply, thread: thread("t1", people: ["shop@acme.com", "Deniz <deniz@x.com>"]), messages: sentOnly, mailbox: "shop@acme.com", language: .en
        )
        XCTAssertEqual(prefill.to, ["deniz@x.com"])
    }

    func testForwardIsANewThreadWithTheMailUnderneath() {
        let prefill = EmailComposeModel.prefill(.forward, thread: thread("t1", subject: "Order 42"), messages: trail, mailbox: "shop@acme.com", language: .en)
        XCTAssertNil(prefill.threadID)
        XCTAssertEqual(prefill.to, [])
        XCTAssertEqual(prefill.subject, "Fwd: Order 42")
        XCTAssertTrue(prefill.body.contains(EmailStr.forwardedHeader(.en)))
        XCTAssertTrue(prefill.body.contains("From: shop@acme.com"))
        XCTAssertTrue(prefill.body.hasSuffix("Hello"))
    }

    func testWhatStopsAMailIsSaidBeforeItGoes() async {
        let server = MailServer()
        let model = EmailComposeModel(api: server)
        await model.start(workspaceID: "w1", sourceThreadID: nil, mode: nil, mailbox: nil, provider: "gmail")
        XCTAssertEqual(model.problem(), EmailStr.needsRecipient(.en))
        model.fields.to = "sara@x.com, nope"
        XCTAssertEqual(model.problem(), EmailStr.invalidAddresses(.en, "nope"))
        model.fields.to = "sara@x.com"
        XCTAssertEqual(model.problem(), EmailStr.needsSubject(.en))
        model.fields.subject = "Hi"
        XCTAssertNil(model.problem())

        await server.failStaging(.server(status: 413, message: "attachments_too_large"))
        await model.attach(data: Data(count: 10), filename: "a.pdf", contentType: "application/pdf")
        XCTAssertEqual(model.attachments.first?.failed, true)
        XCTAssertEqual(model.problem(), EmailStr.uploadFailed(.en), "a file that did not upload is not dropped silently")
        model.removeAttachment(model.attachments[0].id)
        XCTAssertNil(model.problem())
    }

    func testAReplyIsPrefilledOnceAndSentOnItsThread() async {
        let server = MailServer()
        await server.set(body: EmailThreadResponse(thread: thread("t1", subject: "Order 42"), messages: trail))
        let model = EmailComposeModel(api: server, makeID: { "local-1" })
        await model.start(workspaceID: "w1", sourceThreadID: "t1", mode: .replyAll, mailbox: "shop@acme.com", provider: "gmail")
        XCTAssertTrue(model.ready)
        XCTAssertEqual(model.fields.to, "sara@x.com")
        XCTAssertEqual(model.fields.cc, "ali@x.com")
        XCTAssertTrue(model.showCopies)
        XCTAssertFalse(model.touched, "nothing written yet")

        model.fields.body = "  Thanks!  "
        XCTAssertTrue(model.touched)
        await model.attach(data: Data(count: 4), filename: "a.pdf", contentType: "application/pdf")
        await model.send()
        XCTAssertTrue(model.sent)
        let sent = await server.sent
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.draft.threadID, "t1")
        XCTAssertEqual(sent.first?.draft.to, ["sara@x.com"])
        XCTAssertEqual(sent.first?.draft.cc, ["ali@x.com"])
        XCTAssertEqual(sent.first?.draft.body, "Thanks!")
        XCTAssertEqual(sent.first?.draft.attachments.map(\.storageKey), ["k-a.pdf"])
        XCTAssertEqual(sent.first?.mailbox, "gmail")
    }

    func testAReplyStaysOnItsThreadEvenIfTheThreadCouldNotBeRead() async {
        let server = MailServer()
        let model = EmailComposeModel(api: server)
        await model.start(workspaceID: "w1", sourceThreadID: "gone", mode: .reply, mailbox: nil, provider: nil)
        XCTAssertTrue(model.ready)
        XCTAssertNotNil(model.error)
        model.fields = ComposeFields(to: "sara@x.com", subject: "Re: x", body: "")
        await model.send()
        let sent = await server.sent
        XCTAssertEqual(sent.first?.draft.threadID, "gone")
        XCTAssertEqual(sent.first?.draft.body, " ", "the server needs a body")
    }

    func testARefusedSendIsSaidAndNothingIsLost() async {
        let server = MailServer()
        let model = EmailComposeModel(api: server)
        await model.start(workspaceID: "w1", sourceThreadID: nil, mode: nil, mailbox: nil, provider: nil)
        model.fields = ComposeFields(to: "sara@x.com", subject: "Hi", body: "Body")
        await server.failWrites(.server(status: 502, message: nil))
        await model.send()
        XCTAssertFalse(model.sent)
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.fields.body, "Body")
    }
}
