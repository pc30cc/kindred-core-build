import SQLite3
import XCTest
@testable import Webyar

/// The local-first cache: the saved store, the thread merge, the shared list
/// reader and the file caches — each ordering the app can meet, with the
/// server as the truth.
private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

@MainActor
final class LocalFirstTests: XCTestCase {
    private var root: URL!
    private var files: URL!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("webyar-tests-\(UUID().uuidString)", isDirectory: true)
        files = root.appendingPathComponent("Files", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        FileCache.folderOverride = files
    }

    override func tearDown() async throws {
        FileCache.folderOverride = nil
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: Helpers


    nonisolated private func msg(_ id: String, at seconds: Double, body: String = "hi", updated: Double? = nil, sender: String = SenderType.contact,
                     senderId: String? = nil, name: String? = nil, clientId: String? = nil) -> Message {
        Message(id: id, conversationId: "c1", senderType: sender, body: body, senderId: senderId,
                createdAt: t0.addingTimeInterval(seconds), updatedAt: updated.map { t0.addingTimeInterval($0) },
                senderName: name, metadata: clientId.map { .object(["client_message_id": .string($0)]) })
    }

    private func store(user: String = "u1", workspace: String = "w1") -> LocalStore {
        LocalStore(scope: .init(userId: user, workspaceId: workspace), root: root)
    }

    nonisolated private func conversation(_ id: String) throws -> Conversation {
        let json = #"{"id":"\#(id)","workspace_id":"w1","status":"open","unread_count":2}"#
        return try JSON.decoder().decode(Conversation.self, from: Data(json.utf8))
    }

    // MARK: 1. Cached load

    func testCachedLoadShowsTheSavedThreadAndAsksOnlyForTheDelta() async {
        let s = store()
        await s.saveThread("c1", messages: [msg("a", at: 1, updated: 1), msg("b", at: 2, updated: 2)], cursor: "2026-01-01T00:00:02Z", fullAt: Date())
        await s.close()

        // A new launch: a new handle on the same file.
        guard let saved = await store().thread("c1") else { return XCTFail("thread not saved") }
        var sync = ThreadSync()
        XCTAssertTrue(sync.applyCached(saved))
        XCTAssertEqual(sync.messages.map(\.id), ["a", "b"])
        XCTAssertTrue(sync.fromCache)
        XCTAssertEqual(sync.beginFetch().since, "2026-01-01T00:00:02Z")
    }

    // MARK: 2. Delta merge

    func testDeltaMergesChangesAndMovesTheCursor() {
        var sync = ThreadSync()
        _ = sync.beginFetch()
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: false, cursor: "c-1"))
        XCTAssertEqual(sync.beginFetch().since, "c-1")
        sync.applyResponse(ThreadPage(messages: [msg("b", at: 2, updated: 2)], delta: true, cursor: "c-2"))
        XCTAssertEqual(sync.messages.map(\.id), ["a", "b"])
        XCTAssertEqual(sync.beginFetch().since, "c-2")
        // An empty delta keeps everything and the cursor.
        sync.applyResponse(ThreadPage(messages: [], delta: true, cursor: nil))
        XCTAssertEqual(sync.messages.count, 2)
        XCTAssertEqual(sync.cursor, "c-2")
    }

    // MARK: 3. Duplicate server message

    func testTheSameServerRowTwiceIsShownOnce() {
        var sync = ThreadSync()
        _ = sync.beginFetch()
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1), msg("a", at: 1, updated: 1)], delta: false, cursor: "c"))
        XCTAssertEqual(sync.messages.count, 1)
        // The delta's overlap sends it again.
        _ = sync.beginFetch()
        XCTAssertFalse(sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: true, cursor: "c")))
        XCTAssertEqual(sync.messages.count, 1)
    }

    // MARK: 4. Realtime + sync of the same message

    func testRealtimeThenReadOfTheSameMessageIsOneEnrichedRow() {
        var sync = ThreadSync()
        _ = sync.beginFetch()
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1, sender: SenderType.agent, senderId: "op", name: "Sara")], delta: false, cursor: "c"))
        // Realtime: no updated_at, no sender name — the name is borrowed from the sender's other message.
        XCTAssertTrue(sync.applyRealtime(msg("b", at: 2, sender: SenderType.agent, senderId: "op", clientId: "k1")))
        XCTAssertEqual(sync.messages.last?.senderName, "Sara")
        // Then the delta brings the full row.
        _ = sync.beginFetch()
        sync.applyResponse(ThreadPage(messages: [msg("b", at: 2, updated: 2, sender: SenderType.agent, senderId: "op", name: "Sara", clientId: "k1")], delta: true, cursor: "c2"))
        XCTAssertEqual(sync.messages.map(\.id), ["a", "b"])
        XCTAssertEqual(sync.messages.last?.updatedAt, t0.addingTimeInterval(2))
        // And a late realtime echo of it changes nothing.
        XCTAssertFalse(sync.applyRealtime(msg("b", at: 2, sender: SenderType.agent, senderId: "op")))
        XCTAssertEqual(sync.messages.count, 2)
    }

    func testARealtimeRowThatArrivesDuringAWholeReadIsNotDropped() {
        var sync = ThreadSync()
        _ = sync.beginFetch()
        sync.applyRealtime(msg("late", at: 5))
        // The whole read was taken before "late" existed.
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: false, cursor: "c"))
        XCTAssertEqual(sync.messages.map(\.id), ["a", "late"])
    }

    // MARK: 5. Workspace isolation

    func testWorkspacesNeverShareASavedCopy() async throws {
        let a = store(workspace: "wA"), b = store(workspace: "wB")
        XCTAssertNotEqual(a.url, b.url)
        await a.saveThread("c1", messages: [msg("a", at: 1)], cursor: nil, fullAt: nil)
        await a.saveList(ConversationLists.key(.open), [try conversation("x")], etag: nil)
        let threadInB = await b.thread("c1")
        let listInB = await b.list(ConversationLists.key(.open))
        XCTAssertNil(threadInB)
        XCTAssertNil(listInB)
    }

    // MARK: 6. Account isolation

    func testAccountsNeverShareASavedCopy() async {
        let a = store(user: "alice"), b = store(user: "bob")
        XCTAssertNotEqual(a.url.deletingLastPathComponent(), b.url.deletingLastPathComponent())
        await a.saveThread("c1", messages: [msg("a", at: 1)], cursor: nil, fullAt: nil)
        let seenByBob = await b.thread("c1")
        XCTAssertNil(seenByBob)
        // The folder names do not spell out the account.
        XCTAssertFalse(a.url.path.contains("alice"))
    }

    // MARK: 7. Cache clear

    func testClearEmptiesEverySavedCopyAndKeepsTheOpenStoreWorking() async throws {
        let open = store(workspace: "w1"), other = store(workspace: "w2")
        await open.saveThread("c1", messages: [msg("a", at: 1)], cursor: "c", fullAt: Date())
        await other.saveThread("c2", messages: [msg("b", at: 1)], cursor: "c", fullAt: Date())
        await other.close()
        FileCache.write(UUID().uuidString, Data(repeating: 1, count: 10))

        FileCache.clear()
        LocalStore.removeAll(except: open.url, root: root)
        await open.reset()

        XCTAssertEqual(FileCache.measure().count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: other.url.path))
        let cleared = await open.thread("c1")
        XCTAssertNil(cleared)
        // An open conversation saves again afterwards.
        await open.saveThread("c1", messages: [msg("a", at: 1)], cursor: "c", fullAt: Date())
        let again = await open.thread("c1")
        XCTAssertEqual(again?.messages.count, 1)
    }

    func testAClearedCacheMakesTheNextThreadReadWhole() {
        var sync = ThreadSync()
        _ = sync.beginFetch()
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: false, cursor: "c"))
        XCTAssertNotNil(sync.beginFetch().since)
        sync.fetchFailed(transport: true)
        sync.requireWholeRead()
        XCTAssertNil(sync.beginFetch().since)
    }

    // MARK: 8. Corrupt recovery

    func testADamagedFileIsRebuiltAndTheAppCarriesOn() async throws {
        let s = store()
        try FileManager.default.createDirectory(at: s.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("this is not a database".utf8).write(to: s.url)
        let nothing = await s.thread("c1")
        XCTAssertNil(nothing)
        await s.saveThread("c1", messages: [msg("a", at: 1)], cursor: nil, fullAt: nil)
        let saved = await s.thread("c1")
        XCTAssertEqual(saved?.messages.map(\.id), ["a"])
    }

    func testAnUnreadableRowIsNotKeptAsTheTruth() async throws {
        let s = store()
        await s.saveThread("c1", messages: [msg("a", at: 1)], cursor: "c", fullAt: Date())
        await s.close()
        // Another build left a row this one cannot read.
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(s.url.path, &db), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(db, "INSERT INTO messages VALUES ('x','c1',2,2,X'7B7B')", nil, nil, nil), SQLITE_OK)
        sqlite3_close(db)

        let reopened = store()
        let first = await reopened.thread("c1")
        XCTAssertNil(first, "a thread with an unreadable row is dropped, not half shown")
        let second = await reopened.thread("c1")
        XCTAssertNil(second)
    }

    func testAnotherSchemaVersionIsRebuilt() async throws {
        let s = store()
        await s.saveThread("c1", messages: [msg("a", at: 1)], cursor: nil, fullAt: nil)
        await s.close()
        var db: OpaquePointer?
        sqlite3_open(s.url.path, &db)
        sqlite3_exec(db, "PRAGMA user_version = 99", nil, nil, nil)
        sqlite3_close(db)
        let reopened = await store().thread("c1")
        XCTAssertNil(reopened)
    }

    // MARK: 9. Offline startup

    func testOfflineAtLaunchTheSavedListShowsAndTheReadFailsQuietly() async throws {
        let s = store()
        let previous = ConversationLists(workspaceId: "w1", store: { s }, fetch: { _, _ in ([try self.conversation("x")], "\"e1\"") })
        _ = try await previous.fetch(.open)

        // Next launch, no connection.
        let lists = ConversationLists(workspaceId: "w1", store: { s }, fetch: { _, _ in throw ApiError(failure: .transport) })
        let saved = await lists.cached(.open)
        XCTAssertEqual(saved?.map(\.id), ["x"])
        do {
            _ = try await lists.fetch(.open)
            XCTFail("offline read should fail")
        } catch {
            XCTAssertTrue(error.isTransport)
        }

        var sync = ThreadSync()
        sync.applyCached(CachedThread(messages: [msg("a", at: 1)], cursor: "c", fullAt: Date(), complete: true))
        _ = sync.beginFetch()
        sync.fetchFailed(transport: true)
        XCTAssertEqual(sync.messages.map(\.id), ["a"], "a failed read never blanks what is on show")
    }

    // MARK: 10. Reconnect reconciliation

    func testAReconnectMakesTheNextReadWhole() {
        var sync = ThreadSync()
        _ = sync.beginFetch()
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1), msg("gone", at: 2, updated: 2)], delta: false, cursor: "c"))
        XCTAssertEqual(sync.beginFetch().since, "c")
        sync.fetchFailed(transport: true)
        sync.requireWholeRead()
        XCTAssertNil(sync.beginFetch().since)
        // The whole read is the truth: a message deleted meanwhile goes.
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: false, cursor: "c2"))
        XCTAssertEqual(sync.messages.map(\.id), ["a"])
    }

    func testAnOldWholeReadIsRepeatedEvenWithACursor() {
        var sync = ThreadSync()
        let then = Date()
        _ = sync.beginFetch(now: then)
        sync.applyResponse(ThreadPage(messages: [], delta: false, cursor: "c"), now: then)
        XCTAssertEqual(sync.beginFetch(now: then.addingTimeInterval(5)).since, "c")
        XCTAssertNil(sync.beginFetch(now: then.addingTimeInterval(CachePolicy.fullReconcileInterval + 1)).since)
    }

    // MARK: 11. Out-of-order messages

    func testMessagesArrivingOutOfOrderShowInThreadOrder() {
        var sync = ThreadSync()
        sync.applyRealtime(msg("m2", at: 20))
        sync.applyRealtime(msg("m1", at: 10))
        XCTAssertEqual(sync.messages.map(\.id), ["m1", "m2"])
        _ = sync.beginFetch()
        sync.applyResponse(ThreadPage(messages: [msg("m3", at: 30, updated: 30), msg("m0", at: 5, updated: 5)], delta: true, cursor: nil))
        XCTAssertEqual(sync.messages.map(\.id), ["m0", "m1", "m2", "m3"])
    }

    // MARK: 12. Edited record

    func testAnEditedRowReplacesTheOldOneButNeverTheOtherWayRound() {
        var sync = ThreadSync()
        _ = sync.beginFetch()
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, body: "draft", updated: 1)], delta: false, cursor: "c"))
        _ = sync.beginFetch()
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, body: "delivered", updated: 5)], delta: true, cursor: "c2"))
        XCTAssertEqual(sync.messages.first?.body, "delivered")
        // An older version (an overlap re-send, a late realtime echo) does not roll it back.
        _ = sync.beginFetch()
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, body: "draft", updated: 1)], delta: true, cursor: "c2"))
        XCTAssertEqual(sync.messages.first?.body, "delivered")
        sync.applyRealtime(msg("a", at: 1, body: "draft"))
        XCTAssertEqual(sync.messages.first?.body, "delivered")
    }

    // MARK: 13. Logout

    func testSigningOutDeletesTheAccountsCopyAndStopsWrites() async {
        let s = store(user: "alice")
        await s.saveThread("c1", messages: [msg("a", at: 1)], cursor: nil, fullAt: nil)
        let other = store(user: "bob")
        await other.saveThread("c1", messages: [msg("b", at: 1)], cursor: nil, fullAt: nil)

        await s.destroy()
        LocalStore.removeUser("alice", root: root)
        XCTAssertFalse(FileManager.default.fileExists(atPath: s.url.path))
        // A save still in flight from the old session writes nothing.
        await s.saveThread("c1", messages: [msg("late", at: 2)], cursor: nil, fullAt: nil)
        XCTAssertFalse(FileManager.default.fileExists(atPath: s.url.path))
        // The other account on this Mac is untouched.
        let bobs = await other.thread("c1")
        XCTAssertEqual(bobs?.messages.map(\.id), ["b"])
    }

    // MARK: 14. Rapid workspace switch

    func testRapidWorkspaceSwitchesKeepEachWorkspacesWritesApart() async {
        // A → B → A → B, each with saves still landing from the one before.
        let stores = ["wA", "wB", "wA", "wB"].map { store(workspace: $0) }
        let rows = stores.indices.map { msg("m\($0)", at: Double($0)) }
        await withTaskGroup(of: Void.self) { group in
            for (s, m) in zip(stores, rows) {
                group.addTask {
                    await s.saveThread("c-\(s.scope.workspaceId)", messages: [m], cursor: nil, fullAt: nil)
                }
            }
        }
        for s in stores { await s.close() }
        let a = store(workspace: "wA"), b = store(workspace: "wB")
        let crossA = await a.thread("c-wB")
        let crossB = await b.thread("c-wA")
        let ownA = await a.thread("c-wA")
        let ownB = await b.thread("c-wB")
        XCTAssertNil(crossA)
        XCTAssertNil(crossB)
        XCTAssertNotNil(ownA)
        XCTAssertNotNil(ownB)
    }

    func testAListReaderOnlyWritesItsOwnWorkspace() async throws {
        let a = store(workspace: "wA"), b = store(workspace: "wB")
        var current: LocalStore = a
        // What AppModel hands it: the open store, only if it is this workspace's.
        let lists = ConversationLists(workspaceId: "wA", store: { current.scope.workspaceId == "wA" ? current : nil },
                                      fetch: { _, _ in ([try self.conversation("x")], nil) })
        current = b // switched before the read landed
        _ = try await lists.fetch(.open)
        let inB = await b.list(ConversationLists.key(.open))
        XCTAssertNil(inB)
    }

    // MARK: 15. Concurrent attachment request

    func testManyViewsAskingForOneFileDownloadItOnce() async throws {
        var calls = 0
        let payload = Data("voice".utf8)
        let store = AttachmentStore(fetch: { _ in
            calls += 1
            try await Task.sleep(nanoseconds: 50_000_000)
            return payload
        })
        let id = UUID().uuidString
        async let r1 = store.data(id)
        async let r2 = store.data(id)
        async let r3 = store.data(id)
        let results = try await [r1, r2, r3]
        XCTAssertEqual(calls, 1)
        XCTAssertTrue(results.allSatisfy { $0 == payload })
        XCTAssertEqual(store.downloading, 0)
    }

    // MARK: 16. Failed attachment download

    func testAFailedDownloadIsNotRememberedAsAFailure() async throws {
        var calls = 0
        let store = AttachmentStore(fetch: { _ in
            calls += 1
            if calls == 1 { throw ApiError(failure: .transport) }
            return Data("ok".utf8)
        })
        let id = UUID().uuidString
        do {
            _ = try await store.data(id)
            XCTFail("first download should fail")
        } catch {}
        XCTAssertEqual(store.downloading, 0)
        let second = try await store.data(id)
        XCTAssertEqual(second, Data("ok".utf8))
        XCTAssertEqual(calls, 2)
    }

    func testADamagedPictureOnDiskIsFetchedAgain() async throws {
        let id = UUID().uuidString
        FileCache.write(id, Data("not a picture".utf8))
        let png = NSImage(size: NSSize(width: 2, height: 2), flipped: false) { r in NSColor.red.setFill(); r.fill(); return true }
        let pngData = NSBitmapImageRep(data: png.tiffRepresentation!)!.representation(using: .png, properties: [:])!
        var calls = 0
        let store = AttachmentStore(fetch: { _ in calls += 1; return pngData })
        let image = await store.image(id)
        XCTAssertNotNil(image)
        XCTAssertEqual(calls, 1)
    }

    // MARK: 17. Cache eviction

    func testTheLeastRecentlyUsedFilesGoFirst() throws {
        let fm = FileManager.default
        var ids: [String] = []
        for i in 0..<5 {
            let id = UUID().uuidString
            ids.append(id)
            FileCache.write(id, Data(repeating: UInt8(i), count: 1_000))
            let url = files.appendingPathComponent(id.lowercased() + ".bin")
            try fm.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(1_000 + i))], ofItemAtPath: url.path)
        }
        FileCache.trim(maxBytes: 4_000, trimTo: 3_000)
        XCTAssertNil(FileCache.read(ids[0]))
        XCTAssertNil(FileCache.read(ids[1]))
        XCTAssertNotNil(FileCache.read(ids[4]))
        XCTAssertEqual(FileCache.measure().count, 3)
    }

    func testALongThreadKeepsItsNewestMessagesAndIsReadWholeNextTime() async {
        let s = store()
        let many = (0..<(CachePolicy.maxMessagesPerThread + 5)).map { msg("m\($0)", at: Double($0)) }
        await s.saveThread("c1", messages: many, cursor: "c", fullAt: Date())
        guard let saved = await s.thread("c1") else { return XCTFail("not saved") }
        XCTAssertEqual(saved.messages.count, CachePolicy.maxMessagesPerThread)
        XCTAssertEqual(saved.messages.last?.id, many.last?.id)
        XCTAssertFalse(saved.complete)
        var sync = ThreadSync()
        sync.applyCached(saved)
        XCTAssertNil(sync.beginFetch().since, "an incomplete copy cannot be completed by a delta")
    }

    func testThreadsNotOpenedForLongArePruned() async {
        let s = store()
        await s.saveThread("old", messages: [msg("a", at: 1)], cursor: nil, fullAt: nil)
        await s.prune(now: Date().addingTimeInterval(CachePolicy.threadRetention + 60))
        let old = await s.thread("old")
        XCTAssertNil(old)
    }

    // MARK: Lists: coalescing and revalidation

    func testTheInboxAndTheNotifierShareOneRequest() async throws {
        var calls = 0
        let lists = ConversationLists(workspaceId: "w1", store: { nil }, fetch: { _, _ in
            calls += 1
            try await Task.sleep(nanoseconds: 50_000_000)
            return ([try self.conversation("x")], nil)
        })
        async let inbox = lists.fetch(.open)
        async let notifier = lists.fetch(.open)
        _ = try await (inbox, notifier)
        XCTAssertEqual(calls, 1)
        // Right after, the notifier's tick is served the same answer…
        _ = try await lists.fetch(.open)
        XCTAssertEqual(calls, 1)
        // …but not after a realtime event said something changed.
        lists.invalidate()
        _ = try await lists.fetch(.open)
        XCTAssertEqual(calls, 2)
    }

    func testAnUnchangedListComesBackAs304AndKeepsTheCopy() async throws {
        let s = store()
        var sentTags: [String?] = []
        let lists = ConversationLists(workspaceId: "w1", store: { s }, fetch: { _, etag in
            sentTags.append(etag)
            if etag == "\"v1\"" { return (nil, "\"v1\"") }
            return ([try self.conversation("x")], "\"v1\"")
        })
        let first = try await lists.fetch(.open, sharedWithin: 0)
        let second = try await lists.fetch(.open, sharedWithin: 0)
        XCTAssertEqual(sentTags, [nil, "\"v1\""])
        XCTAssertEqual(first.map(\.id), ["x"])
        XCTAssertEqual(second.map(\.id), ["x"])
    }

    // MARK: Realtime payload

    func testARealtimeMessageEnvelopeCarriesTheRow() throws {
        let json = #"{"type":"message","payload":{"id":"m1","conversation_id":"c1","sender_type":"contact","body":"salam","created_at":"2026-09-25T10:00:00.000Z","metadata":{"client_message_id":"k"}}}"#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let event = CentrifugoProtocol.event(value)
        XCTAssertEqual(event?.message?.id, "m1")
        XCTAssertEqual(event?.message?.body, "salam")
        XCTAssertEqual(event?.message?.metadata?["client_message_id"]?.string, "k")
        // A typing nudge carries no message.
        let typing = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"type":"typing","payload":{"conversation_id":"c1"}}"#.utf8))
        XCTAssertNil(CentrifugoProtocol.event(typing)?.message)
    }

    func testSignedLinksOfOnePictureShareOneCacheKey() {
        let a = URL(string: "https://cdn.example.com/a/p.jpg?X-Amz-Signature=1&X-Amz-Date=2&v=3")!
        let b = URL(string: "https://cdn.example.com/a/p.jpg?X-Amz-Signature=9&X-Amz-Date=8&v=3")!
        let other = URL(string: "https://cdn.example.com/a/q.jpg?X-Amz-Signature=1")!
        XCTAssertEqual(ImageStore.cacheKey(a), ImageStore.cacheKey(b))
        XCTAssertNotEqual(ImageStore.cacheKey(a), ImageStore.cacheKey(other))
        XCTAssertEqual(ImageStore.cacheKey(URL(string: "https://cdn.example.com/p.jpg")!), "https://cdn.example.com/p.jpg")
    }
}
