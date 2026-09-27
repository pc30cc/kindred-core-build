import XCTest
@testable import Webyar

/// Team chat over the operator's own channel, the notifications it raises,
/// and the sections Super Admin switches off on every Mac.
@MainActor
final class TeamAndSectionsTests: XCTestCase {
    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private func colleagues(_ text: String) throws -> [Colleague] {
        try JSON.decoder().decode([Colleague].self, from: Data(text.utf8))
    }

    // MARK: Super Admin → macOS app → Behaviour

    func testSectionSwitchesAreReadFromThePlatform() throws {
        let off = MacAppConfig.parse(try json(#"{"features":{"contacts":false,"visitors":false,"callCenter":false,"webAnalytics":false,"storageSettings":false}}"#))
        XCTAssertEqual(off.sections, MacAppConfig.Sections(contacts: false, visitors: false, callCenter: false, webAnalytics: false, storageSettings: false))
        // A server from before the switches keeps every section as it was.
        XCTAssertEqual(MacAppConfig.parse(try json("{}")).sections, MacAppConfig.Sections())
    }

    func testASwitchedOffSectionIsHiddenWhateverThePlanSays() throws {
        let root = try json(#"{"modules":{"contacts":true,"visitor_tracking":true,"call_center":true,"web_analytics":true}}"#)
        let plan = WorkspacePlan.parse(root).with(role: "owner", aiAgent: nil, aiAuto: nil, callCenter: true)
        XCTAssertTrue(plan.contacts && plan.visitors && plan.callCenter && plan.webAnalytics)

        let limited = plan.limited(by: MacAppConfig.Sections(contacts: false, visitors: false, callCenter: false, webAnalytics: false))
        XCTAssertFalse(limited.contacts)
        XCTAssertFalse(limited.visitors)
        XCTAssertFalse(limited.callCenter)
        XCTAssertFalse(limited.webAnalytics)
    }

    func testASwitchNeverGrantsWhatThePlanLeavesOut() throws {
        let root = try json(#"{"modules":{"contacts":false,"visitor_tracking":false,"call_center":false,"web_analytics":false}}"#)
        let plan = WorkspacePlan.parse(root).with(role: "owner", aiAgent: nil, aiAuto: nil, callCenter: true)
            .limited(by: MacAppConfig.Sections())
        XCTAssertFalse(plan.contacts || plan.visitors || plan.callCenter || plan.webAnalytics)
    }

    // MARK: Team events

    func testTeamEventsAreReadFromTheOperatorsChannel() throws {
        let message = TeamEvent.parse(try json(#"{"type":"event","payload":{"kind":"team_message","workspace_id":"w","message_id":"m1","sender_id":"sara","recipient_id":"me"}}"#))
        XCTAssertEqual(message?.kind, TeamEvent.message)
        XCTAssertEqual(message?.messageId, "m1")
        XCTAssertEqual(message?.peer(me: "me"), "sara")
        // My own send, echoed to my other devices, is about the colleague I wrote to.
        let mine = TeamEvent.parse(try json(#"{"type":"event","payload":{"kind":"team_message","sender_id":"me","recipient_id":"ali"}}"#))
        XCTAssertEqual(mine?.peer(me: "me"), "ali")

        let read = TeamEvent.parse(try json(#"{"type":"event","payload":{"kind":"team_read","peer_id":"sara"}}"#))
        XCTAssertEqual(read?.kind, TeamEvent.read)
        XCTAssertEqual(read?.peer(me: "me"), "sara")

        // Anything else on the channel is not a team event.
        XCTAssertNil(TeamEvent.parse(try json(#"{"type":"event","payload":{"kind":"visitor.upsert"}}"#)))
        XCTAssertNil(TeamEvent.parse(try json(#"{"type":"message","payload":{"id":"x"}}"#)))
    }

    // MARK: Team notifications

    func testOnlyANewUnreadMessageFromAColleagueIsNotified() throws {
        var rules = TeamNotificationRules()
        // The first look sets the baseline: what was already there is not new.
        XCTAssertTrue(rules.fresh(try colleagues(#"[{"user_id":"sara","unread":2,"last_message":{"body":"old","created_at":"2026-09-27T08:00:00Z","outgoing":false}}]"#)).isEmpty)

        let fresh = rules.fresh(try colleagues(#"[{"user_id":"sara","unread":3,"last_message":{"body":"salam","created_at":"2026-09-27T08:05:00Z","outgoing":false}}]"#))
        XCTAssertEqual(fresh.map(\.userId), ["sara"])

        // Nothing newer: nothing to say again.
        XCTAssertTrue(rules.fresh(try colleagues(#"[{"user_id":"sara","unread":3,"last_message":{"body":"salam","created_at":"2026-09-27T08:05:00Z","outgoing":false}}]"#)).isEmpty)
        // My own reply is not a notification.
        XCTAssertTrue(rules.fresh(try colleagues(#"[{"user_id":"sara","unread":0,"last_message":{"body":"hi","created_at":"2026-09-27T08:06:00Z","outgoing":true}}]"#)).isEmpty)
        // Already read (on another device) by the time it is seen: not notified.
        XCTAssertTrue(rules.fresh(try colleagues(#"[{"user_id":"sara","unread":0,"last_message":{"body":"ok","created_at":"2026-09-27T08:07:00Z","outgoing":false}}]"#)).isEmpty)
    }
}
