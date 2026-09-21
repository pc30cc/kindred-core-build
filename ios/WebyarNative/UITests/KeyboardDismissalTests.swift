import XCTest

/// Tapping away puts the keyboard down — and takes nothing else with it.
///
/// The first half was the feature. The second half is the bug it shipped
/// with: written as a SwiftUI `simultaneousGesture(TapGesture())` on the
/// `List`, it competed with the list's own cell selection and beat it, so
/// every row whose content is a `NavigationLink` stopped pushing. That is the
/// inbox, contacts, colleagues, the email list and the way into account
/// deletion — all of them, silently, with no crash and no log.
///
/// `SearchFieldTests` already covers the dismissal. This covers the cost.
final class KeyboardDismissalTests: UITestCase {

    /// A conversation still opens, with the search keyboard up over it.
    func testAConversationOpensWhileTheSearchKeyboardIsUp() {
        let magnifier = launchToInbox()

        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'conversation.'"))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 25), "the inbox never listed anything")

        magnifier.tap()
        let field = app.textFields[A11yID.searchField]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "the search field never opened")
        focus(field)

        // By coordinate rather than `tap()`. The identifier lands on the
        // `NavigationLink` in the row, which surfaces as its chevron — seven
        // points wide, and never `isHittable`, because a hit test at its
        // centre resolves to the cell around it rather than to the chevron
        // itself. Tapping the point is the same tap a finger makes.
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        XCTAssertTrue(
            composerField(timeout: 20).exists,
            "tapping a conversation did not open it — the keyboard dismisser ate the tap"
        )
    }

    /// And so does a settings row, which is the other list shape: grouped,
    /// static, with the link as the row itself rather than behind it.
    func testASettingsRowStillPushes() {
        app.launchArguments += ["-WebyarScreen", "security"]
        app.launch()

        let row = app.descendants(matching: .any)
            .matching(identifier: A11yID.deleteAccountRow)
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "Security never appeared")

        var attempts = 0
        while !row.isHittable, attempts < 6 {
            app.swipeUp()
            attempts += 1
        }
        row.tap()

        XCTAssertTrue(
            app.secureTextFields[A11yID.deleteAccountPassword].waitForExistence(timeout: 10),
            "a grouped list row did not push"
        )
    }
}
