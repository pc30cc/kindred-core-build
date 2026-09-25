import Foundation
import XCTest
@testable import WebyarNative

/// Every ordering a thread's reads, realtime rows and pushes can arrive in,
/// with the server as the truth and one row per message whatever happens.
final class ThreadSyncTests: XCTestCase {

    // 5. Cached chat rendering

    func testTheSavedThreadShowsAtOnceAndTheFirstReadIsADelta() {
        var sync = ThreadSync()
        let saved = CachedThread(messages: [msg("a", at: 1, updated: 1), msg("b", at: 2, updated: 2)],
                                 cursor: "2026-01-01T00:00:02.000Z", fullAt: t0, complete: true)
        XCTAssertTrue(sync.applyCached(saved))
        XCTAssertEqual(sync.messages.map(\.id), ["a", "b"])
        XCTAssertTrue(sync.fromCache)
        XCTAssertEqual(sync.beginFetch(now: t0.addingTimeInterval(60)).since, "2026-01-01T00:00:02.000Z")
    }

    func testAnOldSavedCopyIsReadWholeOnce() {
        var sync = ThreadSync()
        sync.applyCached(CachedThread(messages: [msg("a", at: 1)], cursor: "c", fullAt: t0, complete: true))
        let later = t0.addingTimeInterval(CachePolicy.fullReconcileInterval + 1)
        XCTAssertNil(sync.beginFetch(now: later).since, "a copy older than the reconcile interval is checked whole")
    }

    func testAServerWithoutCursorsIsAlwaysReadWhole() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1)], delta: false, cursor: nil), now: t0)
        XCTAssertNil(sync.beginFetch(now: t0).since)
    }

    // 6. One-message delta

    func testADeltaMergesAndMovesTheCursor() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: false, cursor: "2026-01-01T00:00:01.000Z"), now: t0)
        XCTAssertEqual(sync.beginFetch(now: t0).since, "2026-01-01T00:00:01.000Z")
        let applied = sync.applyResponse(ThreadPage(messages: [msg("b", at: 2, updated: 2)], delta: true, cursor: "2026-01-01T00:00:02.000Z"), now: t0)
        XCTAssertTrue(applied.changed)
        XCTAssertEqual(sync.messages.map(\.id), ["a", "b"])
        XCTAssertEqual(sync.cursor, "2026-01-01T00:00:02.000Z")
        // Only the changed row goes to the store.
        guard case .upsert(let rows) = applied.write else { return XCTFail("a delta upserts") }
        XCTAssertEqual(rows.map(\.id), ["b"])
    }

    func testAnEmptyDeltaChangesNothingAndWritesNothing() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1)], delta: false, cursor: "2026-01-01T00:00:01.000Z"), now: t0)
        _ = sync.beginFetch(now: t0)
        let applied = sync.applyResponse(ThreadPage(messages: [], delta: true, cursor: "2026-01-01T00:00:01.000Z"), now: t0)
        XCTAssertFalse(applied.changed)
        XCTAssertNil(applied.write)
        XCTAssertEqual(sync.messages.count, 1)
    }

    // 7. Duplicate message

    func testTheSameServerRowTwiceIsShownOnce() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1), msg("a", at: 1, updated: 1)], delta: false, cursor: "c"), now: t0)
        XCTAssertEqual(sync.messages.count, 1)
        // The delta's overlap window sends it again.
        _ = sync.beginFetch(now: t0)
        XCTAssertFalse(sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: true, cursor: "c"), now: t0).changed)
        XCTAssertEqual(sync.messages.count, 1)
    }

    // 8. Out-of-order delta

    func testAnOlderCopyOfARowNeverReplacesANewerOne() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 10, body: "new")], delta: false,
                                      cursor: "2026-01-01T00:00:10.000Z"), now: t0)
        _ = sync.beginFetch(now: t0)
        // A late answer carrying the row as it was before.
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 5, body: "old")], delta: true,
                                      cursor: "2026-01-01T00:00:05.000Z"), now: t0)
        XCTAssertEqual(sync.messages.first?.body, "new")
        XCTAssertEqual(sync.cursor, "2026-01-01T00:00:10.000Z", "the cursor never moves back")
    }

    func testMessagesAreInThreadOrderWhateverOrderTheyArrive() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("c", at: 3), msg("a", at: 1), msg("b", at: 2)], delta: false, cursor: nil), now: t0)
        XCTAssertEqual(sync.messages.map(\.id), ["a", "b", "c"])
    }

    // 9. Realtime + delta of the same message

    func testRealtimeThenDeltaOfTheSameMessageIsOneEnrichedRow() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1, sender: .agent, senderID: "op", name: "Sara")],
                                      delta: false, cursor: "c"), now: t0)
        // Realtime: no updated_at, no sender name — borrowed from the sender's other message.
        XCTAssertTrue(sync.applyRealtime(msg("b", at: 2, sender: .agent, senderID: "op", clientID: "k1")))
        XCTAssertEqual(sync.messages.last?.senderName, "Sara")
        // The delta brings the full row.
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("b", at: 2, updated: 2, sender: .agent, senderID: "op", name: "Sara", clientID: "k1")],
                                      delta: true, cursor: "c2"), now: t0)
        XCTAssertEqual(sync.messages.map(\.id), ["a", "b"])
        XCTAssertEqual(sync.messages.last?.updatedAt, t0.addingTimeInterval(2))
        // A late realtime echo of it changes nothing.
        XCTAssertFalse(sync.applyRealtime(msg("b", at: 2, sender: .agent, senderID: "op")))
        XCTAssertEqual(sync.messages.count, 2)
    }

    func testARealtimeRowKeepsTheFilesItsOlderCopyHad() {
        var sync = ThreadSync()
        let withFile = Message(id: "a", conversationId: "c1", senderType: .contact, senderId: nil, body: "",
                               createdAt: t0, updatedAt: nil, senderName: nil, senderAvatar: nil, metadata: nil,
                               attachments: [MessageAttachment(id: "f1", fileName: "x.jpg", mimeType: "image/jpeg", sizeBytes: 10, kind: "image")])
        sync.applyRealtime(withFile)
        sync.applyRealtime(msg("a", at: 0, body: ""))
        XCTAssertEqual(sync.messages.first?.attachments?.first?.id, "f1")
    }

    func testARealtimeRowThatArrivesDuringAWholeReadIsNotDropped() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyRealtime(msg("late", at: 5))
        // The whole read was taken before "late" existed.
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1, updated: 1)], delta: false, cursor: "c"), now: t0)
        XCTAssertEqual(sync.messages.map(\.id), ["a", "late"])
    }

    // 22. Deleted message

    func testAWholeReadDropsAMessageTheServerNoLongerHas() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1), msg("gone", at: 2)], delta: false, cursor: "c"), now: t0)
        sync.requireWholeRead()
        XCTAssertNil(sync.beginFetch(now: t0).since)
        let applied = sync.applyResponse(ThreadPage(messages: [msg("a", at: 1)], delta: false, cursor: "c"), now: t0)
        XCTAssertEqual(sync.messages.map(\.id), ["a"])
        guard case .replace(let rows) = applied.write else { return XCTFail("a whole read replaces the stored thread") }
        XCTAssertEqual(rows.map(\.id), ["a"])
    }

    func testAServerErrorMakesTheNextReadWholeButALostConnectionDoesNot() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("a", at: 1)], delta: false, cursor: "c"), now: t0)
        _ = sync.beginFetch(now: t0)
        sync.fetchFailed(transport: true)
        XCTAssertEqual(sync.beginFetch(now: t0).since, "c")
        sync.fetchFailed(transport: false)
        XCTAssertNil(sync.beginFetch(now: t0).since)
    }

    func testTheSavedCopyIsIgnoredOnceTheServerHasAnswered() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("new", at: 2)], delta: false, cursor: "c"), now: t0)
        XCTAssertFalse(sync.applyCached(CachedThread(messages: [msg("stale", at: 1)], cursor: "old", fullAt: t0, complete: true)))
        XCTAssertEqual(sync.messages.map(\.id), ["new"])
    }

    // 10. Push + delta (the push names a message already here)

    func testAMessageAlreadyHereIsRecognisedByID() {
        var sync = ThreadSync()
        sync.applyRealtime(msg("m1", at: 1))
        XCTAssertTrue(sync.contains(messageID: "m1"))
        XCTAssertFalse(sync.contains(messageID: "m2"))
    }
}
