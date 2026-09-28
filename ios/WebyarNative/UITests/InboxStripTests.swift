import XCTest

/// The strip above the inbox list: its unread dots, and that it still
/// switches.
///
/// The dot is a red circle a screenshot shows and a test cannot see, so this
/// reads what VoiceOver is told instead: a segment with a dot says how many
/// are unread in its value, and one without says nothing.
final class InboxStripTests: UITestCase {

    private let unread = "خوانده‌نشده"

    /// A segment by the start of its label — the count after the title
    /// changes with the sample data, the title does not. "باز (" rather than
    /// "باز", which is also the start of the Visitors tab.
    private func segment(_ prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    /// The unread counts arrive a moment after the strip does.
    private func waitForValue(_ element: XCUIElement, containing text: String, timeout: TimeInterval = 10) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (element.value as? String ?? "").contains(text) { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    func testOpenAndColleaguesCarryTheDotAndTheAIQueueDoesNot() {
        launchToInbox()

        let open = segment("باز (")
        XCTAssertTrue(open.waitForExistence(timeout: 10), "no Open segment")
        XCTAssertTrue(
            waitForValue(open, containing: unread),
            "Open holds conversations with unread messages and has no dot"
        )

        let colleagues = segment("همکاران")
        XCTAssertTrue(colleagues.exists, "no Colleagues segment")
        XCTAssertTrue(
            waitForValue(colleagues, containing: unread),
            "a colleague's thread is unread and Colleagues has no dot"
        )

        // The AI is answering those: its queue never asks for attention.
        let ai = segment("هوش مصنوعی")
        XCTAssertTrue(ai.exists, "no AI segment")
        XCTAssertFalse((ai.value as? String ?? "").contains(unread), "the AI queue carries a dot")
    }

    func testTappingASegmentSelectsIt() {
        launchToInbox()

        let open = segment("باز (")
        XCTAssertTrue(open.waitForExistence(timeout: 10), "no Open segment")
        XCTAssertTrue(open.isSelected, "the inbox did not open on Open")

        let colleagues = segment("همکاران")
        colleagues.tap()
        XCTAssertTrue(colleagues.isSelected, "tapping Colleagues did not select it")
        XCTAssertFalse(open.isSelected, "Open stayed selected beside Colleagues")
    }
}
