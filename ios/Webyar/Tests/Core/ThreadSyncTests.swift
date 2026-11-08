import Foundation
import XCTest
@testable import Webyar

/// Every ordering a thread's reads, realtime rows and pushes can arrive in,
/// with the server as the truth and one row per message whatever happens.
final class ThreadSyncTests: XCTestCase {

    // 5. Cached chat rendering

    func testTheSavedThreadShowsAtOnceAndTheFirstReadIsADelta() {
        var sync = ThreadSync()
        let saved = CachedThread(messages: [msg("a", at: 1, updated: 1), msg("b", at: 2, updated: 2)],
                                 cursor: "2026-01-01T00:00:02.000Z", fullAt: t0, complete: true,
                                 older: nil, olderKnown: true)
        XCTAssertTrue(sync.applyCached(saved))
        XCTAssertEqual(sync.messages.map(\.id), ["a", "b"])
        XCTAssertTrue(sync.fromCache)
        XCTAssertEqual(sync.beginFetch(now: t0.addingTimeInterval(60)).since, "2026-01-01T00:00:02.000Z")
    }

    func testAnOldSavedCopyIsReadWholeOnce() {
        var sync = ThreadSync()
        sync.applyCached(CachedThread(messages: [msg("a", at: 1)], cursor: "c", fullAt: t0, complete: true,
                                      older: nil, olderKnown: true))
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

    // MARK: - Paging (docs/operations/THREAD_PAGING_APPS.md)

    /// The whole-read interval (stage 2, 2026-11-08): an hour, as on Windows.
    func testTheNewestPageIsReadAgainHourly() {
        XCTAssertEqual(CachePolicy.fullReconcileInterval, 60 * 60)
        XCTAssertEqual(CachePolicy.threadPageSize, 100)
    }

    func testTheFirstReadIsTheNewestPageOfAHundred() {
        var sync = ThreadSync()
        let request = sync.beginFetch(now: t0)
        XCTAssertNil(request.since)
        XCTAssertEqual(request.limit, 100)
        XCTAssertNil(request.before)
    }

    /// Hard case 1: a delta (or realtime) row older than the loaded run lies
    /// above a hole and is not added; a held row is still updated.
    func testADeltaRowOlderThanTheRunIsDroppedAndAHeldOneIsUpdated() {
        var sync = paged(rows: [msg("m10", at: 10, updated: 10), msg("m11", at: 11, updated: 11)], olderAt: 10, olderID: "m10")
        _ = sync.beginFetch(now: t0)
        let applied = sync.applyResponse(ThreadPage(
            messages: [msg("m2", at: 2, updated: 20), msg("m11", at: 11, updated: 21, body: "seen"), msg("m12", at: 12, updated: 22)],
            delta: true, cursor: stamp(22)
        ), now: t0)
        XCTAssertEqual(sync.messages.map(\.id), ["m10", "m11", "m12"])
        XCTAssertEqual(sync.messages[1].body, "seen")
        guard case .upsert(let rows) = applied.write else { return XCTFail("a delta upserts") }
        XCTAssertEqual(Set(rows.map(\.id)), ["m11", "m12"])
        XCTAssertFalse(sync.applyRealtime(msg("m3", at: 3)), "a realtime row above the run is not shown")
        XCTAssertTrue(sync.applyRealtime(msg("m13", at: 13)))
    }

    /// Hard case 1, at the thread's start: nothing is above a hole.
    func testADeltaRowIsAlwaysAddedWhenTheRunReachesTheStart() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("m10", at: 10, updated: 10)], delta: false, cursor: stamp(10), older: nil), now: t0)
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("m2", at: 2, updated: 20)], delta: true, cursor: stamp(20)), now: t0)
        XCTAssertEqual(sync.messages.map(\.id), ["m2", "m10"])
    }

    /// Hard case 3: `older` is kept as the server's raw strings, microseconds
    /// and all, and asked for exactly so.
    func testTheOlderCursorIsKeptAsTheServerSentIt() {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        let raw = OlderCursor(before: "2026-09-21T13:46:40.123456+00:00", beforeID: "m10")
        sync.applyResponse(ThreadPage(messages: [msg("m10", at: 10, updated: 10)], delta: false, cursor: stamp(10), older: raw), now: t0)
        XCTAssertTrue(sync.canLoadEarlier)
        XCTAssertEqual(sync.olderRequest(), ThreadSync.Request(since: nil, limit: 100, before: raw))
    }

    /// Hard case 4: an older page adds its rows before the run, takes its
    /// `older`, and never moves the cursor or `fullAt`.
    func testAnOlderPageGoesBeforeTheRunAndNeverMovesTheCursor() {
        var sync = paged(rows: [msg("m10", at: 10, updated: 10), msg("m11", at: 11, updated: 11)], olderAt: 10, olderID: "m10")
        let cursor = sync.cursor, fullAt = sync.fullAt
        let asked = sync.olderRequest()!.before!
        let applied = sync.applyOlder(ThreadPage(
            messages: [msg("m8", at: 8, updated: 99), msg("m9", at: 9, updated: 99)],
            delta: false, cursor: stamp(99), older: OlderCursor(before: stamp(8), beforeID: "m8")
        ), asked: asked)
        XCTAssertEqual(applied?.changed, true)
        XCTAssertEqual(sync.messages.map(\.id), ["m8", "m9", "m10", "m11"])
        XCTAssertEqual(sync.cursor, cursor)
        XCTAssertEqual(sync.fullAt, fullAt)
        XCTAssertEqual(sync.older?.beforeID, "m8")
        guard case .upsert(let rows) = applied?.write else { return XCTFail("an older page upserts") }
        XCTAssertEqual(rows.map(\.id), ["m8", "m9"])
        // The start of the thread: nothing more to ask for.
        _ = sync.applyOlder(ThreadPage(messages: [msg("m7", at: 7)], delta: false, cursor: nil, older: nil),
                            asked: OlderCursor(before: stamp(8), beforeID: "m8"))
        XCTAssertFalse(sync.canLoadEarlier)
        XCTAssertNil(sync.olderRequest())
    }

    /// Hard case 4: an older page asked before the run restarted is dropped.
    func testAnOlderPageForARunThatMovedIsDropped() {
        var sync = paged(rows: [msg("m10", at: 10, updated: 10)], olderAt: 10, olderID: "m10")
        let asked = sync.olderRequest()!.before!
        // Meanwhile more than a page arrived: the newest page does not touch the run.
        _ = sync.beginFetch(now: t0)
        sync.applyResponse(ThreadPage(messages: [msg("m50", at: 50, updated: 50)], delta: false, cursor: stamp(50),
                                      older: OlderCursor(before: stamp(50), beforeID: "m50")), now: t0)
        XCTAssertNil(sync.applyOlder(ThreadPage(messages: [msg("m9", at: 9)], delta: false, cursor: nil, older: nil), asked: asked))
        XCTAssertEqual(sync.messages.map(\.id), ["m50"])
    }

    /// Hard case 5: a newest-page refresh keeps the older pages still next to
    /// it, and reconciles its own range (hard case 6: deletions in it go).
    func testANewestPageKeepsContiguousOlderPagesAndDropsDeletionsInItsRange() {
        var sync = paged(rows: [msg("m10", at: 10, updated: 10), msg("m11", at: 11, updated: 11), msg("m12", at: 12, updated: 12)],
                         olderAt: 11, olderID: "m11")
        _ = sync.applyOlder(ThreadPage(messages: [msg("m5", at: 5, updated: 5)], delta: false, cursor: nil,
                                       older: OlderCursor(before: stamp(5), beforeID: "m5")),
                            asked: sync.olderRequest()!.before!)
        XCTAssertEqual(sync.messages.map(\.id), ["m5", "m10", "m11", "m12"])
        // The refresh: its page starts at m11; m12 was deleted, m13 is new.
        _ = sync.beginFetch(now: t0.addingTimeInterval(3_601))
        let applied = sync.applyResponse(ThreadPage(
            messages: [msg("m11", at: 11, updated: 11), msg("m13", at: 13, updated: 13)],
            delta: false, cursor: stamp(13), older: OlderCursor(before: stamp(11), beforeID: "m11")
        ), now: t0.addingTimeInterval(3_601))
        XCTAssertEqual(sync.messages.map(\.id), ["m5", "m10", "m11", "m13"])
        XCTAssertEqual(sync.older?.beforeID, "m5", "the run still starts where its oldest page did")
        guard case .replace(let rows) = applied.write else { return XCTFail("a newest page replaces") }
        XCTAssertEqual(rows.map(\.id), ["m5", "m10", "m11", "m13"])
    }

    /// Hard case 5: more than a page arrived: the run restarts from the page,
    /// never with a hole.
    func testANewestPageThatDoesNotTouchTheRunRestartsIt() {
        var sync = paged(rows: [msg("m10", at: 10, updated: 10), msg("m11", at: 11, updated: 11)], olderAt: 10, olderID: "m10")
        _ = sync.beginFetch(now: t0.addingTimeInterval(3_601))
        sync.applyResponse(ThreadPage(
            messages: [msg("m40", at: 40, updated: 40), msg("m41", at: 41, updated: 41)],
            delta: false, cursor: stamp(41), older: OlderCursor(before: stamp(40), beforeID: "m40")
        ), now: t0.addingTimeInterval(3_601))
        XCTAssertEqual(sync.messages.map(\.id), ["m40", "m41"])
        XCTAssertEqual(sync.older?.beforeID, "m40")
    }

    /// Hard case 5: a realtime row that landed while the newest page was out stays.
    func testARealtimeRowThatLandedDuringTheNewestPageStays() {
        var sync = paged(rows: [msg("m10", at: 10, updated: 10)], olderAt: 10, olderID: "m10")
        _ = sync.beginFetch(now: t0.addingTimeInterval(3_601))
        sync.applyRealtime(msg("m60", at: 60))
        sync.applyResponse(ThreadPage(messages: [msg("m10", at: 10, updated: 10)], delta: false, cursor: stamp(10),
                                      older: OlderCursor(before: stamp(10), beforeID: "m10")), now: t0.addingTimeInterval(3_601))
        XCTAssertEqual(sync.messages.map(\.id), ["m10", "m60"])
    }

    /// Hard case 5: a realtime copy past a gap does not make the run look
    /// as if it touched the page.
    func testARealtimeRowPastAGapDoesNotHideIt() {
        var sync = paged(rows: [msg("m10", at: 10, updated: 10), msg("m11", at: 11, updated: 11)], olderAt: 10, olderID: "m10")
        sync.applyRealtime(msg("m60", at: 60))
        _ = sync.beginFetch(now: t0.addingTimeInterval(3_601))
        sync.applyResponse(ThreadPage(messages: [msg("m40", at: 40, updated: 40), msg("m60", at: 60, updated: 60)], delta: false,
                                      cursor: stamp(60), older: OlderCursor(before: stamp(40), beforeID: "m40")),
                           now: t0.addingTimeInterval(3_601))
        XCTAssertEqual(sync.messages.map(\.id), ["m40", "m60"], "restarted from the page, no hole between m11 and m40")
    }

    /// Hard case 8: a copy saved before paging (where it starts unknown) is
    /// shown at once, and its first read is the newest page, which is the run.
    func testACopySavedBeforePagingIsShownThenReadFromItsNewestPage() {
        var sync = ThreadSync()
        XCTAssertTrue(sync.applyCached(CachedThread(messages: [msg("m1", at: 1, updated: 1), msg("m2", at: 2, updated: 2)],
                                                    cursor: stamp(2), fullAt: t0, complete: true)))
        XCTAssertFalse(sync.canLoadEarlier)
        let request = sync.beginFetch(now: t0.addingTimeInterval(60))
        XCTAssertNil(request.since, "where the saved run starts is unknown: no delta")
        XCTAssertEqual(request.limit, 100)
        sync.applyResponse(ThreadPage(messages: [msg("m2", at: 2, updated: 2), msg("m3", at: 3, updated: 3)], delta: false,
                                      cursor: stamp(3), older: OlderCursor(before: stamp(2), beforeID: "m2")), now: t0.addingTimeInterval(60))
        XCTAssertEqual(sync.messages.map(\.id), ["m2", "m3"])
        XCTAssertTrue(sync.canLoadEarlier)
        XCTAssertEqual(sync.beginFetch(now: t0.addingTimeInterval(120)).since, stamp(3))
    }

    /// A saved run that knows where it starts reads a delta and can load earlier.
    func testASavedRunThatKnowsItsStartReadsADelta() {
        var sync = ThreadSync()
        sync.applyCached(CachedThread(messages: [msg("m10", at: 10, updated: 10)], cursor: stamp(10), fullAt: t0, complete: true,
                                      older: OlderCursor(before: stamp(10), beforeID: "m10"), olderKnown: true))
        XCTAssertTrue(sync.canLoadEarlier)
        XCTAssertEqual(sync.beginFetch(now: t0.addingTimeInterval(60)).since, stamp(10))
    }

    /// A thread whose newest page was read, ending at `olderAt`/`olderID`.
    private func paged(rows: [Message], olderAt: Double, olderID: String) -> ThreadSync {
        var sync = ThreadSync()
        _ = sync.beginFetch(now: t0)
        let newest = rows.compactMap(\.updatedAt).max() ?? t0
        sync.applyResponse(ThreadPage(messages: rows, delta: false, cursor: Self.iso.string(from: newest),
                                      older: OlderCursor(before: stamp(olderAt), beforeID: olderID)), now: t0)
        return sync
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// `t0 + seconds` as the server writes it (microseconds, `+00:00`).
    private func stamp(_ seconds: Double) -> String {
        let base = Self.iso.string(from: t0.addingTimeInterval(seconds)) // …:40.000Z
        return base.replacingOccurrences(of: "Z", with: "123+00:00")
    }
}

/// The query a thread page is asked with (APIClient.percentEncodedQuery).
final class ThreadQueryTests: XCTestCase {
    func testAPlusInBeforeIsSentEncoded() {
        let query = APIClient.percentEncodedQuery([
            URLQueryItem(name: "limit", value: "100"),
            URLQueryItem(name: "before", value: "2026-11-08T10:00:00.123456+00:00"),
            URLQueryItem(name: "before_id", value: "m1"),
        ])
        XCTAssertEqual(query, "limit=100&before=2026-11-08T10:00:00.123456%2B00:00&before_id=m1")
    }
}
