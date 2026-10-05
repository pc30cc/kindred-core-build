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

        // It asks rather than proceeding. Not `app.buttons[deleteFinal]` —
        // the button that was just pressed carries those words itself, so
        // that query is true whether or not anything was presented.
        XCTAssertFalse(
            app.sheets.firstMatch.waitForExistence(timeout: 2) || app.alerts.firstMatch.exists,
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
        let keyboard = waitForKeyboard()
        field.typeText("not-the-real-one")

        // Put the keyboard away first: on a phone the button sits under it
        // once the caret is in the field. Tapping the explanation is how an
        // operator does it, and it is the dismisser doing its job.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        XCTAssertTrue(waitForDisappearance(keyboard), "the keyboard would not go away")

        let submit = control(A11yID.deleteAccountSubmit)
        reveal(submit)
        submit.tap()

        let confirm = confirmationButton()
        XCTAssertTrue(confirm.exists, "the confirmation never offered a way to go through with it")
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
    /// Scoped to the presented container, always: the button that opened the
    /// confirmation carries the same words, so an unscoped query for them is
    /// answered by the screen underneath and says nothing about whether
    /// anything was presented at all.
    ///
    /// A `confirmationDialog` is bridged to `UIAlertController` — a sheet on
    /// a phone — which takes a title and a role from each button and need not
    /// carry the identifier across, so that is tried first and the words are
    /// the fallback rather than the other way round.
    private func confirmationButton() -> XCUIElement {
        let sheet = app.sheets.firstMatch
        let alert = app.alerts.firstMatch
        let appeared = sheet.waitForExistence(timeout: 5) || alert.waitForExistence(timeout: 5)
        if !appeared {
            print("NO-CONFIRMATION\n\(app.debugDescription)\nEND-NO-CONFIRMATION")
            XCTFail("the confirmation never appeared, so the request is never made")
            return sheet
        }

        // `firstMatch` throughout: a presented `UIAlertController` carries its
        // buttons twice in the hierarchy, and an unqualified subscript on a
        // query with two matches is an error rather than a choice.
        let container = sheet.exists ? sheet : alert
        let byID = container.buttons.matching(identifier: A11yID.deleteAccountConfirm).firstMatch
        return byID.exists ? byID : container.buttons.matching(identifier: deleteFinal).firstMatch
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
