import Foundation
import SQLite3
import XCTest
@testable import WebyarNative

/// The saved copy on the phone: what survives a relaunch, what never crosses
/// an account or a workspace, and what happens to a damaged or foreign file.
final class LocalStoreTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = try temporaryFolder()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func store(user: String = "u1", workspace: String = "w1") -> LocalStore {
        LocalStore(scope: .init(userID: user, workspaceID: workspace), root: root)
    }

    // 1. Empty cache cold start

    func testAnEmptyStoreHasNothingToShow() async {
        let s = store()
        let thread = await s.thread("c1")
        let list = await s.list(ConversationLists.key(.open))
        let one = await s.conversation("c1")
        XCTAssertNil(thread)
        XCTAssertNil(list)
        XCTAssertNil(one)
    }

    // 2. Populated cache cold start

    func testASavedThreadAndListSurviveARelaunch() async throws {
        let s = store()
        await s.saveThread("c1", .replace([msg("a", at: 1, updated: 1), msg("b", at: 2, updated: 2, clientID: "k-1")]),
                           cursor: "2026-01-01T00:00:02.000Z", fullAt: t0)
        await s.saveList(ConversationLists.key(.open), [try conversation("x"), try conversation("y")], etag: "W/\"1\"")
        await s.close()

        // A new launch: a new handle on the same file.
        let reopened = store()
        let thread = await reopened.thread("c1")
        XCTAssertEqual(thread?.messages.map(\.id), ["a", "b"])
        XCTAssertEqual(thread?.messages.last?.clientMessageID, "k-1")
        XCTAssertEqual(thread?.cursor, "2026-01-01T00:00:02.000Z")
        XCTAssertEqual(thread?.complete, true)
        // Dates come back to the millisecond, so a stored copy merges like the server's.
        XCTAssertEqual(thread?.messages.first?.updatedAt, t0.addingTimeInterval(1))
        let list = await reopened.list(ConversationLists.key(.open))
        XCTAssertEqual(list?.conversations.map(\.id), ["x", "y"])
        XCTAssertEqual(list?.etag, "W/\"1\"")
        let one = await reopened.conversation("y")
        XCTAssertEqual(one?.contact?.name, "Visitor y")
    }

    // 6. One-message delta: only the changed row is written

    func testADeltaUpsertsWithoutRewritingTheThread() async {
        let s = store()
        await s.saveThread("c1", .replace([msg("a", at: 1, updated: 1), msg("b", at: 2, updated: 2)]), cursor: "c-1", fullAt: t0)
        await s.saveThread("c1", .upsert([msg("b", at: 2, updated: 5, body: "edited"), msg("c", at: 3, updated: 3)]), cursor: "c-2", fullAt: t0)
        let thread = await s.thread("c1")
        XCTAssertEqual(thread?.messages.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(thread?.messages[1].body, "edited")
        XCTAssertEqual(thread?.cursor, "c-2")
    }

    func testALongThreadKeepsItsNewestAndIsMarkedIncomplete() async {
        let s = store()
        let many = (0..<(CachePolicy.maxMessagesPerThread + 5)).map { msg("m\($0)", at: Double($0), updated: Double($0)) }
        await s.saveThread("c1", .replace(many), cursor: "c", fullAt: t0)
        let thread = await s.thread("c1")
        XCTAssertEqual(thread?.messages.count, CachePolicy.maxMessagesPerThread)
        XCTAssertEqual(thread?.messages.last?.id, "m\(CachePolicy.maxMessagesPerThread + 4)")
        // A delta cannot give back what was cut: the next read must be whole.
        XCTAssertEqual(thread?.complete, false)
        var sync = ThreadSync()
        if let thread { sync.applyCached(thread) }
        XCTAssertNil(sync.beginFetch(now: t0).since)
    }

    // 13. Workspace isolation

    func testWorkspacesNeverShareASavedCopy() async throws {
        let a = store(workspace: "wA"), b = store(workspace: "wB")
        XCTAssertNotEqual(a.url, b.url)
        await a.saveThread("c1", .replace([msg("a", at: 1)]), cursor: nil, fullAt: nil)
        await a.saveList(ConversationLists.key(.open), [try conversation("x", workspace: "wA")], etag: nil)
        let threadInB = await b.thread("c1")
        let listInB = await b.list(ConversationLists.key(.open))
        XCTAssertNil(threadInB)
        XCTAssertNil(listInB)
    }

    func testARowOfAnotherWorkspaceIsNeverSavedInThisOne() async throws {
        let a = store(workspace: "w1")
        await a.saveList(ConversationLists.key(.open), [try conversation("mine", workspace: "w1"), try conversation("theirs", workspace: "w2")], etag: nil)
        let list = await a.list(ConversationLists.key(.open))
        XCTAssertEqual(list?.conversations.map(\.id), ["mine"])
    }

    // 14. Account isolation

    func testAccountsNeverShareASavedCopy() async {
        let alice = store(user: "alice"), bob = store(user: "bob")
        XCTAssertNotEqual(alice.url.deletingLastPathComponent(), bob.url.deletingLastPathComponent())
        await alice.saveThread("c1", .replace([msg("a", at: 1)]), cursor: nil, fullAt: nil)
        let seenByBob = await bob.thread("c1")
        XCTAssertNil(seenByBob)
        // The folder names do not spell out the account or the workspace.
        XCTAssertFalse(alice.url.path.contains("alice"))
        XCTAssertFalse(alice.url.path.contains("w1"))
    }

    func testRemovingAnAccountLeavesTheOthers() async {
        let alice = store(user: "alice"), bob = store(user: "bob")
        await alice.saveThread("c1", .replace([msg("a", at: 1)]), cursor: nil, fullAt: nil)
        await bob.saveThread("c1", .replace([msg("b", at: 1)]), cursor: nil, fullAt: nil)
        await alice.close()
        LocalStore.removeUser("alice", root: root)
        XCTAssertFalse(FileManager.default.fileExists(atPath: alice.url.path))
        let bobs = await bob.thread("c1")
        XCTAssertEqual(bobs?.messages.map(\.id), ["b"])
    }

    // 20. Corrupt local DB

    func testADamagedFileIsRebuiltEmptyAndKeepsWorking() async throws {
        let s = store()
        await s.saveThread("c1", .replace([msg("a", at: 1)]), cursor: nil, fullAt: nil)
        await s.close()
        // Overwrite it with garbage, as a crash mid-write on a bad disk might.
        try Data(repeating: 0xAB, count: 8192).write(to: s.url)
        for suffix in ["-wal", "-shm"] { try? FileManager.default.removeItem(atPath: s.url.path + suffix) }

        let reopened = store()
        let thread = await reopened.thread("c1")
        XCTAssertNil(thread, "a damaged file must not be half-trusted")
        await reopened.saveThread("c1", .replace([msg("b", at: 2)]), cursor: nil, fullAt: nil)
        let after = await reopened.thread("c1")
        XCTAssertEqual(after?.messages.map(\.id), ["b"], "the rebuilt store works")
    }

    func testAnUnreadableRowDropsItsThreadRatherThanShowingPartOfIt() async throws {
        let s = store()
        await s.saveThread("c1", .replace([msg("a", at: 1), msg("b", at: 2)]), cursor: "c", fullAt: t0)
        await s.close()
        // A row this build cannot decode (written by a future one, or damaged).
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(s.url.path, &db), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(db, "UPDATE messages SET json = x'00ff' WHERE id = 'b'", nil, nil, nil), SQLITE_OK)
        sqlite3_close(db)

        let reopened = store()
        let thread = await reopened.thread("c1")
        XCTAssertNil(thread)
        let again = await reopened.thread("c1")
        XCTAssertNil(again, "dropped, to be read whole from the server")
    }

    // 21. Migration

    func testAStoreFromAnotherSchemaVersionIsRebuilt() async throws {
        let s = store()
        await s.saveThread("c1", .replace([msg("a", at: 1)]), cursor: nil, fullAt: nil)
        await s.close()
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(s.url.path, &db), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(db, "PRAGMA user_version = 99", nil, nil, nil), SQLITE_OK)
        sqlite3_close(db)

        let reopened = store()
        let thread = await reopened.thread("c1")
        XCTAssertNil(thread, "another version's cache is not migrated, it is rebuilt")
        await reopened.saveThread("c1", .replace([msg("b", at: 2)]), cursor: nil, fullAt: nil)
        let after = await reopened.thread("c1")
        XCTAssertEqual(after?.messages.map(\.id), ["b"])
        await reopened.close()

        var check: OpaquePointer?
        XCTAssertEqual(sqlite3_open(s.url.path, &check), SQLITE_OK)
        var statement: OpaquePointer?
        sqlite3_prepare_v2(check, "PRAGMA user_version", -1, &statement, nil)
        XCTAssertEqual(sqlite3_step(statement), SQLITE_ROW)
        XCTAssertEqual(sqlite3_column_int(statement, 0), CachePolicy.schemaVersion)
        sqlite3_finalize(statement)
        sqlite3_close(check)
    }

    // 23. Deleted conversation

    func testAForgottenConversationLeavesEveryList() async throws {
        let s = store()
        await s.saveList(ConversationLists.key(.open), [try conversation("x"), try conversation("y")], etag: nil)
        await s.saveThread("x", .replace([msg("a", at: 1, conversation: "x")]), cursor: nil, fullAt: nil)
        await s.forgetConversation("x")
        let list = await s.list(ConversationLists.key(.open))
        let thread = await s.thread("x")
        let one = await s.conversation("x")
        XCTAssertEqual(list?.conversations.map(\.id), ["y"])
        XCTAssertNil(thread)
        XCTAssertNil(one)
    }

    // 30. Cache clear

    func testResetEmptiesEverythingAndStaysUsable() async throws {
        let s = store()
        await s.saveThread("c1", .replace([msg("a", at: 1)]), cursor: nil, fullAt: nil)
        await s.saveList(ConversationLists.key(.open), [try conversation("x")], etag: nil)
        await s.reset()
        let stats = await s.stats()
        XCTAssertEqual(stats.threads, 0)
        XCTAssertEqual(stats.messages, 0)
        XCTAssertEqual(stats.conversations, 0)
        await s.saveThread("c1", .replace([msg("b", at: 1)]), cursor: nil, fullAt: nil)
        let thread = await s.thread("c1")
        XCTAssertEqual(thread?.messages.map(\.id), ["b"])
    }

    func testClearingKeepsTheOpenFileAndRemovesTheOthers() async {
        let open = store(workspace: "w1"), other = store(workspace: "w2")
        await open.saveThread("c1", .replace([msg("a", at: 1)]), cursor: nil, fullAt: nil)
        await other.saveThread("c1", .replace([msg("b", at: 1)]), cursor: nil, fullAt: nil)
        await other.close()
        LocalStore.removeAll(except: open.url, root: root)
        XCTAssertTrue(FileManager.default.fileExists(atPath: open.url.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: other.url.path))
    }

    func testPruningDropsThreadsNotOpenedForAMonth() async {
        let s = store()
        await s.saveThread("old", .replace([msg("a", at: 1, conversation: "old")]), cursor: nil, fullAt: nil)
        await s.prune(now: Date().addingTimeInterval(CachePolicy.threadRetention + 60), allowVacuum: true)
        let thread = await s.thread("old")
        XCTAssertNil(thread)
    }

    func testCountsSurviveARelaunch() async {
        let s = store()
        let counts = try? StoreCoding.decoder().decode(InboxCounts.self, from: Data(#"{"open":3,"pending":1}"#.utf8))
        if let counts { await s.saveCounts(counts) }
        await s.close()
        let reopened = await store().counts()
        XCTAssertEqual(reopened?.open, 3)
        XCTAssertEqual(reopened?.pending, 1)
    }
}
