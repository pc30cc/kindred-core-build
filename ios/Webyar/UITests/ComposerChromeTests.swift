import XCTest

/// The composer is one object, and it is that same object on every screen.
///
/// Three of them drifted apart once already — three corner radii, three
/// paddings, glyphs at 15, 17 and 19 points — and the drift was invisible in
/// review because no two of them are ever on screen together. An operator
/// moves between a visitor chat, a colleague thread and a mail reply inside
/// one conversation, so they see it even though a reviewer does not.
///
/// These are frame comparisons rather than screenshots: what went wrong was
/// arithmetic, not appearance, and arithmetic is the thing a screenshot is
/// worst at catching.
final class ComposerChromeTests: UITestCase {

    /// The arguments `setUp` built, before any screen is named.
    private var base: [String] = []

    override func setUp() {
        super.setUp()
        base = app.launchArguments
    }

    // MARK: - One line

    /// Everything inside the pill sits on one line.
    ///
    /// The send button used to lay itself out at Apple's 44pt minimum while
    /// the glyphs beside it were 36. The row bottom-aligns, so the arrow rode
    /// four points above the microphone it sat next to, and the pill grew to
    /// hold a box nobody could see. The 44 is still there; it is given to the
    /// hit test rather than to the layout.
    ///
    /// The tolerance is a point, not zero: these are real frames off a
    /// rendered screen, and a half-point of rounding is not a regression.
    func testEveryControlInTheComposerSitsOnOneLine() {
        for screen in ["chat", "colleagueThread"] {
            launch(screen)

            let send = waitForSend(screen)
            let attach = app.buttons[A11yID.attachButton]
            XCTAssertTrue(
                attach.waitForExistence(timeout: 10),
                "\(screen): the paperclip never appeared"
            )

            XCTAssertEqual(
                send.frame.midY, attach.frame.midY, accuracy: 1,
                "\(screen): the send button and the paperclip are on different lines"
            )

            // The bolt is a visitor-chat control; a colleague thread has no
            // saved replies, so its absence there is the point of another
            // test rather than a failure here.
            let shortcuts = app.buttons[A11yID.shortcutsButton]
            if shortcuts.exists {
                XCTAssertEqual(
                    send.frame.midY, shortcuts.frame.midY, accuracy: 1,
                    "\(screen): the send button and the saved replies are on different lines"
                )
            }

            app.terminate()
        }
    }

    // MARK: - One size

    /// And it is the same size wherever it is.
    ///
    /// Four send buttons used to exist at 34, 38, 34 and 34 points with
    /// arrows at four weights. One component replaced them; this is what
    /// stops a fifth being written.
    func testTheSendButtonIsTheSameSizeOnEveryThread() {
        launch("chat")
        let chat = waitForSend("chat").frame.size
        app.terminate()

        launch("colleagueThread")
        let team = waitForSend("colleagueThread").frame.size
        app.terminate()

        XCTAssertEqual(
            chat.width, team.width, accuracy: 1,
            "the send button is a different width on a colleague thread"
        )
        XCTAssertEqual(
            chat.height, team.height, accuracy: 1,
            "the send button is a different height on a colleague thread"
        )
    }

    // MARK: -

    private func launch(_ screen: String) {
        app.launchArguments = base + ["-WebyarScreen", screen]
        app.launch()
    }

    /// The send button, once the screen has stopped moving.
    ///
    /// A thread opens scrolled to its newest message and is still settling
    /// afterwards; a frame read during that reads the composer on its way up.
    /// Re-queried after the wait rather than held across it, because an
    /// element bound before a re-render is bound to a stale snapshot.
    private func waitForSend(_ screen: String) -> XCUIElement {
        let send = app.buttons[A11yID.composerSend]
        XCTAssertTrue(
            send.waitForExistence(timeout: 25),
            "\(screen): the composer never appeared"
        )
        waitUntilStill {
            let now = app.buttons[A11yID.composerSend]
            return now.exists ? now.frame : nil
        }
        return app.buttons[A11yID.composerSend]
    }
}
