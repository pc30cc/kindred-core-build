import Foundation
import XCTest
@testable import Webyar

/// Online support's wire shapes and the pure rules around them: what
/// `/api/platform-support` answers (docs/PLATFORM_SUPPORT.md), how the
/// transcript is laid out, the team's hours, and where a support push goes.
final class SupportModelsTests: XCTestCase {

    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = DateParsing.parse(raw) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: raw))
            }
            return date
        }
        return decoder
    }

    private func date(_ iso: String) -> Date { DateParsing.parse(iso)! }

    // MARK: Decoding

    func testTheStatusReadsEverythingTheEndpointSends() throws {
        let json = """
        {"enabled":true,"available":true,"online":false,"teamName":"Webyar Support","teamAvatar":"https://cdn/x.png",
         "unread":3,"hours":{"timezone":"Asia/Tehran","weekly":{"sat":[{"from":"09:00","to":"17:00"}]}},
         "nextOpenAt":"2026-10-03T05:30:00.000Z"}
        """
        let status = try decoder().decode(SupportStatus.self, from: Data(json.utf8))
        XCTAssertTrue(status.shown)
        XCTAssertFalse(status.online)
        XCTAssertEqual(status.teamName, "Webyar Support")
        XCTAssertEqual(status.teamAvatar, "https://cdn/x.png")
        XCTAssertEqual(status.unread, 3)
        XCTAssertEqual(status.hours?.timezone, "Asia/Tehran")
        XCTAssertEqual(status.hours?.weekly["sat"], [SupportInterval(from: "09:00", to: "17:00")])
        XCTAssertEqual(status.nextOpenAt, date("2026-10-03T05:30:00.000Z"))
    }

    func testAStatusWithLittleInItOffersNothing() throws {
        let status = try decoder().decode(SupportStatus.self, from: Data(#"{"enabled":true,"unread":"x","teamName":"  "}"#.utf8))
        XCTAssertFalse(status.shown, "available is missing")
        XCTAssertEqual(status.unread, 0)
        XCTAssertNil(status.teamName, "a blank name is no name")
        XCTAssertNil(status.hours)
    }

    func testTheHistoryKeepsWhatDecodesAndDropsWhatDoesNot() throws {
        let json = """
        {"conversations":[{"id":"c1","status":"resolved","createdAt":"2026-09-01T10:00:00Z","endedAt":"2026-09-01T11:00:00Z",
           "rating":{"score":4,"comment":"ok","ratedAt":"2026-09-02T10:00:00Z"},"canRate":false},{"status":"open"}],
         "items":[{"id":"i1","conversationId":"c1","kind":"message","author":"me","body":"Hi","createdAt":"2026-09-01T10:00:00Z",
           "clientMessageId":"cm-1","attachments":[{"id":"a1","fileName":"shot.png","mimeType":"image/png","sizeBytes":2048,"kind":"image"}]},
          {"id":"i2","conversationId":"c1","kind":"joined","author":"team","body":"","senderName":"Neda"},
          {"conversationId":"c1"}],
         "activeConversationId":null}
        """
        let history = try decoder().decode(SupportHistory.self, from: Data(json.utf8))
        XCTAssertEqual(history.conversations.map(\.id), ["c1"], "a conversation without an id is dropped, not fatal")
        XCTAssertEqual(history.items.map(\.id), ["i1", "i2"])
        XCTAssertNil(history.activeConversationID)
        let conversation = history.conversations[0]
        XCTAssertTrue(conversation.ended)
        XCTAssertEqual(conversation.rating?.score, 4)
        XCTAssertEqual(history.items[0].clientMessageID, "cm-1")
        XCTAssertTrue(history.items[1].isJoin)
        XCTAssertTrue(history.items[1].fromTeam)

        let file = history.items[0].attachments[0].messageAttachment
        XCTAssertEqual(file.origin, .support, "fetched from the support endpoint, never the workspace's")
        XCTAssertEqual(file.resolvedKind, .image)
        XCTAssertEqual(file.sizeBytes, 2048)
    }

    func testAWorkspaceAttachmentStillComesFromTheWorkspace() throws {
        let json = #"{"id":"a1","file_name":"x.pdf","mime_type":"application/pdf","size_bytes":10,"kind":"file"}"#
        let attachment = try JSONDecoder().decode(MessageAttachment.self, from: Data(json.utf8))
        XCTAssertEqual(attachment.origin, .conversation)
    }

    func testTheIPhoneSwitchForOnlineSupport() throws {
        let off = try JSONDecoder().decode(MobileAppConfig.self, from: Data(#"{"showSupport":false}"#.utf8))
        XCTAssertFalse(off.showSupport)
        XCTAssertTrue(off.showStorage)
        let older = try JSONDecoder().decode(MobileAppConfig.self, from: Data(#"{"showContacts":true}"#.utf8))
        XCTAssertTrue(older.showSupport, "a server that never heard of the switch hides nothing")
    }

    // MARK: Signals and pushes

    func testASupportEventOnTheOperatorsChannelIsASignal() {
        let envelope = JSONValue.object([
            "type": .string("event"),
            "payload": .object([
                "kind": .string("support_update"), "workspace_id": .string("w1"), "thread_id": .string("c9"),
            ]),
        ])
        XCTAssertEqual(SupportSignal.parse(envelope), SupportSignal(kind: "support_update", threadID: "c9"))
        let team = JSONValue.object(["payload": .object(["kind": .string("team_message")])])
        XCTAssertNil(SupportSignal.parse(team))
    }

    func testASupportReplyOpensTheSupportChat() {
        let target = PushTarget(userInfo: [
            "type": "support_reply", "workspaceId": "w1", "threadId": "c9", "messageId": "m1",
        ])
        XCTAssertEqual(target, .support(workspaceID: "w1", threadID: "c9"))
        XCTAssertEqual(target?.isSupport, true)
        XCTAssertNil(PushTarget(userInfo: ["type": "support_reply", "workspaceId": "w1"]), "no thread, nowhere to go")
        XCTAssertEqual(PushTarget(userInfo: ["type": "email_message", "workspaceId": "w1", "threadId": "e1"])?.isSupport, false)
    }

    // MARK: The transcript

    private func conversation(_ id: String, _ status: String = SupportConversation.open, created: String, ended: String? = nil,
                              canRate: Bool = false, rating: SupportRating? = nil) -> SupportConversation {
        SupportConversation(id: id, status: status, createdAt: date(created), endedAt: ended.map(date), rating: rating, canRate: canRate)
    }

    private func item(_ id: String, in conversation: String, team: Bool = false, join: Bool = false, body: String = "x",
                      name: String? = nil, at: String, client: String? = nil) -> SupportItem {
        SupportItem(
            id: id, conversationID: conversation,
            kind: join ? SupportItem.kindJoined : SupportItem.kindMessage,
            author: team || join ? SupportItem.authorTeam : SupportItem.authorMe,
            body: join ? "" : body, senderName: name, createdAt: date(at), clientMessageID: client
        )
    }

    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func kinds(_ rows: [SupportRow]) -> [String] {
        rows.map { row in
            switch row.kind {
            case .newConversation: "new"
            case .joined: "joined"
            case .bubble(let bubble): bubble.pending == nil ? (bubble.mine ? "me" : "team") : "pending"
            case .ended: "ended"
            case .rating: "rating"
            }
        }
    }

    func testAnEndedConversationClosesWithItsLineAndItsStars() {
        let rows = supportTimeline(
            conversations: [conversation("c1", SupportConversation.resolved, created: "2026-09-01T10:00:00Z",
                                         ended: "2026-09-01T11:00:00Z", canRate: true)],
            items: [
                item("i1", in: "c1", at: "2026-09-01T10:00:00Z"),
                item("i2", in: "c1", join: true, name: "Neda", at: "2026-09-01T10:01:00Z"),
                item("i3", in: "c1", team: true, name: "Neda", at: "2026-09-01T10:02:00Z"),
                item("i4", in: "c1", team: true, body: "  ", at: "2026-09-01T10:03:00Z"),
                item("i5", in: "elsewhere", at: "2026-09-01T10:04:00Z"),
            ],
            pending: [],
            calendar: utc
        )
        XCTAssertEqual(kinds(rows), ["me", "joined", "team", "ended", "rating"], "an empty message and a stray item are left out")
    }

    func testWhatIsOnItsWayToANewConversationSitsUnderItsOwnLine() {
        let ended = conversation("c1", SupportConversation.closed, created: "2026-09-01T10:00:00Z", ended: "2026-09-01T11:00:00Z")
        let rows = supportTimeline(
            conversations: [ended],
            items: [item("i1", in: "c1", at: "2026-09-01T10:00:00Z", client: "k1")],
            pending: [
                PendingSupportItem(clientMessageID: "k1", body: "landed", createdAt: date("2026-09-01T10:00:00Z"), conversationID: "c1"),
                PendingSupportItem(clientMessageID: "k2", body: "next", createdAt: date("2026-09-02T09:00:00Z"), conversationID: nil),
            ],
            calendar: utc
        )
        XCTAssertEqual(kinds(rows), ["me", "ended", "new", "pending"], "the delivered one shows once, the server's copy")
        XCTAssertEqual(rows.first?.id, "c-k1", "keyed by its client id, as the pending bubble was")
        XCTAssertEqual(rows.last?.id, "c-k2")
        if case .bubble(let bubble) = rows.last?.kind {
            XCTAssertNil(bubble.dayHeader, "the new-conversation line already carries the date")
        } else {
            XCTFail("expected a bubble")
        }
    }

    func testRunsBreakOnTheSenderAndTheDay() {
        let rows = supportTimeline(
            conversations: [conversation("c1", created: "2026-09-01T10:00:00Z")],
            items: [
                item("i1", in: "c1", at: "2026-09-01T10:00:00Z"),
                item("i2", in: "c1", at: "2026-09-01T10:01:00Z"),
                item("i3", in: "c1", team: true, name: "Ali", at: "2026-09-01T10:02:00Z"),
                item("i4", in: "c1", team: true, name: "Neda", at: "2026-09-01T10:03:00Z"),
                item("i5", in: "c1", team: true, name: "Neda", at: "2026-09-02T10:03:00Z"),
            ],
            pending: [],
            calendar: utc
        )
        let bubbles = rows.compactMap { row -> SupportBubble? in
            if case .bubble(let bubble) = row.kind { return bubble }
            return nil
        }
        XCTAssertEqual(bubbles.map(\.startsRun), [true, false, true, true, true])
        XCTAssertEqual(bubbles.map(\.endsRun), [false, true, true, true, true])
        XCTAssertNotNil(bubbles[0].dayHeader)
        XCTAssertNil(bubbles[1].dayHeader)
        XCTAssertNotNil(bubbles[4].dayHeader, "a new day")
    }

    func testARowTheServerSentTwiceKeepsAUniqueID() {
        let rows = supportTimeline(
            conversations: [conversation("c1", created: "2026-09-01T10:00:00Z")],
            items: [item("i1", in: "c1", at: "2026-09-01T10:00:00Z"), item("i1", in: "c1", at: "2026-09-01T10:00:00Z")],
            pending: [],
            calendar: utc
        )
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count)
    }

    func testClosedConversationsAreTheNewestEndFirstWithTheirFirstWords() {
        let list = closedSupportConversations([
            conversation("c1", SupportConversation.resolved, created: "2026-09-01T10:00:00Z", ended: "2026-09-01T11:00:00Z"),
            conversation("c2", created: "2026-09-03T10:00:00Z"),
            conversation("c3", SupportConversation.closed, created: "2026-08-01T10:00:00Z", ended: "2026-09-05T11:00:00Z"),
        ])
        XCTAssertEqual(list.map(\.id), ["c3", "c1"], "the open one is not closed")

        let items = [
            item("i0", in: "c1", join: true, name: "Neda", at: "2026-09-01T09:59:00Z"),
            item("i1", in: "c1", team: true, body: "Hello from the team", at: "2026-09-01T10:00:00Z"),
            item("i2", in: "c1", body: "  My question\nsecond line", at: "2026-09-01T10:01:00Z"),
        ]
        XCTAssertEqual(supportConversationPreview("c1", items: items), "My question")
        XCTAssertEqual(supportConversationPreview("c1", items: [items[1]]), "Hello from the team")
        var file = item("i3", in: "c2", body: "", at: "2026-09-03T10:00:00Z")
        file.attachments = [SupportAttachment(id: "a1", fileName: "invoice.pdf", mimeType: "application/pdf")]
        XCTAssertEqual(supportConversationPreview("c2", items: [file]), "invoice.pdf")
        XCTAssertNil(supportConversationPreview("c9", items: items))
    }

    // MARK: Hours

    private let workweek = SupportHours(timezone: "Asia/Tehran", weekly: [
        "sat": [SupportInterval(from: "09:00", to: "17:00")],
        "sun": [SupportInterval(from: "09:00", to: "17:00")],
        "mon": [SupportInterval(from: "09:00", to: "17:00")],
        "tue": [SupportInterval(from: "09:00", to: "17:00")],
        "wed": [SupportInterval(from: "09:00", to: "17:00")],
        "thu": [SupportInterval(from: "09:00", to: "13:00")],
    ])

    func testDaysInARowWithTheSameHoursAreOneLine() {
        XCTAssertEqual(SupportHoursText.lines(workweek, language: .en), [
            "Saturday–Wednesday: 9:00–17:00",
            "Thursday: 9:00–13:00",
            "Friday: closed",
        ])
        XCTAssertEqual(SupportHoursText.lines(workweek, language: .fa), [
            "شنبه تا چهارشنبه ۹:۰۰ تا ۱۷:۰۰",
            "پنجشنبه ۹:۰۰ تا ۱۳:۰۰",
            "جمعه تعطیل",
        ])
    }

    func testAWeekWithNoOpeningSaysNothing() {
        XCTAssertEqual(SupportHoursText.lines(SupportHours(timezone: "UTC", weekly: ["sat": []]), language: .en), [])
    }

    func testSplitDaysListEveryOpening() {
        let split = SupportHours(timezone: "UTC", weekly: Dictionary(uniqueKeysWithValues: SupportHoursText.week.map {
            ($0, [SupportInterval(from: "14:00", to: "18:00"), SupportInterval(from: "09:00", to: "12:00")])
        }))
        XCTAssertEqual(SupportHoursText.lines(split, language: .en), ["Saturday–Friday: 9:00–12:00, 14:00–18:00"])
    }

    func testTheTeamsClockIsNamedOnlyWhenItDiffers() {
        let tehran = TimeZone(identifier: "Asia/Tehran")!
        XCTAssertFalse(SupportHoursText.zoneDiffers("Asia/Tehran", device: tehran))
        XCTAssertTrue(SupportHoursText.zoneDiffers("Asia/Tehran", device: TimeZone(identifier: "Europe/Berlin")!))
        XCTAssertTrue(SupportHoursText.zoneDiffers("Mars/Olympus", device: tehran), "an unknown id is named as it is")
        XCTAssertFalse(SupportHoursText.zoneDiffers("", device: tehran))
    }

    func testOpeningTimesReadAsADoorSign() {
        XCTAssertEqual(Format.openingTime("09:00", language: .en), "9:00")
        XCTAssertEqual(Format.openingTime("17:30", language: .fa), "۱۷:۳۰")
        XCTAssertEqual(Format.openingTime("late", language: .en), "late")
    }

    // MARK: Limits and errors

    func testOnlyTheSixTypesTheEndpointTakes() {
        XCTAssertEqual(SupportLimits.canonicalType("IMAGE/JPG"), "image/jpeg")
        XCTAssertEqual(SupportLimits.canonicalType("text/plain; charset=utf-8"), "text/plain")
        XCTAssertEqual(SupportLimits.canonicalType("application/pdf"), "application/pdf")
        XCTAssertNil(SupportLimits.canonicalType("video/mp4"))
        XCTAssertNil(SupportLimits.canonicalType("image/heic"))
    }

    func testTheEndpointsCodesReadAsSentences() {
        func text(_ status: Int, _ code: String) -> String {
            supportErrorText(APIError.server(status: status, message: code), language: .en)
        }
        XCTAssertEqual(text(409, "conversation_ended"), SupportStr.conversationEnded(.en))
        XCTAssertEqual(text(429, "rate_limited"), SupportStr.rateLimited(.en))
        XCTAssertEqual(text(413, "file_too_large"), SupportStr.fileTooLarge(.en))
        XCTAssertEqual(text(404, "support_disabled"), SupportStr.unavailable(.en))
        XCTAssertEqual(text(404, "conversation_not_found"), Str.errorNotFound(.en), "never the bare code")
        XCTAssertEqual(supportErrorText(APIError.transport, language: .fa), Str.offlineBody(.fa))
    }
}
