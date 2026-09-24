import XCTest

/// The dot on the inbox tab.
///
/// It exists for the minutes an operator is not looking at the inbox: the
/// notification banner that already appears is three seconds long, and an
/// operator who declined the notification prompt never sees one at all. So
/// the two things worth pinning are that it survives leaving the tab, and
/// that opening the inbox is what puts it out.
///
/// Launched with `-WebyarInboxDot`, because nothing in a sample run can make
/// a visitor write — see `InboxAlert.init`.
final class InboxDotTests: UITestCase {

    /// Persian, like the rest of this suite, so these are the labels.
    private let inboxTab = "صندوق"
    private let settingsTab = "تنظیمات"
    private let marked = "پیام‌های جدید"

    func testTheDotIsStillThereOnceTheOperatorHasLookedElsewhere() {
        app.launchArguments += ["-WebyarInboxDot"]
        launchToInbox()

        let settings = app.buttons[settingsTab]
        XCTAssertTrue(settings.waitForExistence(timeout: 20), "the tab bar never appeared")
        settings.tap()

        let inbox = app.buttons[inboxTab]
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))
        // Read as a value rather than looked for as a glyph: a red circle
        // seven points across is not something a test — or a screen reader —
        // can describe on its own.
        XCTAssertEqual(
            inbox.value as? String, marked,
            "the inbox tab stopped saying anything was waiting as soon as the operator left it"
        )
    }

    func testOpeningTheInboxPutsItOut() {
        app.launchArguments += ["-WebyarInboxDot"]
        launchToInbox()

        let settings = app.buttons[settingsTab]
        XCTAssertTrue(settings.waitForExistence(timeout: 20))
        settings.tap()

        let inbox = app.buttons[inboxTab]
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))
        inbox.tap()

        // Not instantly: the bar animates, and the assertion has to outlast it.
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, (inbox.value as? String) == marked {
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTAssertNotEqual(
            inbox.value as? String, marked,
            "the dot stayed lit after the operator opened the inbox"
        )
    }
}
