import XCTest

/// The inbox's channel labels, its strip's envelope and three lines, and the
/// mailbox — list, folders, reader and composer — against the sample
/// backend: a Gmail with three threads (an HTML invoice with a file, a
/// three-mail trail, one in Persian) and a Yahoo beside it.
final class EmailTests: UITestCase {

    /// Anything carrying `identifier`, whatever kind of element SwiftUI made it.
    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Until `element` is enabled — a button that waits for its screen to be ready.
    private func waitUntilEnabled(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists && element.isEnabled { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return element.exists && element.isEnabled
    }

    /// A row of a sheet, scrolled to when it is below the fold.
    private func sheetRow(_ identifier: String) -> XCUIElement {
        let row = app.buttons[identifier]
        for _ in 0..<3 where !(row.exists && row.isHittable) {
            app.swipeUp()
        }
        return row
    }

    // MARK: The inbox

    func testASupportConversationSaysWhichAppItCameFrom() {
        launchToInbox()
        // «کاربر سایت · Android» beside the name, on the row.
        let label = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "· Android")).firstMatch
        XCTAssertTrue(label.waitForExistence(timeout: 15), "the support conversation does not say which app it came from")

        let row = element(A11yID.conversationRow("c-2"))
        XCTAssertTrue(row.exists, "the support conversation is not listed")
        row.tap()
        // And in the chat's bar.
        XCTAssertTrue(
            app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "· Android")).firstMatch
                .waitForExistence(timeout: 15),
            "the chat's bar does not say which app the conversation came from"
        )
    }

    func testTheStripsEnvelopeOpensTheMailbox() {
        launchToInbox()
        let envelope = app.buttons[A11yID.inboxEmail]
        XCTAssertTrue(envelope.waitForExistence(timeout: 15), "no envelope on the strip")
        envelope.tap()
        XCTAssertTrue(element(A11yID.emailRow("e-1")).waitForExistence(timeout: 20), "the mailbox did not open")
        XCTAssertTrue(app.buttons[A11yID.emailCompose].exists, "no Compose in the mailbox")
    }

    func testTheThreeLinesListEveryInbox() {
        launchToInbox()
        let lines = app.buttons[A11yID.inboxEveryInbox]
        XCTAssertTrue(lines.waitForExistence(timeout: 15), "no three lines on the strip")
        XCTAssertFalse(lines.isSelected, "lit before anything off the strip was chosen")
        lines.tap()

        XCTAssertTrue(app.buttons[A11yID.everyInboxRow("open")].waitForExistence(timeout: 10), "the queues are not listed")
        XCTAssertTrue(sheetRow(A11yID.everyInboxRow("email.gmail")).exists, "the Gmail mailbox is not listed")
        XCTAssertTrue(sheetRow(A11yID.everyInboxRow("email.yahoo")).exists, "the Yahoo mailbox is not listed")

        // A queue that is not on the strip: chosen here, the list is its, and
        // the three lines are lit.
        let resolved = sheetRow(A11yID.everyInboxRow("resolved"))
        XCTAssertTrue(resolved.exists, "Resolved is not listed")
        resolved.tap()
        XCTAssertTrue(element(A11yID.conversationRow("c-5")).waitForExistence(timeout: 15), "the resolved queue did not open")
        XCTAssertTrue(app.buttons[A11yID.inboxEveryInbox].isSelected, "the three lines are not lit")
    }

    func testEveryInboxOpensASecondMailbox() {
        launchToInbox()
        app.buttons[A11yID.inboxEveryInbox].tap()
        let yahoo = sheetRow(A11yID.everyInboxRow("email.yahoo"))
        XCTAssertTrue(yahoo.waitForExistence(timeout: 10), "the Yahoo mailbox is not listed")
        yahoo.tap()
        // The sample Yahoo is empty; its own switcher chip is the one chosen.
        XCTAssertTrue(element(A11yID.emailEmpty).waitForExistence(timeout: 20), "the Yahoo mailbox did not open")
        XCTAssertTrue(element(A11yID.emailMailbox("yahoo")).isSelected, "the mailbox on screen is not Yahoo")
    }

    // MARK: The mailbox

    func testTheFoldersBehindTheMailboxsThreeLines() {
        app.launchArguments += ["-WebyarScreen", "email"]
        app.launch()
        XCTAssertTrue(element(A11yID.emailRow("e-2")).waitForExistence(timeout: 20), "the mailbox did not open")

        let folders = app.buttons[A11yID.emailFolders]
        XCTAssertTrue(folders.exists, "no folders button")
        folders.tap()
        let clients = element(A11yID.emailMailFolder("label:Label_1"))
        XCTAssertTrue(clients.waitForExistence(timeout: 10), "the mailbox's label is not in its folders")
        clients.tap()

        XCTAssertTrue(waitForDisappearance(element(A11yID.emailRow("e-2")), timeout: 10), "the label shows a thread it does not hold")
        XCTAssertTrue(element(A11yID.emailRow("e-1")).exists, "the label lost its own thread")
    }

    func testAMailIsReadAndAnswered() {
        app.launchArguments += ["-WebyarScreen", "email"]
        app.launch()
        let row = element(A11yID.emailRow("e-2"))
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the mailbox did not open")
        row.tap()

        XCTAssertTrue(element(A11yID.emailThread).waitForExistence(timeout: 15), "the thread's page never showed")
        let reply = app.buttons[A11yID.emailReply]
        XCTAssertTrue(reply.waitForExistence(timeout: 10), "no Reply under the thread")
        XCTAssertTrue(app.buttons[A11yID.emailReplyAll].exists)
        XCTAssertTrue(app.buttons[A11yID.emailForward].exists)
        reply.tap()

        // Addressed to the last person who wrote in, already.
        let to = element(A11yID.emailComposeTo)
        XCTAssertTrue(to.waitForExistence(timeout: 10), "the composer did not open")
        let send = app.buttons[A11yID.emailComposeSend]
        XCTAssertTrue(waitUntilEnabled(send), "the reply was never ready")
        XCTAssertEqual(to.value as? String, "lena@acme.example")

        let body = element(A11yID.emailComposeBody)
        focus(body)
        body.typeText("Glad it works")
        send.tap()

        XCTAssertTrue(waitForDisappearance(to, timeout: 10), "the composer did not close after sending")
        XCTAssertTrue(app.buttons[A11yID.emailReply].waitForExistence(timeout: 10), "not back on the thread")
    }

    func testAForwardSaysWhoItNeedsToGoTo() {
        app.launchArguments += ["-WebyarScreen", "emailThread"]
        app.launch()
        let forward = app.buttons[A11yID.emailForward]
        XCTAssertTrue(forward.waitForExistence(timeout: 20), "the thread did not open")
        forward.tap()

        let send = app.buttons[A11yID.emailComposeSend]
        XCTAssertTrue(waitUntilEnabled(send), "the forward was never ready")
        send.tap()
        XCTAssertTrue(element(A11yID.emailComposeError).waitForExistence(timeout: 5), "sent to nobody without a word")

        // Nothing written: it closes without asking.
        app.buttons[A11yID.emailComposeClose].tap()
        XCTAssertTrue(app.buttons[A11yID.emailForward].waitForExistence(timeout: 10), "not back on the thread")
    }

    func testTheStarIsInTheThreadsBar() {
        app.launchArguments += ["-WebyarScreen", "emailThread"]
        app.launch()
        let star = app.buttons[A11yID.emailThreadStar]
        XCTAssertTrue(star.waitForExistence(timeout: 20), "no star in the thread's bar")
        XCTAssertTrue(waitUntilEnabled(star))
        let before = star.label
        star.tap()
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, star.label == before {
            Thread.sleep(forTimeInterval: 0.2)
        }
        XCTAssertNotEqual(star.label, before, "the star did not change")
        XCTAssertTrue(app.buttons[A11yID.emailMenu].exists, "no menu in the thread's bar")
    }
}
