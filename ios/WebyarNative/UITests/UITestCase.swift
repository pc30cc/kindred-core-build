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

    /// The newest message on screen, by its identifier.
    ///
    /// Not by text, and not by holding onto an element. An `XCUIElement` from
    /// `allElementsBoundByIndex` is bound to a position in a snapshot, and the
    /// snapshot is stale the moment the view re-renders — which is exactly
    /// what opening the keyboard causes, so reading `.frame` off one then
    /// throws "No matches found". Text is no better: a timestamp repeats down
    /// the column. Every message row carries `A11y.messageRow(id)`, which is
    /// stable across both.
    func newestMessageID() -> String? {
        messageRows()
            .filter { $0.exists && $0.frame.height > 0 }
            .max { $0.frame.maxY < $1.frame.maxY }?
            .identifier
    }

    /// Where that message is now, asked fresh.
    func frameOfMessage(_ identifier: String) -> CGRect? {
        let text = app.staticTexts[identifier]
        if text.exists { return text.frame }
        let other = app.otherElements[identifier]
        return other.exists ? other.frame : nil
    }

    /// The message rows, without walking the whole hierarchy.
    ///
    /// `app.descendants(matching: .any)` was the obvious way to write this and
    /// it is ruinous: it enumerates every element on the screen, the query
    /// runs again on every call, and `waitUntilStill` calls it in a loop. On a
    /// transcript of a dozen messages that was enough to make the test runner
    /// stop responding and be killed mid-test — reported, confusingly, as the
    /// suite executing fewer tests than it contains rather than as a failure.
    ///
    /// A combined row of text surfaces as a `StaticText`; one whose content is
    /// a photo or a voice note surfaces as an `Other`. Two narrow queries cost
    /// a fraction of one wide one.
    private func messageRows() -> [XCUIElement] {
        let predicate = NSPredicate(format: "identifier BEGINSWITH 'message.'")
        return app.staticTexts.matching(predicate).allElementsBoundByIndex
            + app.otherElements.matching(predicate).allElementsBoundByIndex
    }

    /// Waits until a measurement stops changing.
    ///
    /// A transcript that opens scrolled to its newest message is still moving
    /// for a moment afterwards, and a tap that lands during that moment gets
    /// eaten by the scroll rather than focusing the field — which is a test
    /// that fails for a reason the operator would never see. Two identical
    /// readings in a row is enough to call it settled.
    func waitUntilStill(
        timeout: TimeInterval = 5,
        _ measure: () -> CGRect?
    ) {
        let deadline = Date().addingTimeInterval(timeout)
        var previous: CGRect?
        while Date() < deadline {
            let now = measure()
            if let now, now == previous { return }
            previous = now
            Thread.sleep(forTimeInterval: 0.25)
        }
    }

    /// Puts the caret in a field and waits for the keyboard, trying twice.
    ///
    /// One tap is usually enough. It is not always: the first can arrive while
    /// the screen is still animating, and then nothing happens at all — no
    /// focus, no keyboard, no error. Rather than lengthening a sleep until it
    /// stops failing, this checks whether the tap did what taps do.
    @discardableResult
    func focus(_ field: XCUIElement) -> XCUIElement {
        field.tap()
        if app.keyboards.element.waitForExistence(timeout: 4) {
            return waitForKeyboard()
        }
        field.tap()
        return waitForKeyboard()
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
    static let shortcutsButton = "composer.shortcuts"
    static func shortcutRow(_ id: String) -> String { "shortcut.\(id)" }
    static let attachButton = "composer.attach"
    static func messageRow(_ id: String) -> String { "message.\(id)" }
}
