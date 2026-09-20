import XCTest

/// The composer's saved replies — the console's lightning bolt, on a phone.
///
/// The thing worth testing is not that a sheet opens. It is that what lands in
/// the draft has had its placeholders filled in: a reply stored as
/// "Hello {{contact.name}}" must reach the visitor as a greeting, not as a
/// template. The sample backend's first reply carries two of them, one that
/// resolves and one that does not, which is exactly the pair that matters.
final class ShortcutTests: UITestCase {

    func testAReplyIsInsertedWithItsPlaceholdersFilledIn() {
        openChat()

        app.buttons[A11yID.shortcutsButton].tap()

        let greeting = app.buttons[A11yID.shortcutRow("cr-1")]
        XCTAssertTrue(greeting.waitForExistence(timeout: 10), "the saved replies never listed")
        greeting.tap()

        let composer = composerField()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))

        let draft = composer.value as? String ?? ""
        XCTAssertTrue(
            draft.contains("Sample Workspace"),
            "{{workspace.name}} was not filled in — draft was \(draft)"
        )
        XCTAssertFalse(
            draft.contains("{{workspace.name}}"),
            "the placeholder was inserted verbatim — draft was \(draft)"
        )
    }

    /// A name with nothing behind it keeps its braces.
    ///
    /// This is the web's rule and it is the right one: a greeting that
    /// silently becomes "Hello ," has lost the operator's chance to notice,
    /// while one that still reads "Hello {{contact.name}}" cannot be sent by
    /// accident without being seen.
    func testAPlaceholderWithNoValueIsLeftAsWritten() {
        // A visitor who never gave a name, so `{{contact.name}}` has nothing
        // to resolve to. This is the ordinary case, not a contrived one: most
        // threads start from somebody anonymous.
        app.launchArguments += ["-WebyarScreen", "anonymousChat"]
        app.launch()

        let composer = composerField()
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "the anonymous chat never opened")

        app.buttons[A11yID.shortcutsButton].tap()
        let greeting = app.buttons[A11yID.shortcutRow("cr-1")]
        XCTAssertTrue(greeting.waitForExistence(timeout: 10))
        greeting.tap()

        let draft = composer.value as? String ?? ""
        XCTAssertTrue(
            draft.contains("{{contact.name}}"),
            "an unresolvable placeholder was swallowed — draft was \(draft)"
        )
        XCTAssertTrue(
            draft.contains("Sample Workspace"),
            "the resolvable one was not filled in either — draft was \(draft)"
        )
    }

    /// Searching narrows the list.
    func testSearchingFiltersTheSavedReplies() {
        openChat()
        app.buttons[A11yID.shortcutsButton].tap()

        XCTAssertTrue(
            app.buttons[A11yID.shortcutRow("cr-1")].waitForExistence(timeout: 10)
        )
        XCTAssertTrue(app.buttons[A11yID.shortcutRow("cr-3")].exists)

        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5), "the picker has no search field")
        search.tap()
        search.typeText("bye")

        // The third one is titled "Closing" with the shortcut "bye"; the first
        // matches neither.
        XCTAssertTrue(
            waitForDisappearance(app.buttons[A11yID.shortcutRow("cr-1")], timeout: 6),
            "searching did not narrow the list"
        )
        XCTAssertTrue(app.buttons[A11yID.shortcutRow("cr-3")].exists)
    }

    // MARK: - Helpers

    private func openChat() {
        app.launchArguments += ["-WebyarScreen", "chat"]
        app.launch()
        XCTAssertTrue(composerField().waitForExistence(timeout: 25), "the chat never opened")
    }

    /// The composer's field, whichever element kind it surfaces as.
    ///
    /// A `TextField` that has grown to more than one line surfaces as a
    /// `TextView`, so both have to be allowed for. This used to choose
    /// between them *before* the app had drawn: called straight after
    /// `launch()`, `exists` was false on the `TextField` query, so it handed
    /// back the `TextView` one and the caller then spent its whole 25-second
    /// budget waiting on a query that cannot match an empty composer. Which
    /// screen lost the race varied by machine load, which is why this suite
    /// failed on a different test every run and looked like flake.
    ///
    /// So: wait for either, and return the one that arrived.
    private func composerField(timeout: TimeInterval = 25) -> XCUIElement {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let asField = app.textFields[A11yID.composerField].firstMatch
            if asField.exists { return asField }
            let asView = app.textViews[A11yID.composerField].firstMatch
            if asView.exists { return asView }
            Thread.sleep(forTimeInterval: 0.25)
        }
        // Nothing came. Hand back the field query so the caller's own
        // assertion is the one that reports it.
        return app.textFields[A11yID.composerField].firstMatch
    }
}
