import Foundation
import XCTest
@testable import WebyarNative

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
                                               cursor: "2026-09-25T10:00:00.000Z", fullAt: Date())
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
}
