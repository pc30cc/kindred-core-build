import XCTest

/// What the operator gets on a thread the AI is answering.
///
/// One field that says what it is for, a voice picker inside it, and a way
/// out of the arrangement in the header menu. Everything here is a menu or a
/// state that a screenshot cannot prove, which is why it is driven rather
/// than looked at.
final class AIThreadTests: UITestCase {

    // MARK: - The inbox switcher

    func testTheInboxSwitcherOffersTheAwaitingCustomerQueue() {
        launchToInbox()

        // Behind the screen's own title, which is where every queue that is
        // not a chip lives. A sheet since the menu could not be made to take
        // the operator's typeface — see `InboxSwitcherSheet`.
        let title = app.buttons[A11yID.inboxTitleMenu].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 10), "the inbox switcher was not reachable")
        title.tap()

        let row = app.buttons["انتظار مشتری"]
        XCTAssertTrue(
            row.waitForExistence(timeout: 5),
            "the awaiting-customer queue is missing from the inbox switcher"
        )

        // And the queues below it are still there, so a pass cannot mean
        // "the sheet now contains one row". They are below the fold at the
        // sheet's first height, and a `List` does not build rows nobody can
        // see — so this scrolls to them rather than asserting they are
        // already in the tree, which is what a menu would have let it do.
        let spam = app.buttons["هرزنامه"]
        var swipes = 0
        while !spam.exists && swipes < 4 {
            app.swipeUp()
            swipes += 1
        }
        XCTAssertTrue(spam.exists, "the spam queue went missing from the inbox switcher")
        XCTAssertTrue(app.buttons["حل‌شده"].exists, "the resolved queue went missing")
    }

    /// The whole reason the switcher stopped being a `Menu`.
    ///
    /// A row drawn by the app can be asked what it is; a `UIMenu`'s cannot,
    /// and its typeface was the system's whatever the app asked for. This
    /// cannot read a font, but it can prove the rows belong to the app —
    /// which is the thing that was not true before.
    func testTheSwitcherRowsBelongToTheApp() {
        launchToInbox()
        let title = app.buttons[A11yID.inboxTitleMenu].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        title.tap()

        let row = app.buttons["انتظار مشتری"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        // A sheet the app drew, so its rows sit inside the app's own window
        // and have a real frame. A menu's rows are in another one.
        XCTAssertTrue(row.frame.height > 0, "the switcher row has no frame of its own")
        // `.firstMatch`: the inbox behind the sheet carries the same word on
        // its own bar, and an ambiguous query throws rather than failing.
        XCTAssertTrue(
            app.navigationBars["صندوق"].firstMatch.waitForExistence(timeout: 3),
            "the switcher sheet has no title of its own"
        )
    }

    // MARK: - One field, and only what belongs in it

    /// The complaint this design answers, twice over.
    ///
    /// The first version stacked the console's guidance box above the reply
    /// box — two places to type on one phone screen. The second kept one
    /// field but put a row of mode chips above it. Neither comes back.
    func testTheComposerIsOneFieldWithNoBarAboveIt() {
        app.launchArguments += ["-WebyarScreen", "aiChat"]
        app.launch()

        let field = app.textFields[A11yID.composerField]
        XCTAssertTrue(field.waitForExistence(timeout: 25), "the composer never appeared")

        XCTAssertEqual(
            app.textFields.allElementsBoundByIndex.filter(\.exists).count, 1,
            "the chat screen grew a second place to type"
        )
        XCTAssertEqual(app.textViews.allElementsBoundByIndex.filter(\.exists).count, 0)

        // The three modes are gone from the phone: on an AI thread the
        // composer means one thing, and an operator who wants the other takes
        // the thread over.
        for label in ["پاسخ به‌عنوان اپراتور", "راهنمایی خصوصی", "همین حالا بگو"] {
            XCTAssertFalse(app.buttons[label].exists, "\(label) is still on screen")
        }
    }

    func testTheFieldAsksWhatTheVisitorShouldBeTold() {
        app.launchArguments += ["-WebyarScreen", "aiChat"]
        app.launch()

        let field = app.textFields[A11yID.composerField]
        XCTAssertTrue(field.waitForExistence(timeout: 25), "the composer never appeared")

        // This composer draws its own placeholder as a label behind the
        // field rather than handing it to `TextField`, so the field's value
        // is empty and the prompt is its own element.
        XCTAssertTrue(
            app.staticTexts["چه چیزی به بازدیدکننده گفته شود؟"].exists,
            "the field does not ask what the visitor should be told"
        )
        // And it asks only that: the three-line version that pushed the field
        // down the screen is gone.
        XCTAssertFalse(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "خلاصه بنویسید")
            ).firstMatch.exists,
            "the long placeholder came back"
        )
    }

    func testTheVoicePickerIsInsideTheFieldAndOffersBothVoices() {
        app.launchArguments += ["-WebyarScreen", "aiChat"]
        app.launch()

        let voice = app.buttons[A11yID.sayNowVoice]
        XCTAssertTrue(voice.waitForExistence(timeout: 25), "no voice picker")

        // Inside the field's pill, not in a bar above it: its centre has to
        // sit within the field's own frame.
        let field = app.textFields[A11yID.composerField]
        XCTAssertTrue(field.exists, "no composer field")
        XCTAssertTrue(
            abs(voice.frame.midY - field.frame.midY) < field.frame.height,
            "the voice picker is not on the field's row"
        )

        voice.tap()
        XCTAssertTrue(
            app.buttons["از زبان کارشناس"].waitForExistence(timeout: 5),
            "the specialist voice is missing"
        )
        XCTAssertTrue(app.buttons["از زبان هوش مصنوعی"].exists, "the AI voice is missing")
    }

    func testPickingAVoiceSticks() {
        app.launchArguments += ["-WebyarScreen", "aiChat"]
        app.launch()

        let voice = app.buttons[A11yID.sayNowVoice]
        XCTAssertTrue(voice.waitForExistence(timeout: 25), "no voice picker")
        // The value is what VoiceOver reads out, and the only way to tell the
        // two apart without looking at a glyph.
        XCTAssertEqual(voice.value as? String, "از زبان کارشناس")

        voice.tap()
        app.buttons["از زبان هوش مصنوعی"].tap()
        XCTAssertEqual(voice.value as? String, "از زبان هوش مصنوعی")
    }

    func testTheOneFieldTakesText() {
        app.launchArguments += ["-WebyarScreen", "aiChat"]
        app.launch()

        let field = app.textFields[A11yID.composerField]
        XCTAssertTrue(field.waitForExistence(timeout: 25), "no composer field")
        field.tap()
        field.typeText("سفارش فردا می‌رسد")
        XCTAssertEqual(field.value as? String, "سفارش فردا می‌رسد")
    }

    // MARK: - Take over

    func testTheChatMenuOffersTakeOverOnAnAIThread() {
        app.launchArguments += ["-WebyarScreen", "aiChat"]
        app.launch()

        let menu = app.buttons[A11yID.conversationMenu].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 25), "the chat header menu was not reachable")
        menu.tap()

        XCTAssertTrue(
            app.buttons["در دست گرفتن"].waitForExistence(timeout: 5),
            "take-over is missing from the chat header menu"
        )
        // The rows it was added above are still there.
        XCTAssertTrue(app.buttons["برچسب‌ها"].exists, "tags went missing from the chat menu")
    }
}
