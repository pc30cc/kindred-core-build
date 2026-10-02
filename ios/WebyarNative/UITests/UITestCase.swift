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
    ///
    /// Each row is read once — its identifier and its frame together — from
    /// elements bound to the row itself rather than to a position in the
    /// list: a transcript still drawing its last rows re-renders between two
    /// reads, and a row bound by index then resolves to nothing ("No matches
    /// found") on the second. Bound to the row, it is the same row or gone.
    func newestMessageID() -> String? {
        var newest: (id: String, maxY: CGFloat)?
        for row in messageRows() where row.exists {
            let frame = row.frame
            guard frame.height > 0 else { continue }
            let id = row.identifier
            if newest.map({ frame.maxY > $0.maxY }) ?? true { newest = (id, frame.maxY) }
        }
        return newest?.id
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
        return app.staticTexts.matching(predicate).allElementsBoundByAccessibilityElement
            + app.otherElements.matching(predicate).allElementsBoundByAccessibilityElement
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

    /// Puts the keyboard away by tapping beside a message, and says whether
    /// it worked.
    ///
    /// Beside, never on: a bubble has taps of its own — opening a photo,
    /// selecting text — and swallows this one, which is exactly how Messages
    /// behaves. The gutter beside a bubble is empty by construction, because
    /// the transcript's stack is inset sixteen points and the tap goes at
    /// twelve.
    ///
    /// EVERY NUMBER HERE COMES FROM THE SCREEN OR FROM THE ROWS, and none of
    /// them from the scroll view. That is the whole of what went wrong with
    /// this helper, three times:
    ///
    ///   * `app.scrollViews.firstMatch` is not reliably the transcript once
    ///     the keyboard is up. The keyboard has scroll views of its own — the
    ///     predictive bar sits directly above the keys — and which one comes
    ///     first in the hierarchy varies between runs. Taking its frame put
    ///     the entire search band INSIDE the keyboard, so the helper tapped
    ///     (390, 561) twice, on the keyboard itself, and reported that
    ///     tapping beside the messages had not worked. That is also the
    ///     honest explanation of this test's long-standing intermittence.
    ///   * The composer is a `textField` or a `textView` depending on the iOS
    ///     build and on whether it has grown past one line, so asking for one
    ///     kind found nothing on the runs where it was the other.
    ///   * And `exists` is not proof of a usable frame: a stale snapshot
    ///     hands back zero, which is above the ceiling.
    ///
    /// The message rows are the one thing on this screen that is certainly
    /// inside the transcript and certainly above the composer. They are what
    /// this aims between, newest first, which is also where the operator's
    /// own thumb would be.
    @discardableResult
    func dismissKeyboardByTapping(above keyboard: XCUIElement) -> Bool {
        let screen = app.frame

        // Below the chrome: a transcript reaches under the status bar, and a
        // tap on the status bar means "scroll to the top" to iOS — which
        // dismisses nothing and throws the transcript back to the beginning
        // of the conversation, failing the next assertion for a reason that
        // has nothing to do with keyboards.
        let chrome = app.navigationBars.firstMatch
        let ceiling = chrome.exists ? chrome.frame.maxY : screen.minY

        // Above the composer, which is where the keyboard's own top is not:
        // the composer sits between the two, and a tap on its bar is
        // swallowed by the bar.
        let composerTop = composerNow?.frame.minY ?? 0
        let floor = composerTop > ceiling
            ? min(composerTop, keyboard.frame.minY)
            : keyboard.frame.minY

        let rows = visibleMessageFrames()
            .filter { $0.height > 0 && $0.minY >= ceiling && $0.maxY <= floor }
            .sorted { $0.midY > $1.midY }

        guard !rows.isEmpty else {
            XCTFail("""
                no message row to tap beside: ceiling \(ceiling), floor \(floor),                 composer top \(composerTop), keyboard top \(keyboard.frame.minY),                 rows \(visibleMessageFrames().map(\.midY))
                """)
            return false
        }

        // The screen's own edges. The transcript is full width, so these are
        // its gutters — and unlike its frame, they cannot turn out to belong
        // to the keyboard.
        let gutters = [screen.maxX - 12, screen.minX + 12]

        for row in rows {
            for x in gutters {
                app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: x, dy: row.midY))
                    .tap()
                if waitForDisappearance(app.keyboards.element, timeout: 1.5) { return true }
            }
        }
        return false
    }

    /// The composer as it is right now, whichever element kind, without
    /// waiting for it.
    ///
    /// `composerField()` polls for up to twenty-five seconds, which is right
    /// while a screen is opening and wrong here: this is asked with the
    /// keyboard already up, so the field is either on screen or this screen
    /// has no composer at all.
    private var composerNow: XCUIElement? {
        let asField = app.textFields[A11yID.composerField].firstMatch
        if asField.exists { return asField }
        let asView = app.textViews[A11yID.composerField].firstMatch
        return asView.exists ? asView : nil
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
    static func conversationRow(_ id: String) -> String { "conversation.\(id)" }
    static let deleteAccountRow = "settings.deleteAccount"
    static let deleteAccountPassword = "deleteAccount.password"
    static let deleteAccountSubmit = "deleteAccount.submit"
    static let deleteAccountConfirm = "deleteAccount.confirm"
    static let deleteAccountBlocked = "deleteAccount.blocked"
    static let offlineNotice = "sync.offlineNotice"
    static let storageRow = "settings.storage"
    static let clearCache = "settings.storage.clear"
    static let brandFooter = "brand.footer"
    static func channelLabel(_ key: String) -> String { "channel.\(key)" }
    static let settingsSupportChat = "settings.support.chat"
    static let supportTranscript = "support.transcript"
    static let supportGreeting = "support.greeting"
    static let supportOfflineBanner = "support.offline"
    static let supportEndedPanel = "support.ended"
    static let supportStartNew = "support.startNew"
    static let supportClosedButton = "support.closed"
    static let supportClosedList = "support.closed.list"
    static func supportClosedRow(_ id: String) -> String { "support.closed.\(id)" }
    static func supportRatingStar(_ id: String, _ star: Int) -> String { "support.rating.\(id).star.\(star)" }
    static func supportRatingComment(_ id: String) -> String { "support.rating.\(id).comment" }
    static func supportRatingSubmit(_ id: String) -> String { "support.rating.\(id).submit" }
    static func supportRatingGiven(_ id: String) -> String { "support.rating.\(id).given" }
    static func supportRetry(_ id: String) -> String { "support.retry.\(id)" }

    // The mailbox (Inbox → Email). The same names as the Android app's test tags.
    static let emailList = "email.list"
    static func emailRow(_ threadID: String) -> String { "email.row.\(threadID)" }
    static func emailStar(_ threadID: String) -> String { "email.star.\(threadID)" }
    static let emailLoading = "email.loading"
    static let emailEmpty = "email.empty"
    static let emailNotConnected = "email.notConnected"
    /// The thin line under the filters while the list is read again.
    static let emailSyncing = "email.syncing"
    /// The bar's ☰, which opens the folders.
    static let emailFolders = "email.folders"
    static let emailDrawer = "email.drawer"
    static func emailMailFolder(_ id: String) -> String { "email.folder.\(id)" }
    static func emailMailbox(_ provider: String) -> String { "email.mailbox.\(provider)" }
    static func emailFilter(_ filter: String) -> String { "email.filter.\(filter)" }
    static let emailCompose = "email.compose"
    /// The page a thread is read on.
    static let emailThread = "email.thread"
    static let emailThreadStar = "email.thread.star"
    static let emailMenu = "email.menu"
    static let emailReply = "email.reply"
    static let emailReplyAll = "email.replyAll"
    static let emailForward = "email.forward"
    static let emailDownloading = "email.downloading"
    static let emailComposeTo = "email.compose.to"
    static let emailComposeCc = "email.compose.cc"
    static let emailComposeCcBcc = "email.compose.ccBcc"
    static let emailComposeSubject = "email.compose.subject"
    static let emailComposeBody = "email.compose.body"
    static let emailComposeSend = "email.compose.send"
    static let emailComposeClose = "email.compose.close"
    static let emailComposeAttach = "email.compose.attach"
    static let emailComposeAttachment = "email.compose.attachment"
    static let emailComposeError = "email.compose.error"

    /// Who is asking: the card at the top of a platform-support conversation.
    static let supportRequesterCard = "support.requester"

    /// Security: sign out of every device but this one.
    static let securityRevokeOthers = "security.revokeOthers"
    /// The confirming button inside its dialog — best effort, as with
    /// account deletion: the bridged sheet need not carry it, and the words
    /// are the fallback.
    static let securityRevokeOthersConfirm = "security.revokeOthers.confirm"

    /// Settings → About: the version, its build, and the platform's website.
    static let settingsVersion = "settings.version"
    static let settingsBuild = "settings.build"
    static let settingsWebsite = "settings.website"

    // The inbox's strip, beside its queues.
    /// The strip's envelope, which opens the mailbox.
    static let inboxEmail = "inbox.email"
    /// The strip's ☰, which lists every inbox.
    static let inboxEveryInbox = "inbox.everyInbox"
    static let everyInboxSheet = "inbox.everyInbox.sheet"
    static func everyInboxRow(_ key: String) -> String { "inbox.everyInbox.\(key)" }
}
