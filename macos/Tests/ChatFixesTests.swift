import XCTest
@testable import Webyar

/// Sending in the visitor chat: the outbox that outlives a thread's model, empty files, and
/// the bytes of files that will not be sent after all.
@MainActor
final class ChatFixesTests: XCTestCase {
    private func row(_ cid: String, failed: Bool = false) -> ChatRow {
        var r = ChatRow(id: cid, side: .outgoing, body: "hello \(cid)")
        r.clientId = cid
        r.pending = !failed
        r.failed = failed
        return r
    }

    func testAnEmptyFileIsRefusedBeforeSending() {
        // The server's /init wants a size above zero: an empty file would fail on every retry.
        XCTAssertEqual(SendableFile.prepare(name: "empty.txt", type: nil, data: Data()), .notAllowed)
        XCTAssertEqual(SendableFile.prepare(name: "empty.png", type: nil, data: Data()), .notAllowed)
        XCTAssertEqual(SendableFile.check(name: "voice.m4a", mime: "audio/mp4", data: Data()), .notAllowed)
        XCTAssertNotEqual(SendableFile.check(name: "voice.m4a", mime: "audio/mp4", data: Data([1])), .notAllowed)
    }

    func testASentMessageStaysUntilAReadThatBeganAfterItWent() {
        let box = ChatOutbox()
        box.add(row("a"), then: .none, file: nil)
        let before = box.readMark
        box.sent("a")
        XCTAssertEqual(box.rows.count, 1)
        XCTAssertFalse(box.rows[0].pending)
        // A read that was already out when the send finished may not have it.
        XCTAssertFalse(box.settle(readBegan: before))
        XCTAssertEqual(box.rows.count, 1)
        // One that began afterwards does.
        XCTAssertTrue(box.settle(readBegan: box.readMark))
        XCTAssertTrue(box.isEmpty)
    }

    func testAPendingMessageStaysThroughReadsUntilItsClientIdComesBack() {
        let box = ChatOutbox()
        box.add(row("a"), then: .resolve, file: nil)
        XCTAssertFalse(box.settle(readBegan: box.readMark))
        XCTAssertEqual(box.then("a"), .resolve)
        XCTAssertTrue(box.settle(delivered: ["a"]))
        XCTAssertTrue(box.isEmpty)
        XCTAssertEqual(box.then("a"), .none)
    }

    func testFailedMessagesAreKeptForRetryAndCanBeDiscarded() {
        let box = ChatOutbox()
        box.add(row("a"), then: .none, file: ("a.txt", "text/plain", Data("x".utf8)))
        box.add(row("b"), then: .none, file: nil)
        box.add(row("c"), then: .none, file: nil)
        box.update("a") { $0.pending = false; $0.failed = true }
        box.update("c") { $0.pending = false; $0.failed = true }
        XCTAssertEqual(box.failedIds, ["a", "c"])
        XCTAssertNotNil(box.file("a"))

        box.discardFailed("a")
        XCTAssertEqual(box.rows.compactMap(\.clientId), ["b", "c"])
        XCTAssertNil(box.file("a"))

        box.discardFailed()
        XCTAssertEqual(box.rows.compactMap(\.clientId), ["b"])
    }

    func testAForgottenLocalFileIsLetGo() async {
        let store = AttachmentStore(fetch: { _ in throw ApiError(failure: .transport) })
        let bytes = Data("voice".utf8)
        store.remember("local:note", bytes)
        let held = try? await store.data("local:note")
        XCTAssertEqual(held, bytes)
        store.forget("local:note")
        let after = try? await store.data("local:note")
        XCTAssertNil(after)
    }
}
