import XCTest

/// The shared setup for a run against the sample backend.
///
/// Every test here launches the app with `-WebyarSampleData`, so there is no
/// account, no network and no credential anywhere in this target: the sample
/// backend is compiled only into Debug and only answers when this argument is
/// present. The language is pinned too, because half of what these tests are
/// about — which way a bubble points, which side the toolbar sits on — is
/// decided by the reading direction.
class UITestCase: XCTestCase {
    var app: XCUIApplication!

    /// Persian by default: it is the right-to-left case, and the layout bugs
    /// these tests exist for only appeared there.
    var language: String { "fa" }

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-WebyarSampleData", "-WebyarLanguage", language]
    }

    override func tearDown() {
        app = nil
        super.tearDown()
    }

    /// Launches and waits for the inbox to have rows in it.
    @discardableResult
    func launchToInbox() -> XCUIElement {
        app.launch()
        let search = app.buttons[A11yID.inboxSearch]
        XCTAssertTrue(search.waitForExistence(timeout: 20), "the inbox toolbar never appeared")
        return search
    }

    /// The keyboard, once it is actually on screen.
    ///
    /// `app.keyboards.element` exists before it has finished animating in, and
    /// its frame is wrong until it has — which matters, because these tests
    /// compare frames against it.
    func waitForKeyboard(timeout: TimeInterval = 10) -> XCUIElement {
        let keyboard = app.keyboards.element(boundBy: 0)
        XCTAssertTrue(keyboard.waitForExistence(timeout: timeout), "the keyboard never opened")
        // One settle: the frame is animated, and a comparison against a
        // half-raised keyboard tests nothing.
        let deadline = Date().addingTimeInterval(3)
        var last = keyboard.frame
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            let now = keyboard.frame
            if now == last { break }
            last = now
        }
        return keyboard
    }

    /// Waits for an element to go away, which `waitForExistence` cannot do.
    func waitForDisappearance(_ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !element.exists { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return !element.exists
    }
}

/// The identifiers, repeated.
///
/// The test bundle cannot see the app's own `A11y` enum — a UI test target
/// links against nothing of the app, by design, because it drives the app from
/// outside, as a separate process. That leaves two lists to keep in step, and
/// a renamed identifier would not fail to compile; it would fail to find the
/// element, ten minutes into a simulator run, as a timeout. So
/// `src/test/ios/accessibilityIdentifiers.test.ts` reads both files and fails
/// in a second if they ever disagree.
enum A11yID {
    static let inboxSearch = "inbox.search"
    static let inboxFilter = "inbox.filter"
    static let searchField = "search.field"
    static let tabBar = "tab.bar"
    static let composerField = "composer.field"
    static func workspaceRow(_ id: String) -> String { "settings.workspace.\(id)" }
}
