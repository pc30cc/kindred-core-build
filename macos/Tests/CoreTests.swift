import XCTest
@testable import Webyar

/// The Windows app's Core tests (windows-native/tests/Webyar.Core.Tests),
/// with the same expected values, so both desktop apps are held to one answer.
@MainActor
final class CoreTests: XCTestCase {
    private let fa = Strings(.fa)
    private let en = Strings(.en)

    // MARK: Avatars

    func testDjb2MatchesTheWeb() {
        XCTAssertEqual(AvatarArt.djb2("?"), 177562)
        XCTAssertEqual(AvatarArt.djb2("مجتبی"), 3836580610)
        XCTAssertEqual(AvatarArt.djb2("test@test.com"), 4038836234)
        XCTAssertEqual(AvatarArt.djb2("تستم"), 2066653683)
        XCTAssertEqual(AvatarArt.djb2("sara"), 2088338468)
    }

    func testPicksOsLogoThenGradientLikeTheWeb() {
        XCTAssertEqual(AvatarArt.make(name: nil, email: nil, os: "macOS").os, .apple)
        XCTAssertEqual(AvatarArt.make(name: "x", email: nil, os: "Windows 10").os, .windows)
        XCTAssertEqual(AvatarArt.make(name: nil, email: nil, os: "Android").os, .android)
        XCTAssertEqual(AvatarArt.make(name: nil, email: nil, os: "iOS").os, .apple)
        let test = AvatarArt.make(name: nil, email: "test@test.com", os: nil)
        XCTAssertEqual(test.from, Hsl(192, 78, 56))
        XCTAssertEqual(test.to, Hsl(220, 78, 44))
        XCTAssertEqual(test.initials, "TE")
    }

    func testInitialsFollowTheWeb() {
        XCTAssertEqual(AvatarArt.initialsOf(name: "مجتبی داودی", email: nil), "مد")
        XCTAssertEqual(AvatarArt.initialsOf(name: "مجتبی", email: nil), "مج")
        XCTAssertEqual(AvatarArt.initialsOf(name: nil, email: nil), "?")
        XCTAssertEqual(AvatarArt.initialsOf(name: "a", email: nil), "A")
    }

    func testHslToRgb() {
        let c = Hsl(217, 91, 60).rgb
        XCTAssertEqual(Int((c.r * 255).rounded()), 60)
        XCTAssertEqual(Int((c.g * 255).rounded()), 131)
        XCTAssertEqual(Int((c.b * 255).rounded()), 246)
    }

    // MARK: Display

    func testVisitorNames() {
        XCTAssertEqual(Display.contactName(ConversationContact(name: "تستم"), fa), "تستم")
        XCTAssertEqual(Display.contactName(ConversationContact(visitorCode: "4ZTK"), fa), "بازدیدکننده · \u{2068}4ZTK\u{2069}")
        XCTAssertEqual(Display.visitorName(name: nil, code: "4ZTK", fallbackId: nil, city: "Istanbul", region: nil, countryCode: "TR", fa),
                       "بازدیدکننده از \u{2068}Istanbul\u{2069} · \u{2068}4ZTK\u{2069}")
        XCTAssertEqual(Display.visitorName(name: "Visitor", code: "4ZTK", fallbackId: nil, city: "Karaj", region: "Tehran", countryCode: "IR", fa),
                       "بازدیدکننده از استان \u{2068}Tehran\u{2069} · \u{2068}4ZTK\u{2069}")
        XCTAssertEqual(Display.legacyCode("3f483f7d-91e2-425e-ba80-b11a814f2f36"), "WE0A")
    }

    func testInitialsForAvatars() {
        XCTAssertEqual(Display.initials("مجتبی داودی"), "مد")
        XCTAssertEqual(Display.initials("Visitor 4ZTK"), "V4")
        XCTAssertEqual(Display.initials("بازدیدکننده 4ZTK"), "ب")
    }

    func testPreviews() {
        XCTAssertEqual(Display.preview(MessagePreview(body: "", senderType: SenderType.agent, attachmentKind: "image"), en), "You sent a photo")
        XCTAssertEqual(Display.preview(MessagePreview(senderType: SenderType.contact, senderName: "Sara", attachmentKind: "image"), en), "Sara sent a photo")
        XCTAssertEqual(Display.preview(MessagePreview(body: "a\n b"), en), "a b")
    }

    func testDurationsAndDigits() {
        XCTAssertEqual(Display.duration(3729, .fa), "۰۱:۰۲:۰۹")
        XCTAssertEqual(Display.duration(245, .en), "04:05")
        XCTAssertEqual(Digits.localize("12:05", .fa), "۱۲:۰۵")
    }

    func testPersianDates() {
        var c = DateComponents()
        c.year = 2026; c.month = 8; c.day = 1; c.hour = 12
        let date = Calendar(identifier: .gregorian).date(from: c)!
        XCTAssertEqual(Display.shortDate(date, .fa), "۱۴۰۵/۰۵/۱۰")
    }

    func testSystemText() {
        XCTAssertEqual(SystemText.of(.object(["kind": .string("routing_agent_joined"), "agent_name": .string("Sara")]), en), "Sara joined the conversation")
    }

    func testErrorText() {
        XCTAssertEqual(ErrorText.of(ApiError(failure: .server, status: 404, serverMessage: "nope"), en), "nope")
        XCTAssertEqual(ErrorText.of(ApiError(failure: .transport), en), en["offlineBody"])
    }

    // MARK: Desktop config

    private func config(_ json: String) -> DesktopConfig {
        DesktopConfig.parse(try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
    }

    func testReadsTheAdminSettings() {
        let c = config("""
        { "update": { "feedUrl": "https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download/", "channel": "beta", "autoUpdate": false, "checkIntervalMinutes": 60 },
          "realtime": { "enabled": false }, "polling": { "intervalSeconds": 20, "withRealtimeSeconds": 300 }, "features": { "calls": false } }
        """)
        XCTAssertEqual(c.update.feedUrl, "https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download")
        XCTAssertEqual(c.update.channel, "beta")
        XCTAssertFalse(c.update.autoUpdate)
        XCTAssertEqual(c.update.checkIntervalMinutes, 60)
        XCTAssertFalse(c.realtimeEnabled)
        XCTAssertEqual(c.pollIntervalSeconds, 20)
        XCTAssertEqual(c.pollWithRealtimeSeconds, 300)
        XCTAssertFalse(c.callsEnabled)
    }

    func testBadValuesFallBackOneByOne() {
        let c = config(#"{ "update": { "feedUrl": "http://insecure.example", "channel": "nightly", "checkIntervalMinutes": 1 }, "polling": { "intervalSeconds": "x" } }"#)
        XCTAssertNil(c.update.feedUrl)
        XCTAssertEqual(c.update.channel, "stable")
        XCTAssertEqual(c.update.checkIntervalMinutes, 15)
        XCTAssertEqual(c.pollIntervalSeconds, DesktopConfig.defaults.pollIntervalSeconds)
        XCTAssertTrue(c.realtimeEnabled)
        XCTAssertEqual(config("{}"), DesktopConfig.defaults)
    }

    func testMinimumVersion() {
        var u = DesktopConfig.defaults.update
        u.minimumSupportedVersion = "1.2.0"
        XCTAssertTrue(u.isBelowMinimum("1.1.9"))
        XCTAssertFalse(u.isBelowMinimum("1.2.0"))
        XCTAssertFalse(u.isBelowMinimum("2.0.0-beta.1"))
    }

    // MARK: Plan

    func testPlanRules() throws {
        let root = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"plan":{"name":"Pro"},"modules":{"contacts":false,"call_center":{"value":true}},"features":{"widget_emoji":false}}"#.utf8))
        let plan = WorkspacePlan.parse(root).with(role: "admin", aiAgent: true, aiAuto: false, callCenter: nil)
        XCTAssertEqual(plan.planName, "Pro")
        XCTAssertFalse(plan.contacts)
        XCTAssertTrue(plan.callCenter)
        XCTAssertFalse(plan.emoji)
        XCTAssertTrue(plan.attachments)
        XCTAssertTrue(plan.isAdmin)
        XCTAssertFalse(plan.aiQueue(automated: 0))
        XCTAssertTrue(plan.aiQueue(automated: 2))
        XCTAssertFalse(WorkspacePlan.loading.visitors)
        XCTAssertTrue(WorkspacePlan.failed.visitors)
    }

    // MARK: Realtime

    func testParsesCentrifugoFrames() {
        let frames = CentrifugoProtocol.parse("""
        {}
        {"id":1,"connect":{"client":"x"}}
        {"push":{"channel":"ws:w1:inbox","pub":{"data":{"type":"message","payload":{"conversation_id":"c1","id":"m1","sender_type":"contact"}}}}}
        {"push":{"disconnect":{"code":3000}}}
        """)
        XCTAssertEqual(frames.count, 4)
        XCTAssertEqual(frames[0], .ping)
        XCTAssertEqual(frames[1], .reply(id: 1, error: nil))
        guard case .publication(_, let data) = frames[2], let event = CentrifugoProtocol.event(data) else { return XCTFail("publication") }
        XCTAssertTrue(event.isVisitorMessage)
        XCTAssertEqual(event.conversationId, "c1")
        XCTAssertEqual(frames[3], .disconnect)
        XCTAssertEqual(CentrifugoProtocol.parse(#"{"id":2,"error":{"code":103,"message":"permission denied"}}"#).first, .reply(id: 2, error: "permission denied"))
    }

    // MARK: Decoding

    func testDecodesServerShapes() throws {
        let json = #"""
        {"conversations":[{"id":"c1","workspace_id":"w1","status":"open","unread_count":"3","created_at":"2025-01-02 03:04:05.123456+00",
          "metadata":{"ai_state":"ai_managed","channel":"telegram"},"last_message":{"body":"hi","created_at":"2025-01-02T03:04:05Z","sender_type":"contact"}}]}
        """#
        struct R: Decodable { var conversations: [Conversation] }
        let c = try JSON.decoder().decode(R.self, from: Data(json.utf8)).conversations[0]
        XCTAssertEqual(c.unreadCount, 3)
        XCTAssertTrue(c.isAiManaged)
        XCTAssertEqual(c.channelKey, "telegram")
        XCTAssertNotNil(c.createdAt)
        XCTAssertNotNil(JSON.parseDate("2025-01-02T03:04:05.123456+00:00"))
    }

    func testNotificationRulesBaselineThenFresh() {
        var rules = NotificationRules()
        func conv(_ id: String, _ at: TimeInterval, _ sender: String = SenderType.contact) -> Conversation {
            var c = try! JSON.decoder().decode(Conversation.self, from: Data(#"{"id":"\#(id)","workspace_id":"w","status":"open"}"#.utf8))
            c.lastMessage = MessagePreview(body: "x", createdAt: Date(timeIntervalSince1970: at), senderType: sender)
            return c
        }
        XCTAssertTrue(rules.fresh([conv("a", 1)]).isEmpty)
        XCTAssertEqual(rules.fresh([conv("a", 2), conv("b", 5, SenderType.agent)]).map(\.id), ["a"])
        XCTAssertTrue(rules.fresh([conv("a", 2)]).isEmpty)
    }
}
