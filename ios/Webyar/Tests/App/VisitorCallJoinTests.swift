import XCTest
@testable import Webyar

/// A visitor call is never joined beside a colleague call
/// (docs/operations/TEAM_CALLS.md, "iOS"). Three moments it is caught at:
/// - the offer is still out: withdrawn (`cancelInvitation`) before the
///   visitor can answer it;
/// - the visitor answered while the app slept, and a colleague's ring then
///   took the audio: the joined call ends, failed, the server told, no token
///   asked for;
/// - the colleague call began while the token was on its way: the same,
///   after the token, before any room.
private actor ScriptedAPI: TestAPIBase {
    let joined: Bool
    let colleague: ColleagueSwitch
    private(set) var tokenAsks = 0
    private(set) var hungUp: [String] = []
    private(set) var cancelled: [String] = []

    init(joined: Bool, colleague: ColleagueSwitch) {
        self.joined = joined
        self.colleague = colleague
    }

    func invitation(id: String) async throws -> CallInvitation {
        CallInvitation(
            id: id, status: joined ? "joined" : "pending", channel: "audio", conversationId: "c1",
            callSessionId: joined ? "session-1" : nil, expiresAt: Date().addingTimeInterval(-10)
        )
    }

    func callToken(callSessionID: String, displayName: String?) async throws -> CallToken {
        tokenAsks += 1
        colleague.onAfterToken()
        return CallToken(
            token: "t", provider: "livekit", wsURL: nil, rtcURL: nil,
            turn: nil, icePolicy: nil, warnings: nil
        )
    }

    func hangUp(callSessionID: String) async throws { hungUp.append(callSessionID) }
    func cancelInvitation(id: String) async throws { cancelled.append(id) }
}

/// When the colleague call is on, as the session reads it.
private final class ColleagueSwitch: @unchecked Sendable {
    enum Mode { case always, never, fromSecondRead, afterToken }

    private let lock = NSLock()
    private let mode: Mode
    private var reads = 0
    private var tokenGiven = false

    init(_ mode: Mode) { self.mode = mode }

    func read() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        reads += 1
        switch mode {
        case .always: return true
        case .never: return false
        case .fromSecondRead: return reads > 1
        case .afterToken: return tokenGiven
        }
    }

    func onAfterToken() {
        lock.lock()
        tokenGiven = true
        lock.unlock()
    }
}

@MainActor
final class VisitorCallJoinTests: XCTestCase {
    private func run(joined: Bool, _ mode: ColleagueSwitch.Mode) async -> (CallSession, ScriptedAPI) {
        let colleague = ColleagueSwitch(mode)
        let api = ScriptedAPI(joined: joined, colleague: colleague)
        let call = CallSession(
            invitation: CallInvitation(
                id: "inv-1", status: "pending", channel: "audio", conversationId: "c1",
                callSessionId: nil, expiresAt: Date().addingTimeInterval(-10)
            ),
            contactName: "Visitor",
            contactAvatarURL: nil,
            api: api,
            colleagueCallOn: { colleague.read() }
        )
        call.start()
        for _ in 0..<300 where call.phase.isLive {
            if case .connecting = call.phase, mode == .never { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return (call, api)
    }

    func testAnOfferStillOutIsWithdrawnDuringAColleagueCall() async {
        let (call, api) = await run(joined: false, .always)
        XCTAssertEqual(call.phase, .ended(.failed(CallSession.colleagueCallReason)))
        let cancelled = await api.cancelled
        XCTAssertEqual(cancelled, ["inv-1"], "the visitor is never asked")
        let asks = await api.tokenAsks
        XCTAssertEqual(asks, 0)
    }

    func testAVisitorWhoAnsweredWhileTheAppSleptIsNotJoined() async {
        let (call, api) = await run(joined: true, .fromSecondRead)
        XCTAssertEqual(call.phase, .ended(.failed(CallSession.colleagueCallReason)))
        let asks = await api.tokenAsks
        XCTAssertEqual(asks, 0, "no token, no room")
        let hungUp = await api.hungUp
        XCTAssertEqual(hungUp, ["session-1"], "the server is told")
    }

    func testAColleagueCallBegunWhileTheTokenCameStopsTheJoin() async {
        let (call, api) = await run(joined: true, .afterToken)
        XCTAssertEqual(call.phase, .ended(.failed(CallSession.colleagueCallReason)))
        let asks = await api.tokenAsks
        XCTAssertEqual(asks, 1)
        let hungUp = await api.hungUp
        XCTAssertEqual(hungUp, ["session-1"], "the server is told, before any room")
    }

    func testWithoutAColleagueCallTheJoinGoesAhead() async {
        let (_, api) = await run(joined: true, .never)
        let asks = await api.tokenAsks
        XCTAssertEqual(asks, 1, "the join asked for its token")
    }

    func testTheOperatorIsToldWhyInItsOwnWords() {
        let outcome = CallOutcome.failed(CallSession.colleagueCallReason)
        XCTAssertEqual(outcome.title(.en), Str.callEndedForColleagueCall(.en))
        XCTAssertNotEqual(CallOutcome.failed("x").title(.en), Str.callEndedForColleagueCall(.en))
    }
}
