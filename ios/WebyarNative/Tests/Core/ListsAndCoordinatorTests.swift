import Foundation
import XCTest
@testable import WebyarNative

/// The shared list reader and the coordinator: fewer requests, never a row of
/// another workspace or account, and the lifecycle iOS asks for.
@MainActor
final class ListsAndCoordinatorTests: XCTestCase {
    private var root: URL!
    private var api: TestAPI!

    override func setUp() async throws {
        root = try temporaryFolder()
        api = TestAPI()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func coordinator() -> SyncCoordinator {
        SyncCoordinator(api: api, persistent: true, storeRoot: root, startsRealtime: false)
    }

    // 4. Cached inbox rendering / 3. offline startup

    func testTheSavedListIsThereOnTheNextLaunchEvenOffline() async throws {
        await api.setList("w1", [try conversation("a"), try conversation("b")], etag: "W/\"1\"")
        let first = coordinator()
        first.sessionChanged(userID: "u1", workspaceID: "w1")
        let fetched = try await first.lists?.fetch(.open)
        XCTAssertEqual(fetched?.map(\.id), ["a", "b"])

        // Next launch, no connection.
        await api.setListError(.transport)
        let second = coordinator()
        second.sessionChanged(userID: "u1", workspaceID: "w1")
        let cached = await second.lists?.cached(.open)
        XCTAssertEqual(cached?.map(\.id), ["a", "b"], "shown before and without the server")
        do {
            _ = try await second.lists?.fetch(.open)
            XCTFail("offline")
        } catch {
            XCTAssertEqual(error as? APIError, .transport)
        }
    }

    // Fewer requests: 304 and sharing

    func testAnUnchangedListComesBackAs304AndKeepsTheCopy() async throws {
        await api.setList("w1", [try conversation("a")], etag: "W/\"1\"")
        let sync = coordinator()
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        guard let lists = sync.lists else { return XCTFail("no lists") }
        _ = try await lists.fetch(.open)
        lists.invalidate()
        let again = try await lists.fetch(.open)
        XCTAssertEqual(again.map(\.id), ["a"])
        let lastTag = await api.lastListETag
        XCTAssertEqual(lastTag, .some("W/\"1\""), "the held copy's ETag went out")
    }

    func testTwoReadersAtOnceShareOneRequest() async throws {
        await api.setList("w1", [try conversation("a")])
        await api.setListDelay("w1", 100_000_000)
        let sync = coordinator()
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        guard let lists = sync.lists else { return XCTFail("no lists") }
        async let one = lists.fetch(.open)
        async let two = lists.fetch(.open)
        _ = try await (one, two)
        let reads = await api.listReadCount
        XCTAssertEqual(reads, 1)
    }

    func testAnEventMeansTheNextReaderAsksTheServer() async throws {
        await api.setList("w1", [try conversation("a")])
        let sync = coordinator()
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        guard let lists = sync.lists else { return XCTFail("no lists") }
        _ = try await lists.fetch(.open)
        _ = try await lists.fetch(.open)
        var reads = await api.listReadCount
        XCTAssertEqual(reads, 1, "within the share window the answer is reused")
        lists.invalidate()
        _ = try await lists.fetch(.open)
        reads = await api.listReadCount
        XCTAssertEqual(reads, 2)
    }

    // 13. Workspace isolation

    func testAWorkspaceSwitchNeverHandsOutTheLastWorkspacesCopy() async throws {
        await api.setList("w1", [try conversation("a", workspace: "w1")])
        let sync = coordinator()
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        _ = try await sync.lists?.fetch(.open)
        let storeOfW1 = sync.store(for: "w1")
        XCTAssertNotNil(storeOfW1)

        sync.sessionChanged(userID: "u1", workspaceID: "w2")
        XCTAssertNil(sync.store(for: "w1"), "the last workspace's store is not reachable any more")
        XCTAssertNil(sync.lists(for: "w1"))
        XCTAssertNil(sync.lists?.cachedInMemory(.open))
        let cachedInW2 = await sync.lists?.cached(.open)
        XCTAssertNil(cachedInW2)
    }

    func testAForeignRowFromTheServerIsNeverListed() async throws {
        await api.setList("w1", [try conversation("mine", workspace: "w1"), try conversation("theirs", workspace: "w2")])
        let sync = coordinator()
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        let list = try await sync.lists?.fetch(.open)
        XCTAssertEqual(list?.map(\.id), ["mine"])
    }

    // 14. Account isolation / 17. logout during sync

    func testSigningOutClosesTheScopeAndAPurgeRemovesTheAccountsFiles() async throws {
        let sync = coordinator()
        sync.sessionChanged(userID: "alice", workspaceID: "w1")
        let store = sync.store(for: "w1")
        await store?.saveThread("c1", .replace([msg("a", at: 1)]), cursor: nil, fullAt: nil)
        let generation = sync.scopeGeneration

        await sync.endSession(userID: "alice", purge: true)
        XCTAssertNil(sync.scope)
        XCTAssertNil(sync.store(for: "w1"))
        XCTAssertNotEqual(sync.scopeGeneration, generation, "a read that lands now knows it is stale")
        XCTAssertFalse(FileManager.default.fileExists(atPath: LocalStore.folder(forUser: "alice", root: root).path))

        // Someone else signs in on the same phone: nothing of Alice's.
        sync.sessionChanged(userID: "bob", workspaceID: "w1")
        let bobs = await sync.store(for: "w1")?.thread("c1")
        XCTAssertNil(bobs)
    }

    func testAnExpiredSessionKeepsTheSameAccountsCopyForItsNextSignIn() async throws {
        let sync = coordinator()
        sync.sessionChanged(userID: "alice", workspaceID: "w1")
        await sync.store(for: "w1")?.saveThread("c1", .replace([msg("a", at: 1)]), cursor: nil, fullAt: nil)
        await sync.endSession(userID: "alice", purge: false)

        sync.sessionChanged(userID: "alice", workspaceID: "w1")
        let again = await sync.store(for: "w1")?.thread("c1")
        XCTAssertEqual(again?.messages.map(\.id), ["a"])
    }

    // 18. Foreground reconciliation / 19. background transition

    func testComingBackToTheForegroundAsksForACatchUpAndBackgroundStopsEverything() async {
        let sync = coordinator()
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        let stream = sync.events()
        var iterator = stream.makeAsyncIterator()

        sync.appEnteredBackground()
        XCTAssertFalse(sync.isForeground)
        XCTAssertFalse(sync.realtimeConnected)

        sync.appBecameActive()
        XCTAssertTrue(sync.isForeground)
        let event = await iterator.next()
        XCTAssertEqual(event, .resync)
    }

    func testBecomingActiveWithoutHavingLeftIsNotACatchUp() async {
        let sync = coordinator()
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        let stream = sync.events()
        sync.appBecameActive()
        sync.emit(.reconcile)
        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first, .reconcile, "no resync was emitted for an app that never left")
    }

    // Push for another workspace is not this one's business

    func testAPushForAnotherWorkspaceIsIgnored() async {
        let sync = coordinator()
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        let stream = sync.events()
        sync.pushArrived(workspaceID: "w2", conversationID: "c9", messageID: "m9")
        sync.pushArrived(workspaceID: "w1", conversationID: "c1", messageID: "m1")
        var iterator = stream.makeAsyncIterator()
        let event = await iterator.next()
        XCTAssertEqual(event, .push(conversationID: "c1", messageID: "m1"))
    }

    // A notification's conversation: never every queue in turn

    func testFindingAConversationTriesTheListsAndTheStoreBeforeOneTargetedRead() async throws {
        await api.setList("w1", [try conversation("listed")])
        await api.setSingle(try conversation("elsewhere"))
        let sync = coordinator()
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        _ = try await sync.lists?.fetch(.open)

        let listed = await sync.conversation(id: "listed", workspaceID: "w1")
        XCTAssertEqual(listed?.id, "listed")
        var singles = await api.singleReads
        XCTAssertEqual(singles, 0, "found in the list already read")

        let elsewhere = await sync.conversation(id: "elsewhere", workspaceID: "w1")
        XCTAssertEqual(elsewhere?.id, "elsewhere")
        singles = await api.singleReads
        XCTAssertEqual(singles, 1)
        let lists = await api.listReadCount
        XCTAssertEqual(lists, 1, "no queue was read to find it")

        // Kept: the next ask is local.
        _ = await sync.conversation(id: "elsewhere", workspaceID: "w1")
        singles = await api.singleReads
        XCTAssertEqual(singles, 1)

        // Not there at all, or of another workspace: nothing.
        let foreign = await sync.conversation(id: "nope", workspaceID: "w1")
        XCTAssertNil(foreign)
    }

    // 30. Cache clear

    func testClearingTheCacheEmptiesTheStoreAndAsksEveryScreenToReadWhole() async throws {
        let sync = coordinator()
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        await sync.store(for: "w1")?.saveThread("c1", .replace([msg("a", at: 1)]), cursor: nil, fullAt: nil)
        let stream = sync.events()
        await sync.clearCache()
        let thread = await sync.store(for: "w1")?.thread("c1")
        XCTAssertNil(thread)
        XCTAssertEqual(sync.scope?.userID, "u1", "still signed in")
        var iterator = stream.makeAsyncIterator()
        let event = await iterator.next()
        XCTAssertEqual(event, .reconcile)
    }

    func testListenersAreForgottenWhenTheyStopListening() async {
        let sync = coordinator()
        let task = Task { for await _ in sync.events() {} }
        let registered = await eventually { sync.listenerCount == 1 }
        XCTAssertTrue(registered)
        task.cancel()
        let forgotten = await eventually { sync.listenerCount == 0 }
        XCTAssertTrue(forgotten)
    }
}
