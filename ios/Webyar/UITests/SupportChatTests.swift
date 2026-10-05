import XCTest

/// Settings → Online support, against the sample backend's support team: an
/// open conversation an agent answered, one resolved and rated, one closed
/// and waiting for its stars (`SampleAPI`, "Online support").
final class SupportChatTests: UITestCase {

    /// Anything carrying `identifier`, whatever kind of element SwiftUI made it.
    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    func testSettingsOffersSupportAndAMessageReachesTheTeam() {
        app.launchArguments += ["-WebyarScreen", "settings"]
        app.launch()

        // Below the account and notification sections: scrolled to.
        let row = element(A11yID.settingsSupportChat)
        for _ in 0..<8 where !(row.exists && row.isHittable) {
            app.swipeUp()
        }
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no Online support row in Settings")
        row.tap()

        XCTAssertTrue(element(A11yID.supportTranscript).waitForExistence(timeout: 20), "the chat never opened")
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Match the visitor")).firstMatch
                .waitForExistence(timeout: 10),
            "the team's answer is not in the chat"
        )

        let field = composerField()
        XCTAssertTrue(field.exists, "no composer under an open conversation")
        focus(field)
        field.typeText("Thanks, that fixed it")
        app.buttons[A11yID.composerSend].tap()

        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Thanks, that fixed it")).firstMatch
                .waitForExistence(timeout: 10),
            "the message never showed in the chat"
        )
    }

    func testAClosedConversationIsReadBackAndRatedOnce() {
        app.launchArguments += ["-WebyarScreen", "support"]
        app.launch()

        let closed = element(A11yID.supportClosedButton)
        XCTAssertTrue(closed.waitForExistence(timeout: 20), "no way to the closed conversations")
        closed.tap()

        let unrated = element(A11yID.supportClosedRow("sc-2"))
        XCTAssertTrue(unrated.waitForExistence(timeout: 15), "the closed conversation is not listed")
        XCTAssertTrue(element(A11yID.supportClosedRow("sc-1")).exists, "the rated one is not listed")
        unrated.tap()

        let star = element(A11yID.supportRatingStar("sc-2", 4))
        for _ in 0..<4 where !(star.exists && star.isHittable) {
            app.swipeUp()
        }
        XCTAssertTrue(star.waitForExistence(timeout: 15), "no stars to give")
        star.tap()
        element(A11yID.supportRatingSubmit("sc-2")).tap()

        XCTAssertTrue(
            element(A11yID.supportRatingGiven("sc-2")).waitForExistence(timeout: 10),
            "the rating did not land"
        )
        XCTAssertFalse(element(A11yID.supportRatingSubmit("sc-2")).exists, "it can be rated twice")
    }

    func testOfflineTheTeamsHoursShowOverAFreshPage() {
        app.launchArguments += ["-WebyarScreen", "supportOffline"]
        app.launch()

        XCTAssertTrue(element(A11yID.supportOfflineBanner).waitForExistence(timeout: 20), "no offline banner")
        XCTAssertTrue(element(A11yID.supportGreeting).waitForExistence(timeout: 10), "nothing open, but not a fresh page")
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "جمعه تعطیل")).firstMatch.exists,
            "the week is not in the banner"
        )
        XCTAssertTrue(composerField().exists, "a message can be left while the team is away")
    }
}
