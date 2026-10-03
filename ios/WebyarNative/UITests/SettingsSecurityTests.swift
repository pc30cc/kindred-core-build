import XCTest

/// Settings → Security's way out of every other device, Settings → About's
/// version, build and website, and who is asking at the top of a support
/// conversation — against the sample backend.
final class SettingsSecurityTests: UITestCase {

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Scrolls until `element` is on screen.
    private func reveal(_ element: XCUIElement, swipes: Int = 8) -> XCUIElement {
        for _ in 0..<swipes where !(element.exists && element.isHittable) {
            app.swipeUp()
        }
        return element
    }

    func testEveryOtherDeviceIsSignedOutAndThisOneStays() {
        app.launchArguments += ["-WebyarScreen", "security"]
        app.launch()

        let button = reveal(app.buttons[A11yID.securityRevokeOthers])
        XCTAssertTrue(button.waitForExistence(timeout: 20), "no way to sign out of the other devices")
        button.tap()

        // Asked first: it signs people out of computers they may be using.
        let sheet = app.sheets.firstMatch
        let alert = app.alerts.firstMatch
        XCTAssertTrue(
            sheet.waitForExistence(timeout: 5) || alert.waitForExistence(timeout: 5),
            "it did not ask before signing everybody out"
        )
        // `firstMatch` throughout: a bridged dialog carries its buttons twice.
        let container = sheet.exists ? sheet : alert
        let byID = container.buttons.matching(identifier: A11yID.securityRevokeOthersConfirm).firstMatch
        let confirm = byID.exists
            ? byID
            : container.buttons.matching(identifier: "خروج از همهٔ دستگاه‌های دیگر").firstMatch
        if !confirm.exists {
            print("NO-CONFIRM-BUTTON\n\(app.debugDescription)\nEND")
        }
        XCTAssertTrue(confirm.exists, "no confirming button")
        confirm.tap()

        // Said, and then the list is this phone alone — so the button goes.
        let notice = app.alerts.firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 10), "the outcome was not said")
        XCTAssertTrue(notice.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "۲")).firstMatch.exists,
                      "it did not say how many devices were signed out")
        notice.buttons.firstMatch.tap()
        XCTAssertTrue(waitForDisappearance(app.buttons[A11yID.securityRevokeOthers], timeout: 10),
                      "the button stayed with no other device left")
    }

    func testAboutSaysTheVersionTheBuildAndWhereTheWebsiteIs() {
        app.launchArguments += ["-WebyarScreen", "settings"]
        app.launch()

        let website = reveal(element(A11yID.settingsWebsite))
        XCTAssertTrue(website.waitForExistence(timeout: 20), "no Website row in About")
        // The name Super Admin gave it, not "Support".
        XCTAssertTrue(website.label.contains("سایت وبیار"), "the row is not called what Super Admin named it: \(website.label)")
        XCTAssertTrue(element(A11yID.settingsVersion).exists, "no version")
        XCTAssertTrue(element(A11yID.settingsBuild).exists, "no build")
        // App Review asks for the privacy policy inside the app.
        XCTAssertTrue(reveal(element(A11yID.settingsPrivacyPolicy)).waitForExistence(timeout: 5), "no privacy policy in About")
        XCTAssertTrue(element(A11yID.settingsTerms).exists, "no terms in About")
    }

    func testASupportConversationOpensWithWhoIsAsking() {
        launchToInbox()
        let cell = app.cells.containing(.any, identifier: A11yID.conversationRow("c-2")).firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 15), "the support conversation is not listed")
        cell.tap()

        // At the top of the conversation, which opens at its newest message.
        let card = element(A11yID.supportRequesterCard)
        _ = card.waitForExistence(timeout: 10)
        for _ in 0..<4 where !card.exists {
            app.swipeDown()
        }
        XCTAssertTrue(card.waitForExistence(timeout: 5), "the support conversation does not say who is asking")
        // The plan's two dates, in words the operator reads.
        for words in ["تاریخ خرید", "تاریخ اتمام"] {
            XCTAssertTrue(
                app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", words)).firstMatch.exists,
                "the card does not show «\(words)»"
            )
        }
    }
}
