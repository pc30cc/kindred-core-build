import XCTest

/// "WEBYAR AI" at the foot of the signed-out screens.
///
/// A screenshot shows that it is there. What a screenshot cannot show is the
/// thing that was asked for: that it is in the same place on sign in and on
/// password reset — the launch screen's place — and that it stays there while
/// one screen replaces the other and while the keyboard comes up.
final class AuthScreenTests: UITestCase {

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func launchToLogin() {
        app.launchArguments += ["-WebyarScreen", "login"]
        app.launch()
    }

    /// Where the name is now, asked fresh. Two text runs combined into one
    /// element surface as a `StaticText` or as an `Other` depending on the
    /// system, so both are asked — narrowly, rather than walking the tree.
    private func footerFrame() -> CGRect? {
        let text = app.staticTexts[A11yID.brandFooter]
        if text.exists { return text.frame }
        let other = app.otherElements[A11yID.brandFooter]
        return other.exists ? other.frame : nil
    }

    private func waitForFooter(timeout: TimeInterval = 25) -> CGRect? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let frame = footerFrame() { return frame }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return nil
    }

    func testSignInIsSignedAtTheFootOfTheScreen() {
        launchToLogin()

        guard let footer = waitForFooter() else {
            return XCTFail("sign in has no WEBYAR AI at its foot")
        }
        let screen = app.windows.firstMatch.frame

        // Centred, and at the bottom: the launch screen's 20 points above the
        // safe area, which on any phone is inside the last tenth of the
        // screen and never flush against its edge.
        XCTAssertLessThan(abs(footer.midX - screen.midX), 2, "the name is not centred")
        XCTAssertGreaterThan(footer.minY, screen.height * 0.88, "the name is not at the foot of the screen")
        XCTAssertLessThan(footer.maxY, screen.maxY - 19, "the name is against the bottom edge")

        // And the form ends above it rather than under it.
        let signIn = app.buttons["ورود"]
        if signIn.exists {
            XCTAssertLessThan(signIn.frame.maxY, footer.minY, "the sign-in button runs into the name")
        }
    }

    func testSignInLinksThePrivacyPolicyAndTerms() {
        launchToLogin()

        let privacy = element(A11yID.loginPrivacyPolicy)
        XCTAssertTrue(privacy.waitForExistence(timeout: 20), "sign in does not link the privacy policy")
        XCTAssertTrue(element(A11yID.loginTerms).exists, "sign in does not link the terms")
        if let footer = waitForFooter() {
            XCTAssertLessThan(privacy.frame.maxY, footer.minY, "the links run into the name")
        }
    }

    func testTheNameStaysPutFromSignInToPasswordReset() {
        launchToLogin()

        guard let onSignIn = waitForFooter() else {
            return XCTFail("sign in has no WEBYAR AI at its foot")
        }

        let forgot = app.buttons["رمز عبور را فراموش کرده‌اید؟"]
        XCTAssertTrue(forgot.waitForExistence(timeout: 5), "no way to reset the password")
        forgot.tap()
        XCTAssertTrue(
            app.staticTexts["بازنشانی رمز عبور"].waitForExistence(timeout: 5),
            "password reset never opened"
        )
        waitUntilStill { footerFrame() }

        guard let onReset = footerFrame() else {
            return XCTFail("password reset has no WEBYAR AI at its foot")
        }
        XCTAssertEqual(onReset.minX, onSignIn.minX, accuracy: 0.5, "the name moved sideways on password reset")
        XCTAssertEqual(onReset.minY, onSignIn.minY, accuracy: 0.5, "the name moved up or down on password reset")

        // Reset opens with the caret in its one field, so the keyboard comes
        // up — and goes over the name rather than lifting it into the middle
        // of the form.
        let keyboard = waitForKeyboard()
        guard let underKeyboard = footerFrame() else {
            return XCTFail("the name left the hierarchy when the keyboard opened")
        }
        XCTAssertEqual(underKeyboard.minY, onSignIn.minY, accuracy: 0.5, "the keyboard pushed the name up")
        XCTAssertGreaterThan(underKeyboard.minY, keyboard.frame.minY, "the name is sitting on the keyboard")
    }
}
