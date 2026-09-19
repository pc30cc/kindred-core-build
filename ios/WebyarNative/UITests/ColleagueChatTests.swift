import XCTest

/// The internal inbox is a chat, not a message box.
///
/// It used to be a plain field and a send button: no paperclip, no voice note,
/// no emoji, no saved replies, no faces beside the bubbles, no day headers. A
/// colleague is somebody you send a screenshot to more often than a visitor is,
/// and there was never a reason for the two screens to differ — the difference
/// only meant one of them got every improvement and the other got none.
final class ColleagueChatTests: UITestCase {

    func testTheColleagueThreadHasTheSameComposerAsTheVisitorChat() {
        app.launchArguments += ["-WebyarScreen", "colleagueThread"]
        app.launch()

        let composer = app.textFields[A11yID.composerField].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "the colleague thread never opened")

        XCTAssertTrue(
            app.buttons[A11yID.attachButton].exists,
            "no way to send a colleague a file"
        )
    }

    /// The one thing it deliberately does not share.
    ///
    /// Saved replies are written to answer a visitor — "thanks for getting in
    /// touch", "let me look into that" — and the reader here is a colleague.
    /// A drawer of the wrong register is worse than no drawer, and the reply
    /// anyone would reach for first is the greeting, which is the one with
    /// `{{contact.name}}` in it and nothing to resolve it against.
    func testTheColleagueThreadHasNoSavedReplies() {
        app.launchArguments += ["-WebyarScreen", "colleagueThread"]
        app.launch()

        XCTAssertTrue(
            app.textFields[A11yID.composerField].firstMatch.waitForExistence(timeout: 25)
        )
        XCTAssertFalse(
            app.buttons[A11yID.shortcutsButton].exists,
            "the internal thread is offering visitor replies"
        )
    }

    /// And the keyboard behaves the same way here.
    ///
    /// This screen has its own composer wiring, so "the visitor chat is fine"
    /// says nothing about it — which is how it ended up with none of the rest.
    func testTheTranscriptFollowsTheKeyboardHereToo() {
        app.launchArguments += ["-WebyarScreen", "colleagueThread"]
        app.launch()

        let composer = app.textFields[A11yID.composerField].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 25))

        XCTAssertTrue(app.scrollViews.firstMatch.waitForExistence(timeout: 10))

        guard let newest = newestMessageID() else {
            return XCTFail("no message in the internal thread to follow")
        }
        waitUntilStill { frameOfMessage(newest) }
        guard let atRest = frameOfMessage(newest) else {
            return XCTFail("the newest message went away before the test began")
        }

        let keyboard = focus(composer)
        guard let raised = frameOfMessage(newest) else {
            return XCTFail("the newest message vanished when the keyboard opened")
        }

        XCTAssertLessThan(raised.minY, atRest.minY, "the transcript did not move")
        XCTAssertLessThanOrEqual(
            raised.maxY, keyboard.frame.minY + 1,
            "the newest message was left behind the keyboard"
        )
    }
}
