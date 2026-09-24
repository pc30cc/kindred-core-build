import XCTest

/// Not a test of behaviour — a way to get a picture of the open menu.
///
/// A SwiftUI `Menu` is drawn by UIKit, outside the app's own view hierarchy,
/// so whether it honours the app's typeface cannot be reasoned about from the
/// SwiftUI side and cannot be screenshotted without something holding it
/// open. This opens it and waits, so `simctl io screenshot` can take the
/// picture from outside.
final class MenuFontProbe: UITestCase {

    func testHoldTheInboxTitleMenuOpen() {
        launchToInbox()
        let menu = app.buttons[A11yID.inboxTitleMenu]
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "the title menu never appeared")
        menu.tap()
        // Long enough for a screenshot to be taken from outside the runner.
        Thread.sleep(forTimeInterval: 18)
    }
}
