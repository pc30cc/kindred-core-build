import XCTest

/// Every workspace the operator belongs to, each with its own logo.
///
/// Settings used to put them behind a `Picker`: one tap to see the list, names
/// only, no logos. An operator with a second workspace could miss it entirely,
/// and a name on its own is not how anyone recognises their own company.
final class SettingsWorkspaceTests: UITestCase {

    func testEveryWorkspaceIsListedAndTheCurrentOneIsMarked() {
        app.launchArguments += ["-WebyarScreen", "settings"]
        app.launch()

        let first = app.buttons[A11yID.workspaceRow("ws-1")]
        let second = app.buttons[A11yID.workspaceRow("ws-2")]

        XCTAssertTrue(first.waitForExistence(timeout: 25), "the current workspace is not in Settings")
        XCTAssertTrue(second.exists, "a workspace the operator belongs to is not shown")

        // The checkmark is a trait, not a glyph the test has to find: a row
        // that is selected says so to the screen reader too.
        XCTAssertTrue(first.isSelected, "the current workspace is not marked as such")
        XCTAssertFalse(second.isSelected, "two workspaces are both marked current")
    }

    func testTappingTheOtherWorkspaceSwitchesToIt() {
        app.launchArguments += ["-WebyarScreen", "settings"]
        app.launch()

        let first = app.buttons[A11yID.workspaceRow("ws-1")]
        let second = app.buttons[A11yID.workspaceRow("ws-2")]
        XCTAssertTrue(first.waitForExistence(timeout: 25))

        second.tap()

        // The selection moves. Everything downstream of it — the inbox, the
        // plan, the tabs — follows from this one bit.
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline, !second.isSelected {
            Thread.sleep(forTimeInterval: 0.3)
        }
        XCTAssertTrue(second.isSelected, "tapping a workspace did not switch to it")
        XCTAssertFalse(first.isSelected, "the old workspace is still marked current")
    }
}
