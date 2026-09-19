import XCTest

/// What the keyboard is allowed to move, and what it is not.
///
/// SwiftUI reports the keyboard as a bottom safe area. That one fact is behind
/// both bugs here and they pull in opposite directions: a safe area sits
/// *inside* the proposed size, so a bottom-aligned overlay rides up on top of
/// the keys — but a `GeometryReader` never shrinks, so code inferring the
/// keyboard from its own height never sees it at all.
final class KeyboardTests: UITestCase {

    /// The tab bar belongs to the device, not to the text being typed.
    ///
    /// It used to ride the keyboard into the middle of the screen the moment a
    /// search field opened. Mail and Messages let the keyboard cover the bar;
    /// so does this.
    func testKeyboardDoesNotLiftTheTabBar() {
        let magnifier = launchToInbox()

        let tabBar = app.otherElements[A11yID.tabBar]
        XCTAssertTrue(tabBar.waitForExistence(timeout: 10), "no tab bar to measure")
        let atRest = tabBar.frame

        magnifier.tap()
        _ = waitForKeyboard()

        let lifted = tabBar.frame
        XCTAssertEqual(
            lifted.minY, atRest.minY, accuracy: 1.0,
            "the keyboard took the tab bar with it: \(atRest.minY) -> \(lifted.minY)"
        )
    }

    /// And the transcript does follow it, both ways.
    ///
    /// Opening the keyboard puts the newest message behind the keys — which is
    /// the message the operator is about to reply to. Closing it gives the
    /// space back, and the transcript has to come down with it or it is left
    /// scrolled past its own end, with a gap where the keyboard was.
    ///
    /// This asserts the outcome, not the mechanism, and the difference matters
    /// here: on iOS 26.4 it passes with `PinnedScrollView`'s keyboard
    /// observers, without them, and with that file reverted to the version
    /// that provably could not work. So a green run says the operator sees the
    /// right thing on this release; it does not say which line of the app is
    /// responsible, and it would not catch this being broken by deleting one.
    func testChatTranscriptFollowsTheKeyboardBothWays() {
        app.launchArguments += ["-WebyarScreen", "chat"]
        app.launch()

        let field = composerField()
        XCTAssertTrue(field.waitForExistence(timeout: 25), "the chat screen never opened")

        let transcript = app.scrollViews.firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 10), "no transcript on the chat screen")

        guard let newest = newestMessageID() else {
            return XCTFail("no message in the transcript to follow")
        }
        // The transcript opens scrolled to its end and is still moving for a
        // moment after that. Measuring or tapping during it tests the scroll,
        // not the keyboard.
        waitUntilStill { frameOfMessage(newest) }
        guard let atRest = frameOfMessage(newest) else {
            return XCTFail("the newest message went away before the test began")
        }

        // Up.
        let keyboard = focus(field)
        guard let raised = frameOfMessage(newest) else {
            return XCTFail("the newest message vanished when the keyboard opened")
        }

        XCTAssertLessThan(
            raised.minY, atRest.minY,
            "the transcript did not move when the keyboard opened"
        )
        XCTAssertLessThanOrEqual(
            raised.maxY, keyboard.frame.minY + 1,
            "the newest message was left behind the keyboard"
        )

        // And down.
        XCTAssertTrue(
            dismissKeyboardByTapping(transcript, above: keyboard),
            "tapping beside the messages did not dismiss the keyboard"
        )
        Thread.sleep(forTimeInterval: 0.8)

        guard let settled = frameOfMessage(newest) else {
            return XCTFail("the newest message vanished when the keyboard closed")
        }
        XCTAssertEqual(
            settled.minY, atRest.minY, accuracy: 4.0,
            "the transcript did not come back down: \(atRest.minY) -> \(settled.minY)"
        )
    }

    // MARK: - Finding things

    /// The composer, whichever kind of element this iOS decided it is.
    ///
    /// A `TextField(axis: .vertical)` is a `textField` to XCUITest on iOS 26
    /// and a `textView` on some other releases, and neither is worth pinning a
    /// test to. The field is asked for first, since that is what it is here;
    /// the other is the fallback.
    private func composerField() -> XCUIElement {
        let asField = app.textFields[A11yID.composerField].firstMatch
        if asField.waitForExistence(timeout: 25) { return asField }
        return app.textViews[A11yID.composerField].firstMatch
    }

}
