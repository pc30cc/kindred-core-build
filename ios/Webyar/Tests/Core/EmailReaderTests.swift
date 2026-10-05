import Foundation
import XCTest
@testable import Webyar

/// The mail's pure parts: addresses as people type them, a mail as text, and
/// the page a thread is read on — what it keeps of a mail's HTML and what it
/// takes out.
final class EmailReaderTests: XCTestCase {
    // MARK: Addresses

    func testAddressesSplitOnCommasSemicolonsAndLinesButNotInsideAName() {
        XCTAssertEqual(
            EmailAddressing.list(#"a@x.com, b@y.org; "Ahmadi, Sara" <sara@z.io>"# + "\nc@w.net"),
            ["a@x.com", "b@y.org", "sara@z.io", "c@w.net"]
        )
        // Bare addresses separated by spaces, and the same one twice in another case.
        XCTAssertEqual(EmailAddressing.list("a@x.com b@y.org A@X.com"), ["a@x.com", "b@y.org"])
        XCTAssertEqual(EmailAddressing.list("  ,; "), [])
    }

    func testAnAddressAndWhetherItIsOne() {
        XCTAssertEqual(EmailAddressing.address("Sara <sara@x.com>"), "sara@x.com")
        XCTAssertEqual(EmailAddressing.address(" sara@x.com "), "sara@x.com")
        XCTAssertTrue(EmailAddressing.same("Sara <SARA@x.com>", "sara@X.com"))
        XCTAssertFalse(EmailAddressing.same("sara@x.com", "sam@x.com"))
        XCTAssertTrue(EmailAddressing.isValid("sara@example.co.uk"))
        for bad in ["sara", "sara@", "@x.com", "sara@x", "sa ra@x.com", "a@b@c.com"] {
            XCTAssertFalse(EmailAddressing.isValid(bad), bad)
        }
    }

    func testANameAndItsAddress() {
        XCTAssertEqual(MailName.parse(#""Sara Karimi" <sara@x.com>"#), MailName(name: "Sara Karimi", email: "sara@x.com"))
        XCTAssertEqual(MailName.parse("Google <no-reply@accounts.google.com>").display, "Google")
        XCTAssertEqual(MailName.parse("sara@x.com"), MailName(name: nil, email: "sara@x.com"))
        XCTAssertEqual(MailName.parse(#""" <a@b.co>"#).display, "a@b.co")
    }

    // MARK: A mail as text

    func testHTMLAsText() {
        let html = "<html><head><style>p{color:red}</style></head><body><p>Hello&nbsp;there</p>"
            + "<div>Line&#8212;two &amp;mdash; &#x2014;</div><script>alert(1)</script></body></html>"
        XCTAssertEqual(EmailBody.plainText(from: html), "Hello there\nLine—two &mdash; —")
    }

    func testTheQuotedTrailIsSplitOff() {
        let mail = "Thanks, that works.\n\nOn Tue, 3 Sep 2026 at 10:04, Sara <sara@x.com> wrote:\n> Try again?"
        let split = EmailBody.splitQuoted(mail)
        XCTAssertEqual(split.fresh, "Thanks, that works.")
        XCTAssertEqual(split.quoted, "On Tue, 3 Sep 2026 at 10:04, Sara <sara@x.com> wrote:\n> Try again?")
        // Nothing quoted, or a "quote" that would be the whole mail: no trail.
        XCTAssertNil(EmailBody.splitQuoted("Just a note.").quoted)
        XCTAssertNil(EmailBody.splitQuoted("> all of it\n> quoted").quoted)
    }

    // MARK: The page

    func testScriptsFramesFormsAndHandlersAreTakenOut() {
        let html = #"<div onclick="steal()">Hi<script>alert(1)</script><iframe src="https://x"></iframe>"#
            + #"<form action="https://x"><input name="p"></form><meta http-equiv="refresh" content="0;url=https://x">"#
            + #"<a href="javascript:alert(1)">link</a><img src="https://x/p.png" onerror="boom()"></div>"#
        let clean = EmailReader.sanitize(html, attachments: [])
        for gone in ["<script", "alert(1)<", "<iframe", "<form", "<input", "<meta", "onclick", "onerror", "javascript:"] {
            XCTAssertFalse(clean.lowercased().contains(gone), "\(gone) survived: \(clean)")
        }
        XCTAssertTrue(clean.contains(#"<img src="https://x/p.png">"#), clean)
        XCTAssertTrue(clean.contains("Hi"))
    }

    func testAnInlinePictureComesFromTheAppsOwnScheme() {
        let attachment = EmailAttachmentView(
            id: "att 1", filename: "logo.png", contentType: "image/png", sizeBytes: 10, contentId: "<logo@mail>", url: nil
        )
        let clean = EmailReader.sanitize(#"<img src="cid:logo@mail"><img src='cid:other'>"#, attachments: [attachment])
        XCTAssertTrue(clean.contains(#"src="webyar-inline://part/att%201""#), clean)
        XCTAssertTrue(clean.contains("cid:other"), "a picture with no part stays as it was")
        XCTAssertEqual(EmailReader.attachmentID(of: "webyar-inline://part/att%201"), "att 1")
        XCTAssertEqual(EmailReader.attachmentID(of: EmailReader.attachmentLink("a/b")), "a/b")
        XCTAssertNil(EmailReader.attachmentID(of: "https://example.com/a"))
    }

    func testADesktopMailLetsGoOfItsWidths() {
        let html = #"<table width="600" style="width:600px;min-width:600px"><tr><td width="300">x</td></tr></table>"#
            + #"<div style="width: 640px">wide</div><img width="600" src="a.png"><span style="width:20px">icon</span>"#
        let clean = EmailReader.sanitize(html, attachments: [])
        XCTAssertTrue(clean.contains(#"<table width="100%" style="width:100%;">"#), clean)
        XCTAssertTrue(clean.contains("<td >x</td>"), "a cell's width is left to the table: \(clean)")
        XCTAssertTrue(clean.contains(#"<div style="width:auto">"#), clean)
        // Pictures and the small fixed things keep their sizes.
        XCTAssertTrue(clean.contains(#"<img width="600" src="a.png">"#), clean)
        XCTAssertTrue(clean.contains(#"style="width:20px""#), clean)
    }

    func testAMailCutOffMidwayDoesNotTakeThePageWithIt() {
        XCTAssertEqual(EmailReader.sanitize("<p>Hi</p><style>p{color:red}", attachments: []), "<p>Hi</p>")
        XCTAssertEqual(EmailReader.sanitize("<p>Hi</p><!-- unclosed", attachments: []), "<p>Hi</p><!-- unclosed-->")
    }

    func testAMailsStylesheetStaysInsideTheMail() {
        let css = "body{min-width:600px;color:#333} html > body p, .x{margin:0} table{width:640px}"
            + " @media (max-width:600px){h1{font-size:20px}} @import url(x.css); @font-face{font-family:F}"
        XCTAssertEqual(
            MailCss.scope(css, scope: "m0"),
            ".m0{;color:#333}.m0 p,.m0 .x{margin:0}.m0 table{width:100%}"
                + "@media (max-width:600px){.m0 h1{font-size:20px}}@font-face{font-family:F}"
        )
        XCTAssertEqual(
            EmailReader.sanitize("<style>td{padding:4px}</style><p>x</p>", attachments: [], scope: "m3"),
            "<style>.m3 td{padding:4px}</style><p>x</p>"
        )
    }

    func testThePageNewestFirstWithTheEarlierOnesFolded() {
        let older = message("1", from: #""Sara" <sara@x.com>"#, text: "First <b>question</b>", read: true)
        let newer = message("2", from: "shop@acme.com", text: "Answer", read: true, outbound: true)
        let page = EmailReader.document(subject: "Order <42>", messages: [older, newer], mailbox: "shop@acme.com", language: .en)
        XCTAssertTrue(page.contains("<h1 class=\"w-s\">Order &lt;42&gt;</h1>"))
        XCTAssertTrue(page.contains("2 messages"), page)
        // The newest is open at the top, by the mailbox itself: «me».
        XCTAssertTrue(page.contains("<span class=\"w-hn\">\(EmailStr.me(.en))</span>"), page)
        // The earlier one is folded, its words escaped.
        XCTAssertTrue(page.contains("<details class=\"w-card\"><summary>"))
        XCTAssertTrue(page.contains("First &lt;b&gt;question&lt;/b&gt;"))
        XCTAssertFalse(page.contains("<b>question</b>"))
        XCTAssertLessThan(page.range(of: "Answer")!.lowerBound, page.range(of: "First &lt;b&gt;")!.lowerBound)
    }

    func testAnUnreadEarlierMailIsOpenedAndAFileIsAChip() {
        let unread = message("1", from: "a@b.co", text: "Unread one", read: false, files: [
            EmailAttachmentView(id: "f1", filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 2048, contentId: nil, url: nil),
        ])
        let latest = message("2", from: "a@b.co", text: "Latest", read: true)
        let page = EmailReader.document(subject: nil, messages: [unread, latest], mailbox: nil, language: .fa)
        XCTAssertTrue(page.contains("<details class=\"w-card\" open>"), page)
        XCTAssertTrue(page.contains("href=\"webyar-attachment:f1\""), page)
        XCTAssertTrue(page.contains("invoice.pdf"))
    }

    func testAFilesNameOnDisk() {
        func file(_ name: String?, _ type: String?) -> EmailAttachmentView {
            EmailAttachmentView(id: "f", filename: name, contentType: type, sizeBytes: nil, contentId: nil, url: nil)
        }
        XCTAssertEqual(EmailReader.fileExtension(file("Invoice.PDF", "application/octet-stream")), "PDF")
        XCTAssertEqual(EmailReader.fileExtension(file("scan", "image/jpeg; name=scan")), "jpg")
        XCTAssertEqual(EmailReader.fileExtension(file("report.", "application/pdf")), "pdf")
        XCTAssertNil(EmailReader.fileExtension(file(nil, "application/x-unknown")))
    }

    func testOneSenderHasOneColourOnEveryPhone() {
        // Java's `String.hashCode`, as the Android app computes it.
        XCTAssertEqual(MailHue.of("sara@example.com"), MailHue.of("SARA@example.com"))
        XCTAssertEqual(MailHue.of(""), 0)
        XCTAssertEqual(MailHue.of("a"), 97)
        // "hello".hashCode() == 99162322, and 99162322 % 360 == 322.
        XCTAssertEqual(MailHue.of("hello"), 322)
        // A negative hash is read unsigned, as the Android app reads it.
        XCTAssertTrue((0..<360).contains(MailHue.of("no-reply@accounts.google.com")))
    }

    // MARK: The inbox's way in

    func testOneMailboxIsTheMailboxAndSeveralAreNamed() {
        let one = EmailEntry.entries(.en, mailboxes: [EmailMailbox(provider: "gmail", address: "a@x.com", unread: 3)], unread: 3)
        XCTAssertEqual(one, [EmailEntry(provider: "gmail", label: "Email", unread: 3)])
        XCTAssertEqual(EmailEntry.entries(.en, mailboxes: [], unread: 0), [EmailEntry(provider: nil, label: "Email", unread: 0)])

        let two = EmailEntry.entries(.en, mailboxes: [
            EmailMailbox(provider: "gmail", address: "a@x.com", unread: 2),
            EmailMailbox(provider: "yahoo", address: nil, unread: nil),
        ], unread: 2)
        XCTAssertEqual(two.map(\.provider), ["gmail", "yahoo"])
        XCTAssertEqual(two[0].label, "Email · \u{2066}a@x.com\u{2069}")
        XCTAssertEqual(two[1].label, "Email · yahoo")
        XCTAssertEqual(two.map(\.unread), [2, 0])
    }

    func testListsAreReadLeniently() throws {
        let decoder = JSONDecoder()
        let page = try decoder.decode(EmailThreadsResponse.self, from: Data(#"{"threads":"oops","historyId":"77"}"#.utf8))
        XCTAssertEqual(page.threads, [])
        XCTAssertEqual(page.historyId, "77")
        let folder = try decoder.decode(EmailMailFolder.self, from: Data(#"{"id":"label:L1","name":"Clients","unread":"x"}"#.utf8))
        XCTAssertTrue(folder.isLabel)
        XCTAssertNil(folder.unread)
        XCTAssertEqual(EmailMailFolder(id: "drafts", total: 4).count, 4)
        XCTAssertNil(EmailMailFolder(id: "inbox", unread: 0).count)
    }

    // MARK: Helpers

    private func message(
        _ id: String, from: String, text: String, read: Bool, outbound: Bool = false, files: [EmailAttachmentView]? = nil
    ) -> EmailMessageView {
        EmailMessageView(
            id: id, externalMessageId: nil, direction: outbound ? "outbound" : "inbound", fromAddress: from,
            toAddresses: [EmailAddress(email: "shop@acme.com")], ccAddresses: nil, textBody: text, htmlBody: nil,
            snippet: nil, isRead: read, deliveryStatus: nil, deliveryError: nil,
            sentAt: Date(timeIntervalSince1970: 1_790_000_000 + (Double(id) ?? 0) * 60), attachments: files
        )
    }
}
