import XCTest
@testable import Webyar

/// A visitor call is never joined beside a colleague call
/// (docs/operations/TEAM_CALLS.md, "iOS"): the visitor answered while the app
/// slept, a colleague's ring woke it and took the audio, and the visitor
/// screen's next poll finds the invitation joined. The call ends, failed, and
/// the server is told — no token is asked for, no room is joined.
private actor JoinedInvitationAPI: TestAPIBase {
    private(set) var tokenAsks = 0
    private(set) var hungUp: [String] = []

    func invitation(id: String) async throws -> CallInvitation {
        CallInvitation(
            id: id, status: "joined", channel: "audio", conversationId: "c1",
            callSessionId: "session-1", expiresAt: Date().addingTimeInterval(-10)
        )
    }

    func callToken(callSessionID: String, displayName: String?) async throws -> CallToken {
        tokenAsks += 1
        throw APIError.transport
    }

    func hangUp(callSessionID: String) async throws {
        hungUp.append(callSessionID)
    }
}

@MainActor
final class VisitorCallJoinTests: XCTestCase {
    private func session(api: JoinedInvitationAPI, colleagueCallOn: Bool) -> CallSession {
        CallSession(
            invitation: CallInvitation(
                id: "inv-1", status: "pending", channel: "audio", conversationId: "c1",
                callSessionId: nil, expiresAt: Date().addingTimeInterval(-10)
            ),
            contactName: "Visitor",
            contactAvatarURL: nil,
            api: api,
            colleagueCallOn: { colleagueCallOn }
        )
    }

    private func waitUntilOver(_ session: CallSession) async {
        for _ in 0..<200 where session.phase.isLive {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func testAVisitorWhoAnsweredDuringAColleagueCallIsNotJoined() async {
        let api = JoinedInvitationAPI()
        let call = session(api: api, colleagueCallOn: true)
        call.start()
        await waitUntilOver(call)

        XCTAssertEqual(call.phase, .ended(.failed("colleague_call")))
        let asks = await api.tokenAsks
        XCTAssertEqual(asks, 0, "no token, no room")
        let hungUp = await api.hungUp
        XCTAssertEqual(hungUp, ["session-1"], "the server is told")
    }

    func testWithoutAColleagueCallTheJoinGoesAhead() async {
        let api = JoinedInvitationAPI()
        let call = session(api: api, colleagueCallOn: false)
        call.start()
        await waitUntilOver(call)

        let asks = await api.tokenAsks
        XCTAssertEqual(asks, 1, "the join asked for its token")
    }
}
