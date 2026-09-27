import XCTest
@testable import Webyar

/// Sign-in refusals, and one call at a time while an answer is on its way.
@MainActor
final class AppFixesTests: XCTestCase {
    private let fa = Strings(.fa)

    private func refusal(_ status: Int, _ message: String?, body: String? = nil) -> ApiError {
        ApiError(failure: status == 401 ? .unauthorized : .server, status: status, serverMessage: message, body: body)
    }

    func testEachSignInRefusalSaysWhatToDo() {
        XCTAssertEqual(LoginView.message(for: refusal(401, "Invalid email or password"), fa), fa["loginFailed"])
        XCTAssertEqual(LoginView.message(for: refusal(429, "Account temporarily locked due to too many failed attempts."), fa), fa["loginLocked"])
        XCTAssertEqual(LoginView.message(for: refusal(400, "Captcha verification required", body: #"{"requiresCaptcha":true}"#), fa), fa["loginUseWeb"])
        XCTAssertEqual(LoginView.message(for: refusal(403, "Password setup required", body: #"{"passwordSetupRequired":true}"#), fa), fa["loginSetPassword"])
        XCTAssertEqual(LoginView.message(for: refusal(403, "This account has been disabled."), fa), fa["loginDisabled"])
        XCTAssertEqual(LoginView.message(for: refusal(400, "Invalid payload"), fa), fa["loginFailed"])
        for key in ["loginLocked", "loginUseWeb", "loginSetPassword", "loginDisabled",
                    "switchWorkspaceOnCallTitle", "switchWorkspaceOnCallBody", "switchWorkspaceOnCallConfirm"] {
            for language in Language.allCases {
                XCTAssertNotEqual(Strings(language)[key], key, "\(key) is missing in \(language)")
            }
        }
    }

    func testOneAnswerAtATime() {
        let calls = CallCoordinator.shared
        XCTAssertFalse(calls.isBusy)
        XCTAssertTrue(calls.beginAnswering())
        // A second answer, or a new call, while the first is on its way to the server.
        XCTAssertTrue(calls.isBusy)
        XCTAssertFalse(calls.beginAnswering())
        calls.endAnswering()
        XCTAssertFalse(calls.isBusy)
    }
}
