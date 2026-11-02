import XCTest

/// The card over the faded app when the workspace's plan has the mobile app
/// switched off (docs/operations/MOBILE_APP_PLAN.md), against the sample plan
/// that has it off (`-WebyarScreen appLocked`).
///
/// What a screenshot cannot show: that the app under the card is really gone
/// — nothing of it can be reached — and that nothing on the card points at a
/// website or a purchase.
final class AppLockTests: UITestCase {

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func launchLocked() {
        app.launchArguments += ["-WebyarScreen", "appLocked"]
        app.launch()
    }

    func testTheLockedAppIsOneCardAndNothingBehindItAnswers() {
        launchLocked()

        XCTAssertTrue(element(A11yID.appLockCard).waitForExistence(timeout: 25), "the lock card never appeared")
        XCTAssertTrue(app.staticTexts["اپ موبایل در پلن این فضای کاری نیست"].exists, "no title")
        XCTAssertTrue(element(A11yID.appLockSignOut).exists, "no way to sign out")

        // The app behind it is a picture: its toolbar and tabs are gone.
        let search = app.buttons[A11yID.inboxSearch]
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: search)
        waitForExpectations(timeout: 5)
    }

    func testTheCardNamesNoWebsiteAndNoPurchase() {
        launchLocked()
        XCTAssertTrue(element(A11yID.appLockCard).waitForExistence(timeout: 25), "the lock card never appeared")

        for word in ["سایت", "خرید", "ارتقا", "قیمت", "http"] {
            let match = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS[c] %@", word))
                .firstMatch
            XCTAssertFalse(match.exists, "the lock screen says “\(word)”")
        }
        XCTAssertEqual(app.links.count, 0, "the lock screen links somewhere")
    }
}
