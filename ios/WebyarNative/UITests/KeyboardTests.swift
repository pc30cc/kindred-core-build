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
    func testChatTranscriptFollowsTheKeyboardBothWays() {
        app.launchArguments += ["-WebyarScreen", "chat"]
        app.launch()

        let field = composerField()
        XCTAssertTrue(field.waitForExistence(timeout: 25), "the chat screen never opened")

        let transcript = app.scrollViews.firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 10), "no transcript on the chat screen")

        guard let newest = lastMessage(in: transcript) else {
            return XCTFail("no message in the transcript to follow")
        }
        let atRest = newest.frame

        // Up.
        field.tap()
        let keyboard = waitForKeyboard()
        let raised = newest.frame

        XCTAssertLessThan(
            raised.minY, atRest.minY,
            "the transcript did not move when the keyboard opened"
        )
        XCTAssertLessThanOrEqual(
            raised.maxY, keyboard.frame.minY + 1,
            "the newest message was left behind the keyboard"
        )

        // And down. Tapping the transcript dismisses the keyboard.
        transcript.tap()
        XCTAssertTrue(
            waitForDisappearance(app.keyboards.element, timeout: 6),
            "tapping the transcript did not dismiss the keyboard"
        )
        Thread.sleep(forTimeInterval: 0.8)

        XCTAssertEqual(
            newest.frame.minY, atRest.minY, accuracy: 4.0,
            "the transcript did not come back down: \(atRest.minY) -> \(newest.frame.minY)"
        )
    }

    // MARK: - Finding things

    /// The composer, whichever kind of element this iOS decided it is.
    ///
    /// A `TextField(axis: .vertical)` is a `textView` to XCUITest on some
    /// releases and a `textField` on others, and neither is worth pinning a
    /// test to.
    private func composerField() -> XCUIElement {
        let asView = app.textViews[A11yID.composerField].firstMatch
        if asView.waitForExistence(timeout: 8) { return asView }
        return app.textFields[A11yID.composerField].firstMatch
    }

    /// The bottom-most piece of text inside the transcript.
    private func lastMessage(in transcript: XCUIElement) -> XCUIElement? {
        transcript.staticTexts.allElementsBoundByIndex
            .filter { $0.exists && $0.frame.height > 0 }
            .max { $0.frame.maxY < $1.frame.maxY }
    }
}
