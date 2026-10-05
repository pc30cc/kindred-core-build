import Foundation
import XCTest
@testable import Webyar

/// Team chat on the operator's own channel, the Inbox strip, and the Super
/// Admin switches behind both.
final class TeamRealtimeTests: XCTestCase {
    private func envelope(_ payload: [String: String]) throws -> JSONValue {
        let data = try JSONSerialization.data(withJSONObject: ["type": "event", "payload": payload])
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    // MARK: - Team events

    func testAMessageIsAboutTheOtherSide() throws {
        let event = try XCTUnwrap(TeamEvent.parse(envelope([
            "kind": "team_message", "workspace_id": "w1", "message_id": "m1",
            "sender_id": "u1", "recipient_id": "u2",
        ])))
        XCTAssertEqual(event.messageID, "m1")
        XCTAssertEqual(event.peer(me: "u1"), "u2", "our own message is about who it went to")
        XCTAssertEqual(event.peer(me: "u2"), "u1", "theirs is about who sent it")
    }

    func testAReadIsAboutWhoseMessagesWereRead() throws {
        let event = try XCTUnwrap(TeamEvent.parse(envelope(["kind": "team_read", "workspace_id": "w1", "peer_id": "u9"])))
        XCTAssertEqual(event.peer(me: "u1"), "u9")
    }

    func testAnythingElseIsNotATeamEvent() throws {
        XCTAssertNil(TeamEvent.parse(try envelope(["kind": "conversation_updated", "conversation_id": "c1"])))
        XCTAssertNil(TeamEvent.parse(try envelope([:])))
    }

    // MARK: - The strip

    func testTheStripIsTheQueuesThenColleagues() {
        XCTAssertEqual(
            InboxStripItem.strip(chips: [.open, .ai], colleagues: true),
            [.queue(.open), .queue(.ai), .colleagues]
        )
        XCTAssertEqual(InboxStripItem.strip(chips: [.open], colleagues: false), [.queue(.open)])
        XCTAssertEqual(Set([InboxStripItem.queue(.open), .queue(.ai), .colleagues].map(\.id)).count, 3)
    }

    func testTheAIQueueIsNamedInFullInPersian() {
        XCTAssertEqual(Str.filterAI(.fa), "هوش مصنوعی")
        XCTAssertEqual(Str.filterAI(.en), "AI")
    }

    // MARK: - Super Admin switches

    func testTheInboxSwitchesDefaultOnAndOnlyAnExplicitFalseHides() throws {
        let older = try JSONDecoder().decode(MobileAppConfig.self, from: Data(#"{"platform":"ios","showContacts":true}"#.utf8))
        XCTAssertTrue(older.showAIQueue, "a server without the key hides nothing")
        XCTAssertTrue(older.showColleagues)

        let off = try JSONDecoder().decode(
            MobileAppConfig.self,
            from: Data(#"{"platform":"ios","showAIQueue":false,"showColleagues":false}"#.utf8)
        )
        XCTAssertFalse(off.showAIQueue)
        XCTAssertFalse(off.showColleagues)
        XCTAssertTrue(off.showContacts)
        XCTAssertTrue(MobileAppConfig.defaults.showAIQueue && MobileAppConfig.defaults.showColleagues)
    }
}
