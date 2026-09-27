import XCTest
@testable import Webyar

/// The mailbox list's refresh merge and the reader's attachment chips.
@MainActor
final class EmailTests: XCTestCase {
    private func thread(_ id: String, _ at: Double) throws -> EmailThreadSummary {
        try JSON.decoder().decode(EmailThreadSummary.self, from: Data(#"{"id":"\#(id)","last_message_at":\#(at)}"#.utf8))
    }

    // MARK: Refresh merge

    func testKeepsOlderPagesBelowAFreshFirstPage() throws {
        let loaded = [try thread("t5", 500), try thread("t4", 400), try thread("t3", 300), try thread("t2", 200)]
        let fresh = [try thread("t6", 600), try thread("t5", 500)]
        let merged = EmailModel.merge(loaded, fresh: fresh, hasMore: true)
        XCTAssertEqual(merged.threads.map(\.id), ["t6", "t5", "t4", "t3", "t2"])
        XCTAssertTrue(merged.keptOlder)
    }

    func testDropsWhatTheFreshPageNoLongerCarriesWithinItsSpan() throws {
        let loaded = [try thread("t5", 500), try thread("t4", 400), try thread("t3", 300)]
        let fresh = [try thread("t5", 500), try thread("t3", 300)]
        let merged = EmailModel.merge(loaded, fresh: fresh, hasMore: true)
        XCTAssertEqual(merged.threads.map(\.id), ["t5", "t3"])
        XCTAssertFalse(merged.keptOlder)
    }

    func testAFreshPageWithNoNextPageIsTheWholeList() throws {
        let loaded = [try thread("a", 200), try thread("b", 100)]
        let merged = EmailModel.merge(loaded, fresh: [try thread("a", 200)], hasMore: false)
        XCTAssertEqual(merged.threads.map(\.id), ["a"])
        XCTAssertFalse(merged.keptOlder)
    }

    // MARK: Reader

    func testOnlyAttachmentsShownInPlaceLoseTheirChip() throws {
        let json = #"""
        {"thread":{"id":"t"},"messages":[{"id":"m","html_body":"<p><img src=\"cid:img1\"><img src=\"cid:img2\"></p>","attachments":[
          {"id":"a1","filename":"one.png","size_bytes":10,"content_id":"<img1>","url":"https://files.example/a1"},
          {"id":"a2","filename":"two.png","size_bytes":10,"content_id":"img2","url":null},
          {"id":"a3","filename":"doc.pdf","size_bytes":10}
        ]}]}
        """#
        let detail = try JSON.decoder().decode(EmailThreadDetail.self, from: Data(json.utf8))
        let html = EmailHTML.page(detail, dark: false, s: Strings(.en))
        XCTAssertTrue(html.contains("https://files.example/a1"))
        XCTAssertFalse(html.contains("\(EmailHTML.attachmentScheme)://a1"))
        XCTAssertTrue(html.contains("\(EmailHTML.attachmentScheme)://a2"))
        XCTAssertTrue(html.contains("\(EmailHTML.attachmentScheme)://a3"))
    }
}
