import Foundation
import XCTest
@testable import WebyarNative

/// Where a tapped notification goes, read from exactly the payloads
/// `server/services/push/dispatch.ts` sends — and the switches the server
/// reads before it sends one.
final class PushTargetTests: XCTestCase {

    // Where a tap goes

    func testACustomerMessageOpensItsConversation() {
        let target = PushTarget(userInfo: [
            "type": "new_message", "workspaceId": "w1", "conversationId": "c1", "messageId": "m1",
        ])
        XCTAssertEqual(target, .conversation(workspaceID: "w1", conversationID: "c1"))
    }

    func testAnAssignmentAHandoffAndANoteOpenTheirConversation() {
        for type in ["assigned", "handoff", "internal_note", "mention"] {
            let target = PushTarget(userInfo: ["type": type, "workspaceId": "w1", "conversationId": "c1"])
            XCTAssertEqual(target, .conversation(workspaceID: "w1", conversationID: "c1"), type)
        }
    }

    func testAColleaguesMessageOpensTheThreadWithWhoeverWrote() {
        let target = PushTarget(userInfo: [
            "type": "team_message", "workspaceId": "w1", "teamPeerId": "u2", "messageId": "t1",
        ])
        XCTAssertEqual(target, .colleague(workspaceID: "w1", peerID: "u2"))
    }

    func testAnEmailOpensItsThread() {
        let target = PushTarget(userInfo: [
            "type": "email", "workspaceId": "w1", "emailThreadId": "e1", "messageId": "em1",
        ])
        XCTAssertEqual(target, .email(workspaceID: "w1", threadID: "e1"))
    }

    func testTheSuperAdminDiagnosticGoesNowhere() {
        XCTAssertNil(PushTarget(userInfo: ["type": "test", "workspaceId": "w1", "conversationId": "c1"]))
    }

    func testAPayloadWithoutAWorkspaceOrADestinationGoesNowhere() {
        XCTAssertNil(PushTarget(userInfo: ["type": "new_message", "conversationId": "c1"]))
        XCTAssertNil(PushTarget(userInfo: ["type": "new_message", "workspaceId": "", "conversationId": "c1"]))
        XCTAssertNil(PushTarget(userInfo: ["type": "new_message", "workspaceId": "w1"]))
        XCTAssertNil(PushTarget(userInfo: [:]))
    }

    func testEachDestinationHasItsOwnKey() {
        let keys = Set([
            PushTarget.conversation(workspaceID: "w1", conversationID: "x").key,
            PushTarget.colleague(workspaceID: "w1", peerID: "x").key,
            PushTarget.email(workspaceID: "w1", threadID: "x").key,
            PushTarget.conversation(workspaceID: "w2", conversationID: "x").key,
        ])
        XCTAssertEqual(keys.count, 4)
        XCTAssertEqual(PushTarget.email(workspaceID: "w3", threadID: "x").workspaceID, "w3")
    }

    // The switches

    func testTheEventSwitchesTravelUnderTheServersNames() throws {
        var prefs = NotificationPrefs()
        prefs.pushTeamChat = false
        prefs.pushAssignments = false
        prefs.pushEmail = false
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(prefs)) as? [String: Any]
        XCTAssertEqual(json?["push_team_chat"] as? Bool, false)
        XCTAssertEqual(json?["push_assignments"] as? Bool, false)
        XCTAssertEqual(json?["push_email"] as? Bool, false)
    }

    func testAServerWithoutTheEventSwitchesReadsAsOn() throws {
        // A deployment one migration behind answers without them: on is what
        // its sender does, so on is what the screen says.
        let prefs = try JSONDecoder().decode(
            NotificationPrefs.self,
            from: Data(#"{"disable_all":false,"push_scope":"assigned"}"#.utf8)
        )
        XCTAssertTrue(prefs.pushTeamChat)
        XCTAssertTrue(prefs.pushAssignments)
        XCTAssertTrue(prefs.pushEmail)
        XCTAssertEqual(prefs.pushScope, .assigned)
    }

    func testSavedEventSwitchesAreRead() throws {
        let prefs = try JSONDecoder().decode(
            NotificationPrefs.self,
            from: Data(#"{"push_team_chat":false,"push_assignments":true,"push_email":false}"#.utf8)
        )
        XCTAssertFalse(prefs.pushTeamChat)
        XCTAssertTrue(prefs.pushAssignments)
        XCTAssertFalse(prefs.pushEmail)
    }
}
