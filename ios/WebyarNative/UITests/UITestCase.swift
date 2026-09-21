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
        // No promotions: the full-screen card is paced by launch count and by
        // a per-day cap, so it lands over some runs of this suite and not
        // others — see `PromotionCenter.isSuppressed`. It has its own
        // screenshot path; it has no business over a keyboard test.
        app.launchArguments = [
            "-WebyarSampleData",
            "-WebyarNoPromotions",
            "-WebyarLanguage", language,
        ]

        // iOS's own first-run keyboard tutorial — "Speed up your typing by
        // sliding your finger across the letters", with a Continue button —
        // appears the first time a keyboard is shown on a freshly erased
        // device. It sits over the keyboard and swallows every tap, and it
        // belongs to Springboard rather than to the app, so nothing in here
        // sees it: the tests simply fail, variously and confusingly, at
        // whatever they were about to touch. Costing half a day to that once
        // is enough.
        addUIInterruptionMonitor(withDescription: "keyboard tutorial") { alert in
            for label in ["Continue", "ادامه", "Devam"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
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

    /// Puts the keyboard away by tapping the transcript, and says whether it
    /// worked.
    ///
    /// Empty space, not a bubble. A bubble has taps of its own — opening a
    /// photo, selecting text — and swallows this one, which is exactly how
    /// Messages behaves: you tap beside a message to dismiss, not on it. That
    /// is easy to miss while the sample conversation is short enough to leave
    /// the middle of the screen empty, and it stops being true the moment the
    /// transcript fills up. So the tap goes in a gutter, up either edge, where
    /// the space beside a bubble always is.
    ///
    /// WHICH gutter, though, is the whole of this. It used to be a ladder of
    /// coordinates counted upwards from the top of the keyboard, and the first
    /// two rungs of that ladder were never on the transcript at all: the
    /// composer sits between the two, and it is attached as a
    /// `safeAreaInset`, which shrinks a scroll view's CONTENT and leaves its
    /// FRAME running the whole way down behind it. So `transcript.frame`
    /// agreed that 30 points above the keyboard was inside the transcript,
    /// and the tap landed on the composer's `.bar` background, which absorbs
    /// a tap and dismisses nothing. Both gutters at that height, three
    /// seconds a run, every run, teaching nothing. A composer one line taller
    /// — a two-line draft, the emoji strip open, a device with a deeper home
    /// indicator — would have eaten the next pair as well, and a transcript
    /// full enough to cover its gutters would have eaten the rest and
    /// returned false.
    ///
    /// A message row is the one thing on this screen that is certainly inside
    /// the scroll view and certainly above the composer, so the rows are what
    /// this aims between, newest first — which is also where the operator's
    /// own thumb would be.
    ///
    /// The floor is the composer's own top, not the keyboard's. The ceiling
    /// is the navigation bar: a scroll view's frame reaches under the status
    /// bar, and a tap on the status bar means "scroll to the top" to iOS — so
    /// a candidate up there dismisses nothing and throws the transcript back
    /// to the beginning of the conversation, which then fails the next
    /// assertion for a reason that has nothing to do with keyboards.
    @discardableResult
    func dismissKeyboardByTapping(_ transcript: XCUIElement, above keyboard: XCUIElement) -> Bool {
        let bounds = transcript.frame
        let chrome = app.navigationBars.firstMatch
        let ceiling = max(bounds.minY, chrome.exists ? chrome.frame.maxY : 0)
        // The composer's own top, when it can be trusted.
        //
        // `exists` is not enough. A query can resolve against a snapshot the
        // layout has since replaced and hand back a frame of zero, and a
        // floor of zero is above the ceiling — at which point this returned
        // false without tapping anything, which is a test failing for a
        // reason the operator would never see. So the composer is only
        // believed when it is where a composer can be; otherwise the keyboard
        // is the floor, which is where this started.
        let composer = app.textFields[A11yID.composerField].firstMatch
        let composerTop = composer.exists ? composer.frame.minY : 0
        let floor = composerTop > ceiling
            ? min(composerTop, keyboard.frame.minY)
            : keyboard.frame.minY
        guard floor > ceiling else { return false }

        // Rows lying wholly in the clear band, newest last on screen first.
        var heights = visibleMessageFrames()
            .filter { $0.height > 0 && $0.minY >= ceiling && $0.maxY <= floor }
            .sorted { $0.midY > $1.midY }
            .map(\.midY)
        // A transcript can hold one message too tall to fit the band — a long
        // note, a photo. The band itself is still scroll view and still not
        // composer, so aim at the middle of it rather than giving up.
        if heights.isEmpty { heights = [(ceiling + floor) / 2] }

        for y in heights {
            for x in [bounds.maxX - 12, bounds.minX + 12] {
                app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: x, dy: y))
                    .tap()
                if waitForDisappearance(app.keyboards.element, timeout: 1.5) { return true }
            }
        }
        return false
    }

    /// Where the messages are right now, asked once.
    ///
    /// `messageRows()` walks two queries; calling it per candidate would put
    /// the cost back that `messageRows()`'s own note is about.
    func visibleMessageFrames() -> [CGRect] {
        messageRows().filter(\.exists).map(\.frame)
    }

    /// The composer, whichever kind of element this iOS decided it is.
    ///
    /// A `TextField(axis: .vertical)` is a `textField` to XCUITest on iOS 26
    /// and a `textView` on some other releases, and a `TextField` that has
    /// grown past one line surfaces as a `TextView` on any of them. Neither is
    /// worth pinning a test to, so both have to be allowed for.
    ///
    /// This used to choose between them *before* the app had drawn: called
    /// straight after `launch()`, `exists` was false on the `TextField` query,
    /// so it handed back the `TextView` one and the caller then spent its
    /// whole 25-second budget waiting on a query that cannot match an empty
    /// composer. Which screen lost the race varied by machine load, which is
    /// why this suite failed on a different test every run and looked like
    /// flake.
    ///
    /// So: wait for either, and return the one that arrived.
    func composerField(timeout: TimeInterval = 25) -> XCUIElement {
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
    static let inboxTitleMenu = "inbox.title.menu"
    static let conversationMenu = "chat.menu"
    static let composerSend = "composer.send"
    static let sayNowVoice = "sayNow.voice"
}
