import XCTest

/// The inbox search field: when it exists, and when it does not.
///
/// All three of these were reported from a real device, and all three were
/// invisible to every other kind of test. The field used to be a permanent
/// first row of the list, parked above the fold — so it showed through the
/// translucent navigation bar at rest, and the magnifier could only ever open
/// it because scrolling to a row that is already on screen does nothing.
final class SearchFieldTests: UITestCase {

    /// Nothing under the toolbar at rest.
    ///
    /// The grey shape showing through the navigation bar was the field, parked
    /// just out of sight. If it is in the hierarchy at all, it is on screen.
    func testNoSearchFieldBeforeItIsAskedFor() {
        launchToInbox()
        XCTAssertFalse(
            app.textFields[A11yID.searchField].exists,
            "the search field is in the hierarchy before anyone asked for it"
        )
    }

    /// The magnifier opens it — and it stays open.
    ///
    /// This is the regression that only the device showed: the field appeared
    /// and vanished within a frame. `@FocusState` is false for the moment
    /// between the row being inserted and the system installing the responder,
    /// and the blur handler read that first false as "the operator is done
    /// looking" — so it closed the thing it had just opened.
    func testMagnifierOpensTheFieldAndItStaysOpen() {
        let magnifier = launchToInbox()
        magnifier.tap()

        let field = app.textFields[A11yID.searchField]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "the magnifier did not open the field")

        // A second and a half is far longer than the frame in which it used to
        // shut itself, and long enough for the keyboard to have finished.
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertTrue(field.exists, "the search field closed itself")
        XCTAssertTrue(app.keyboards.element.exists, "the caret never reached the field")
    }

    /// And a second tap closes it.
    ///
    /// The magnifier is the only way in and the only way out, so a toggle that
    /// only opens leaves the operator with no way to put the field away.
    func testSecondTapClosesTheField() {
        let magnifier = launchToInbox()
        magnifier.tap()

        let field = app.textFields[A11yID.searchField]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.0)

        magnifier.tap()
        XCTAssertTrue(waitForDisappearance(field), "a second tap on the magnifier left the field open")
    }

    /// Text outlives the toggle.
    ///
    /// A field with something in it is still filtering the list below, so
    /// hiding it would be a lie about why the list is short. Dismissing the
    /// keyboard leaves it on screen; only an empty field goes away.
    func testAFieldWithTextInItSurvivesTheKeyboardClosing() {
        let magnifier = launchToInbox()
        magnifier.tap()

        let field = app.textFields[A11yID.searchField]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("sara")

        // Tapping the list dismisses the keyboard without touching the field.
        app.tap()
        Thread.sleep(forTimeInterval: 1.0)

        XCTAssertTrue(field.exists, "a field still filtering the list was hidden")
    }
}
