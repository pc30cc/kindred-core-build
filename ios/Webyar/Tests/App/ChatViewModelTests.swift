import Foundation
import XCTest
@testable import Webyar

/// The thread screen end to end against a scripted server: the saved copy
/// first, deltas after, and one message per message whatever brings it back.
@MainActor
final class ChatViewModelTests: XCTestCase {
    private var root: URL!
    private var api: TestAPI!
    private var sync: SyncCoordinator!
    private var appState: AppState!

    override func setUp() async throws {
        root = try temporaryFolder()
        api = TestAPI()
        sync = SyncCoordinator(api: api, persistent: true, storeRoot: root, startsRealtime: false)
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        appState = AppState(api: api)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func model() throws -> ChatViewModel {
        ChatViewModel(conversation: try conversation("c1"), api: api, sync: sync)
    }

    // 2./5. Populated cache: the transcript is on screen before the server answers

    func testTheSavedTranscriptShowsBeforeTheServerAnswersAndOnlyTheDeltaIsAsked() async throws {
        await sync.store(for: "w1")?.saveThread("c1", .replace([msg("a", at: 1, updated: 1)]),
                                               cursor: "2026-09-25T10:00:00.000Z", fullAt: Date(),
                                               older: nil, olderKnown: true)
        await api.setPages("c1", [ThreadPage(messages: [msg("b", at: 2, updated: 2)], delta: true, cursor: "2026-09-25T10:00:02.000Z")])
        await api.setThreadDelay(300_000_000)
        let vm = try model()
        let loading = Task { await vm.load(appState: appState) }

        let early = await eventually(timeout: 0.25) { vm.state.value?.map(\.id) == ["a"] }
        XCTAssertTrue(early, "the saved copy, not a spinner, while the server is asked")

        await loading.value
        XCTAssertEqual(vm.state.value?.map(\.id), ["a", "b"])
        let since = await api.lastThreadSince
        XCTAssertEqual(since, .some("2026-09-25T10:00:00.000Z"), "only what changed since the saved cursor")

        // 6. The delta reached the store: the next open starts from it.
        let saved = await eventually { await self.sync.store(for: "w1")?.thread("c1")?.cursor == "2026-09-25T10:00:02.000Z" }
        XCTAssertTrue(saved)
    }

    // 3. Offline with a saved copy

    func testOfflineKeepsTheSavedTranscriptAndSaysSo() async throws {
        await sync.store(for: "w1")?.saveThread("c1", .replace([msg("a", at: 1)]), cursor: "c", fullAt: Date())
        await api.setThreadError(.transport)
        let vm = try model()
        await vm.load(appState: appState)
        XCTAssertEqual(vm.state.value?.map(\.id), ["a"], "content is not replaced with an error")
        XCTAssertEqual(vm.syncStatus, .offline)
    }

    func testOfflineWithNothingSavedIsStillAnError() async throws {
        await api.setThreadError(.transport)
        let vm = try model()
        await vm.load(appState: appState)
        guard case .failed(.transport) = vm.state else { return XCTFail("nothing to show: the error screen") }
    }

    // 11. Optimistic send + HTTP success + realtime echo + delta + push = one message

    func testASentMessageIsShownOnceWhateverBringsItBack() async throws {
        await api.setPages("c1", [ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: false, cursor: "2026-09-25T10:00:01.000Z")])
        let vm = try model()
        await vm.load(appState: appState)
        let listening = Task { await vm.listen() }
        defer { listening.cancel() }
        _ = await eventually { self.sync.listenerCount >= 1 }

        vm.draft = "salam"
        await vm.send(appState: appState)
        let keys = await api.sentKeys
        let key = try XCTUnwrap(keys.first)
        XCTAssertEqual(vm.draft, "")
        XCTAssertEqual(vm.state.value?.filter { $0.clientMessageID == key }.count, 1)
        XCTAssertFalse(vm.state.value?.contains(where: \.isPending) ?? true, "the pending bubble gave way to the server's row")

        // Realtime echo of the same row, then the push for it.
        let echo = Message(id: "srv-\(key)", conversationId: "c1", senderType: .agent, senderId: "me", body: "salam",
                           createdAt: Date(), updatedAt: nil, senderName: nil, senderAvatar: nil,
                           metadata: ["client_message_id": .string(key)])
        sync.emit(.message(conversationID: "c1", message: echo))
        sync.emit(.push(conversationID: "c1", messageID: echo.id))
        try await Task.sleep(nanoseconds: 700_000_000)

        XCTAssertEqual(vm.state.value?.filter { $0.clientMessageID == key }.count, 1)
        XCTAssertEqual(vm.state.value?.count, 2)
        XCTAssertEqual(vm.state.value?.last?.senderName, "Me", "the echo did not strip the server row")
    }

    func testThePendingBubbleShowsAtOnceAndGivesWayToTheServersRow() async throws {
        await api.setPages("c1", [ThreadPage(messages: [], delta: false, cursor: nil)])
        await api.setSendDelay(300_000_000)
        let vm = try model()
        await vm.load(appState: appState)
        vm.draft = "one"
        let sending = Task { await vm.send(appState: appState) }
        let pending = await eventually(timeout: 0.25) { vm.state.value?.first?.isPending == true }
        XCTAssertTrue(pending, "shown before the server answers")
        XCTAssertEqual(vm.state.value?.first?.body, "one")
        await sending.value
        XCTAssertEqual(vm.state.value?.count, 1)
        XCTAssertEqual(vm.state.value?.first?.isPending, false)
    }

    // 12. A retry is the same message

    func testARetryOfTheSameWordsUsesTheSameKey() async throws {
        await api.setPages("c1", [ThreadPage(messages: [], delta: false, cursor: nil)])
        await api.setSendFailures([.beforeInsert])
        let vm = try model()
        await vm.load(appState: appState)

        vm.draft = "hello"
        await vm.send(appState: appState)
        XCTAssertTrue(vm.sendFailed)
        XCTAssertEqual(vm.draft, "hello", "nothing typed is lost")
        XCTAssertFalse(vm.state.value?.contains(where: \.isPending) ?? true)

        await vm.send(appState: appState)
        let keys = await api.sentKeys
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys[0], keys[1], "one logical message, one key")
        XCTAssertEqual(vm.state.value?.count, 1)
    }

    func testAnAnswerLostAfterTheServerKeptItIsStillOneMessage() async throws {
        await api.setPages("c1", [ThreadPage(messages: [], delta: false, cursor: nil)])
        await api.setSendFailures([.afterInsert])
        let vm = try model()
        await vm.load(appState: appState)

        vm.draft = "hello"
        await vm.send(appState: appState)
        XCTAssertEqual(vm.draft, "hello")
        await vm.send(appState: appState)

        let inserted = await api.inserted["c1"] ?? []
        XCTAssertEqual(inserted.count, 1, "the server collapsed the replay")
        XCTAssertEqual(vm.state.value?.count, 1)
        XCTAssertEqual(vm.draft, "")
    }

    func testEditedWordsAfterAFailureAreANewMessage() async throws {
        await api.setPages("c1", [ThreadPage(messages: [], delta: false, cursor: nil)])
        await api.setSendFailures([.beforeInsert])
        let vm = try model()
        await vm.load(appState: appState)
        vm.draft = "helo"
        await vm.send(appState: appState)
        vm.draft = "hello"
        await vm.send(appState: appState)
        let keys = await api.sentKeys
        XCTAssertNotEqual(keys[0], keys[1])
    }

    // 10. Push for a message already here: nothing is read for it

    func testAPushForAMessageAlreadyShownReadsNothing() async throws {
        await api.setPages("c1", [ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: false, cursor: "2026-09-25T10:00:01.000Z")])
        let vm = try model()
        await vm.load(appState: appState)
        let listening = Task { await vm.listen() }
        defer { listening.cancel() }
        _ = await eventually { self.sync.listenerCount >= 1 }
        let before = await api.threadReadCount

        sync.emit(.push(conversationID: "c1", messageID: "a"))
        sync.emit(.push(conversationID: "other", messageID: "x"))
        try await Task.sleep(nanoseconds: 600_000_000)
        var after = await api.threadReadCount
        XCTAssertEqual(after, before)

        sync.emit(.push(conversationID: "c1", messageID: "new"))
        _ = await eventually { await self.api.threadReadCount == before + 1 }
        after = await api.threadReadCount
        XCTAssertEqual(after, before + 1, "a push for a message not here yet reads the delta")
    }

    func testABurstOfRealtimeMessagesIsOneRead() async throws {
        await api.setPages("c1", [ThreadPage(messages: [], delta: false, cursor: "2026-09-25T10:00:00.000Z")])
        let vm = try model()
        await vm.load(appState: appState)
        let listening = Task { await vm.listen() }
        defer { listening.cancel() }
        _ = await eventually { self.sync.listenerCount >= 1 }
        let before = await api.threadReadCount
        for i in 0..<5 { sync.emit(.message(conversationID: "c1", message: msg("rt\(i)", at: Double(i)))) }
        _ = await eventually { vm.state.value?.count == 5 }
        XCTAssertEqual(vm.state.value?.count, 5, "realtime rows show at once")
        try await Task.sleep(nanoseconds: 800_000_000)
        let after = await api.threadReadCount
        XCTAssertEqual(after, before + 1)
    }

    // 15./16./17. An answer for a scope that is no longer open is dropped

    func testAnAnswerThatLandsAfterTheWorkspaceChangedIsDropped() async throws {
        await api.setPages("c1", [ThreadPage(messages: [msg("a", at: 1)], delta: false, cursor: "c")])
        await api.setThreadDelay(200_000_000)
        let vm = try model()
        let loading = Task { await vm.load(appState: appState) }
        try await Task.sleep(nanoseconds: 50_000_000)
        sync.sessionChanged(userID: "u1", workspaceID: "w2")
        await loading.value
        XCTAssertFalse(vm.state.isLoaded, "not shown for a workspace no longer open")

        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        let saved = await sync.store(for: "w1")?.thread("c1")
        XCTAssertNil(saved, "and not saved either")
    }

    // 22./23. A conversation the server no longer has

    func testAConversationTheServerNoLongerHasIsForgotten() async throws {
        await sync.store(for: "w1")?.saveThread("c1", .replace([msg("a", at: 1)]), cursor: "c", fullAt: Date())
        await api.setThreadError(.server(status: 404, message: nil))
        let vm = try model()
        await vm.load(appState: appState)
        guard case .failed = vm.state else { return XCTFail("gone") }
        let saved = await sync.store(for: "w1")?.thread("c1")
        XCTAssertNil(saved)
    }

    // 30. Clearing the cache while the thread is open keeps it on screen

    func testClearingTheCacheKeepsWhatIsOnScreenAndReadsItWhole() async throws {
        await api.setPages("c1", [ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: false, cursor: "2026-09-25T10:00:01.000Z")])
        let vm = try model()
        await vm.load(appState: appState)
        let listening = Task { await vm.listen() }
        defer { listening.cancel() }
        _ = await eventually { self.sync.listenerCount >= 1 }

        await sync.clearCache()
        XCTAssertEqual(vm.state.value?.map(\.id), ["a"], "nothing collapses under the operator")
        _ = await eventually {
            let reads = await self.api.threadReadCount
            let since = await self.api.lastThreadSince
            return reads >= 2 && since == .some(nil)
        }
        let since = await api.lastThreadSince
        XCTAssertEqual(since, .some(nil), "the next read is a whole one")
    }

    // MARK: - Paging (docs/operations/THREAD_PAGING_APPS.md)

    /// The thread opens with its newest 100, not the server's default 1000.
    func testTheThreadOpensWithItsNewestHundred() async throws {
        await api.setPages("c1", [ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: false, cursor: "2026-09-25T10:00:01.000Z")])
        let vm = try model()
        await vm.load(appState: appState)
        let first = await api.threadRequests.first
        XCTAssertEqual(first, ThreadSync.Request(since: nil, limit: 100, before: nil))
        XCTAssertFalse(vm.canLoadEarlier, "the page reached the thread's start")
    }

    /// Hard case 2: a newest page with nothing to show (hidden menu taps)
    /// while earlier messages exist is read past, so the thread never opens empty.
    func testAnEmptyNewestPageIsReadPast() async throws {
        let first = OlderCursor(before: "2026-09-25T10:00:50.123456+00:00", beforeID: "x50")
        let second = OlderCursor(before: "2026-09-25T10:00:40.123456+00:00", beforeID: "x40")
        await api.setPages("c1", [ThreadPage(messages: [], delta: false, cursor: "2026-09-25T10:00:50.000Z", older: first)])
        await api.setOlderPage(before: "x50", ThreadPage(messages: [], delta: false, cursor: nil, older: second))
        await api.setOlderPage(before: "x40", ThreadPage(messages: [msg("m3", at: 3, updated: 3)], delta: false, cursor: nil,
                                                         older: OlderCursor(before: "2026-09-25T10:00:03.000+00:00", beforeID: "m3")))
        let vm = try model()
        await vm.load(appState: appState)
        XCTAssertEqual(vm.state.value?.map(\.id), ["m3"])
        XCTAssertTrue(vm.canLoadEarlier)
        let asked = await api.threadRequests.map(\.before?.beforeID)
        XCTAssertEqual(asked, [nil, "x50", "x40"], "the raw cursors, as the server sent them")
        // The newest page's cursor is the thread's, not the pages read past.
        let saved = await eventually { await self.sync.store(for: "w1")?.thread("c1")?.cursor == "2026-09-25T10:00:50.000Z" }
        XCTAssertTrue(saved)
    }

    /// Hard cases 4 and 7: loading earlier puts the page before the transcript,
    /// keeps the reader's row (the anchor), never moves the cursor, and saves
    /// where the run now starts.
    func testLoadingEarlierPrependsKeepsTheAnchorAndTheCursor() async throws {
        let older = OlderCursor(before: "2026-09-25T10:00:10.123456+00:00", beforeID: "m10")
        await api.setPages("c1", [ThreadPage(messages: [msg("m10", at: 10, updated: 10), msg("m11", at: 11, updated: 11)],
                                             delta: false, cursor: "2026-09-25T10:00:11.000Z", older: older)])
        await api.setOlderPage(before: "m10", ThreadPage(messages: [msg("m8", at: 8, updated: 90), msg("m9", at: 9, updated: 90)],
                                                         delta: false, cursor: "2026-09-25T10:01:30.000Z", older: nil))
        let vm = try model()
        await vm.load(appState: appState)
        XCTAssertTrue(vm.canLoadEarlier)
        let added = await vm.loadEarlier()
        XCTAssertTrue(added)
        XCTAssertEqual(vm.state.value?.map(\.id), ["m8", "m9", "m10", "m11"])
        XCTAssertEqual(vm.prependCount, 1)
        XCTAssertEqual(vm.prependAnchor, "m10", "the row that was first stays where the reader saw it")
        XCTAssertFalse(vm.canLoadEarlier, "the start of the thread")
        let saved = await eventually {
            let t = await self.sync.store(for: "w1")?.thread("c1")
            return t?.messages.count == 4 && t?.olderKnown == true && t?.older == nil
        }
        XCTAssertTrue(saved)
        let cursor = await sync.store(for: "w1")?.thread("c1")?.cursor
        XCTAssertEqual(cursor, "2026-09-25T10:00:11.000Z", "an older page never moves the cursor")
    }

    /// The top row coming into view loads earlier, once the screen settled.
    func testTheTopRowInViewLoadsEarlier() async throws {
        await api.setPages("c1", [ThreadPage(messages: [msg("m10", at: 10, updated: 10)], delta: false, cursor: "2026-09-25T10:00:10.000Z",
                                             older: OlderCursor(before: "2026-09-25T10:00:10.000+00:00", beforeID: "m10"))])
        await api.setOlderPage(before: "m10", ThreadPage(messages: [msg("m9", at: 9, updated: 9)], delta: false, cursor: nil, older: nil))
        let vm = try model()
        await vm.load(appState: appState)
        vm.topRow(visible: true)
        let loaded = await eventually { vm.state.value?.map(\.id) == ["m9", "m10"] }
        XCTAssertTrue(loaded)
    }

    /// Hard case 8: a thread saved before paging (no start known) is shown at
    /// once, then read from its newest page, never as a delta.
    func testACopySavedBeforePagingIsReadFromItsNewestPage() async throws {
        await sync.store(for: "w1")?.saveThread("c1", .replace([msg("a", at: 1, updated: 1)]),
                                               cursor: "2026-09-25T10:00:01.000Z", fullAt: Date())
        await api.setPages("c1", [ThreadPage(messages: [msg("a", at: 1, updated: 1), msg("b", at: 2, updated: 2)],
                                             delta: false, cursor: "2026-09-25T10:00:02.000Z", older: nil)])
        let vm = try model()
        await vm.load(appState: appState)
        XCTAssertEqual(vm.state.value?.map(\.id), ["a", "b"])
        let first = await api.threadRequests.first
        XCTAssertEqual(first, ThreadSync.Request(since: nil, limit: 100, before: nil))
    }
}
