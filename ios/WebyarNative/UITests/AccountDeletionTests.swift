import XCTest

/// Deleting your own account, driven end to end.
///
/// This exists because the feature was reported as doing nothing when the
/// button was pressed, and there was no way to tell from the outside which of
/// the four links in the chain had come apart: the row in Security, the push,
/// the button on the screen, or the confirmation. So the test walks all four.
///
/// It is safe to run against anything, because it runs against the sample
/// backend like every test here: `SampleAPI.deleteAccount` answers with the
/// refusal — the sample operator owns both sample workspaces — so the path is
/// exercised to its end without anything being deleted anywhere.
final class AccountDeletionTests: UITestCase {

    /// English here. The rest of the suite runs Persian because it is about
    /// which way things point; this one is about a sequence of taps, and the
    /// confirmation's own buttons have to be found by their words.
    override var language: String { "en" }

    private var deleteFinal: String { "Delete my account" }

    // MARK: - The chain

    func testSecurityHasTheRowAndItOpensTheScreen() {
        launchToSecurity()

        let row = control(A11yID.deleteAccountRow)
        XCTAssertTrue(row.exists, "Security has no way into account deletion")
        reveal(row)
        row.tap()

        XCTAssertTrue(
            passwordField.waitForExistence(timeout: 10),
            "tapping the deletion row did not open the deletion screen"
        )
    }

    /// The reported symptom, as a test.
    ///
    /// The button used to be disabled until a password had been typed, and
    /// the password field is below a paragraph of explanation — so pressing
    /// the one red button on the screen did nothing whatsoever and said
    /// nothing about why. Whatever else it does, it has to answer.
    func testThePrimaryButtonAnswersEvenWithNoPasswordTyped() {
        openDeletionScreen()

        let submit = control(A11yID.deleteAccountSubmit)
        XCTAssertTrue(submit.isEnabled, "the only button on the screen is dead on arrival")

        reveal(submit)
        submit.tap()

        // It asks rather than proceeding...
        XCTAssertFalse(
            app.buttons[deleteFinal].waitForExistence(timeout: 2),
            "an empty password got as far as the confirmation"
        )
        // ...and it says so, where the field is.
        XCTAssertTrue(
            app.staticTexts["Enter your password to confirm"].firstMatch.exists,
            "the button refused and gave no reason"
        )
    }

    func testTypingAPasswordAndConfirmingReachesTheServersAnswer() {
        openDeletionScreen()

        let field = passwordField
        reveal(field)
        field.tap()
        field.typeText("not-the-real-one")

        let submit = control(A11yID.deleteAccountSubmit)
        reveal(submit)
        submit.tap()

        let confirm = confirmationButton()
        XCTAssertTrue(
            confirm.waitForExistence(timeout: 10),
            "the confirmation never appeared, so the request is never made"
        )
        confirm.tap()

        // The sample operator owns both sample workspaces, so this is the
        // refusal — which is the branch worth reaching, because it proves the
        // request was made and its answer was read.
        let blocked = control(A11yID.deleteAccountBlocked, timeout: 15)
        XCTAssertTrue(blocked.exists, "the screen never showed what came back")
        XCTAssertFalse(
            app.secureTextFields[A11yID.deleteAccountPassword].exists,
            "the password field is still being offered after the server refused"
        )
    }

    // MARK: - Getting there

    private func launchToSecurity() {
        app.launchArguments += ["-WebyarScreen", "security"]
        app.launch()

        let row = control(A11yID.deleteAccountRow, timeout: 30)
        XCTAssertTrue(row.exists, "Security never appeared")
    }

    private func openDeletionScreen() {
        launchToSecurity()
        let row = control(A11yID.deleteAccountRow)
        reveal(row)
        row.tap()
        XCTAssertTrue(passwordField.waitForExistence(timeout: 10), "the deletion screen never opened")
    }

    private var passwordField: XCUIElement {
        app.secureTextFields[A11yID.deleteAccountPassword]
    }

    /// The destructive button inside the confirmation.
    ///
    /// By identifier if it survived the trip — a `confirmationDialog` is
    /// bridged to `UIAlertController`, which takes a title and a role from
    /// each button and may not carry anything else — and by its words if it
    /// did not. Scoped to the presented sheet either way, because the button
    /// that opened it carries the same words.
    private func confirmationButton() -> XCUIElement {
        let byID = app.buttons[A11yID.deleteAccountConfirm]
        if byID.waitForExistence(timeout: 3) { return byID }

        let inSheet = app.sheets.buttons[deleteFinal]
        if inSheet.exists { return inSheet }

        let inAlert = app.alerts.buttons[deleteFinal]
        if inAlert.exists { return inAlert }

        // Last resort: the newest one on screen, which is the presented one.
        let all = app.buttons.matching(identifier: deleteFinal)
        return all.count > 1 ? all.element(boundBy: all.count - 1) : all.firstMatch
    }

    /// An element by identifier, whatever kind of element it turned out to be.
    ///
    /// A `NavigationLink` row is a button on one iOS version and a cell on the
    /// next, and a test that names the wrong one fails as a timeout that says
    /// nothing.
    private func control(_ id: String, timeout: TimeInterval = 20) -> XCUIElement {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let button = app.buttons[id]
            if button.exists { return button }
            let cell = app.cells[id]
            if cell.exists { return cell }
            let any = app.descendants(matching: .any).matching(identifier: id).firstMatch
            if any.exists { return any }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        return app.buttons[id]
    }

    /// Scrolls until the element can actually be tapped.
    ///
    /// Security is a long screen — a password form, then every signed-in
    /// device — and the deletion row is under all of it.
    private func reveal(_ element: XCUIElement) {
        var attempts = 0
        while element.exists, !element.isHittable, attempts < 6 {
            app.swipeUp()
            attempts += 1
        }
    }
}
