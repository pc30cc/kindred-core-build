import CallKit
import Foundation
import XCTest
@testable import Webyar

/// Colleague calls, read exactly as docs/operations/TEAM_CALLS.md spells
/// them: the `TeamCall` every route answers, the VoIP push that rings, the
/// realtime nudge, the missed-call notification — and what each way a call
/// ends means on this phone and to CallKit.
final class TeamCallTests: XCTestCase {
    private let me = "device-here"

    private func decode(_ json: String) throws -> TeamCall {
        try StoreCoding.decoder().decode(TeamCallResponse.self, from: Data(json.utf8)).call
    }

    private func call(
        state: TeamCallState,
        outcome: TeamCallOutcome? = nil,
        role: TeamCallRole,
        answeredDeviceID: String? = nil
    ) -> TeamCall {
        TeamCall(
            id: "7d3f8c2e-1a4b-4c5d-9e6f-0a1b2c3d4e5f",
            workspaceID: "w1",
            channel: .audio,
            state: state,
            outcome: outcome,
            role: role,
            peer: TeamCall.Peer(userID: "u2", name: "Daniel Carter", avatarURL: nil),
            answeredDeviceID: answeredDeviceID
        )
    }

    // MARK: - TeamCall

    func testTheDocsTeamCallDecodes() throws {
        let call = try decode(#"""
        {"call": {
          "id": "7d3f8c2e-1a4b-4c5d-9e6f-0a1b2c3d4e5f", "workspace_id": "w1", "channel": "video",
          "state": "ringing", "outcome": null, "role": "callee",
          "peer": { "user_id": "u2", "name": "Daniel Carter", "avatar_url": null },
          "answered_device_id": null,
          "created_at": "2026-11-01T10:00:00.000Z", "answered_at": null, "ended_at": null,
          "expires_at": "2026-11-01T10:00:45.000Z"
        }}
        """#)
        XCTAssertEqual(call.id, "7d3f8c2e-1a4b-4c5d-9e6f-0a1b2c3d4e5f")
        XCTAssertEqual(call.workspaceID, "w1")
        XCTAssertEqual(call.channel, .video)
        XCTAssertEqual(call.state, .ringing)
        XCTAssertNil(call.outcome)
        XCTAssertEqual(call.role, .callee)
        XCTAssertEqual(call.peer.userID, "u2")
        XCTAssertEqual(call.peer.name, "Daniel Carter")
        XCTAssertNil(call.answeredDeviceID)
        let created = try XCTUnwrap(call.createdAt)
        let expires = try XCTUnwrap(call.expiresAt)
        XCTAssertEqual(expires.timeIntervalSince(created), 45, accuracy: 0.001)
    }

    /// `rang_at`: nil until a phone of the callee's says it rings, and absent
    /// on a server that does not send it yet — the caller's phone then stays
    /// on "Calling…" with no ringback, never on "Ringing…" too early.
    func testRangAtIsReadAndMayBeAbsent() throws {
        let rang = try decode(#"""
        {"call": {"id": "c1", "workspace_id": "w1", "channel": "audio", "state": "ringing",
          "role": "caller", "peer": {"user_id": "u2", "name": "Daniel"},
          "created_at": "2026-11-01T10:00:00.000Z", "rang_at": "2026-11-01T10:00:01.500Z"}}
        """#)
        let created = try XCTUnwrap(rang.createdAt)
        let rangAt = try XCTUnwrap(rang.rangAt)
        XCTAssertEqual(rangAt.timeIntervalSince(created), 1.5, accuracy: 0.001)

        let notYet = try decode(#"""
        {"call": {"id": "c1", "workspace_id": "w1", "channel": "audio", "state": "ringing",
          "role": "caller", "peer": {"user_id": "u2"}, "rang_at": null}}
        """#)
        XCTAssertNil(notYet.rangAt)

        let older = try decode(#"""
        {"call": {"id": "c1", "workspace_id": "w1", "channel": "audio", "state": "ringing",
          "role": "caller", "peer": {"user_id": "u2"}}}
        """#)
        XCTAssertNil(older.rangAt)
    }

    /// The ringback is a playable WAV of one 3 s cycle, and loud: a tone
    /// heard at arm's length, not a blip (owner, 2026-11-05).
    func testTheRingbackToneIsAWaveFile() {
        let wav = RingbackTone.wav
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: wav.subdata(in: 8..<12), as: UTF8.self), "WAVE")
        XCTAssertEqual(wav.count, 44 + Int(22_050 * 3.0) * 2)
        let samples = wav.subdata(in: 44..<wav.count).withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        let peak = samples.map { abs(Int($0)) }.max() ?? 0
        XCTAssertGreaterThan(peak, 20_000, "near full scale")
        let sounding = samples.filter { abs(Int($0)) > 3_000 }.count
        XCTAssertGreaterThan(Double(sounding) / 22_050, 0.8, "most of a second and a half sounding, not short beeps")
    }

    /// A value this build does not know never fails the whole answer: an
    /// unknown state is over, an unknown outcome a failure, an unknown
    /// channel a voice call — and a member without a name is "Colleague",
    /// never an e-mail.
    func testWhatThisBuildDoesNotKnowReadsSafely() throws {
        let call = try decode(#"""
        {"call": {"id": "c1", "workspace_id": "w1", "channel": "hologram", "state": "teleporting",
          "outcome": "vanished", "role": "caller", "peer": {"user_id": "u2", "name": "  "}}}
        """#)
        XCTAssertEqual(call.state, .ended)
        XCTAssertTrue(call.state.isOver)
        XCTAssertEqual(call.outcome, .failed)
        XCTAssertEqual(call.channel, .audio)
        XCTAssertEqual(TeamCallName.shown(call.peer.name, .en), "Colleague")
    }

    func testAnsweredAndOverAreTheServersStates() {
        XCTAssertTrue(TeamCallState.connecting.isAnswered)
        XCTAssertTrue(TeamCallState.active.isAnswered)
        XCTAssertFalse(TeamCallState.ringing.isAnswered)
        for state in [TeamCallState.ended, .missed, .cancelled] {
            XCTAssertTrue(state.isOver, state.rawValue)
            XCTAssertFalse(state.isAnswered, state.rawValue)
        }
    }

    // MARK: - The VoIP push

    /// The server's own payload (`teamCallVoipPayload`), as PushKit hands it
    /// over: the APNs JSON parsed, so `expires_at` — Unix seconds, a JSON
    /// number — is an `NSNumber`, and a field the server has no value for is
    /// `NSNull`.
    private func serverPayload(_ json: String) throws -> [AnyHashable: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [AnyHashable: Any])
    }

    private var ringJSON: String {
        #"""
        {"kind": "team_call", "event": "incoming",
         "call_id": "7D3F8C2E-1A4B-4C5D-9E6F-0A1B2C3D4E5F", "workspace_id": "w1", "workspace_name": "Acme",
         "channel": "video", "caller_name": "Daniel Carter", "caller_avatar_url": "https://cdn.example/d.png",
         "caller_user_id": "u2", "expires_at": 1762000045}
        """#
    }

    private var ringPayload: [AnyHashable: Any] {
        (try? serverPayload(ringJSON)) ?? [:]
    }

    func testARingIsReadFromThePayload() throws {
        let ring = try XCTUnwrap(TeamCallRing(payload: ringPayload))
        XCTAssertEqual(ring.callID, "7D3F8C2E-1A4B-4C5D-9E6F-0A1B2C3D4E5F")
        XCTAssertEqual(ring.workspaceID, "w1")
        XCTAssertEqual(ring.workspaceName, "Acme")
        XCTAssertEqual(ring.channel, .video)
        XCTAssertEqual(ring.callerName, "Daniel Carter")
        XCTAssertEqual(ring.callerAvatarURL, "https://cdn.example/d.png")
        XCTAssertEqual(ring.callerUserID, "u2")
        XCTAssertEqual(ring.expiresAt, Date(timeIntervalSince1970: 1_762_000_045))
        // CallKit knows the call by its own id, so a second push for it is
        // the same call.
        XCTAssertEqual(ring.uuid, UUID(uuidString: "7d3f8c2e-1a4b-4c5d-9e6f-0a1b2c3d4e5f"))
    }

    /// Exactly what the server sends for a workspace and a caller with
    /// neither a name nor a photo: two nulls, an empty name, the expiry as a
    /// number. Still a ring: a parser that refused it would leave every
    /// iPhone silent for such a colleague.
    func testTheServersSparestRingIsARing() throws {
        let payload = try serverPayload(#"""
        {"kind": "team_call", "event": "incoming", "call_id": "7d3f8c2e-1a4b-4c5d-9e6f-0a1b2c3d4e5f",
         "workspace_id": "w1", "workspace_name": null, "channel": "audio", "caller_name": "",
         "caller_avatar_url": null, "caller_user_id": "u2", "expires_at": 1762000045}
        """#)
        XCTAssertTrue(payload["expires_at"] is NSNumber)
        XCTAssertTrue(payload["workspace_name"] is NSNull)
        let ring = try XCTUnwrap(TeamCallRing(payload: payload))
        XCTAssertEqual(ring.expiresAt, Date(timeIntervalSince1970: 1_762_000_045))
        XCTAssertNil(ring.workspaceName)
        XCTAssertNil(ring.callerAvatarURL)
        XCTAssertNil(ring.callerName)
        XCTAssertEqual(ring.channel, .audio)
    }

    /// The expiry the server writes, and the spellings a change of encoding
    /// on its side could bring, all read; nothing else is a time.
    func testTheExpiryIsReadInEveryForm() {
        let at = Date(timeIntervalSince1970: 1_762_000_045)
        XCTAssertEqual(TeamCallRing.instant(NSNumber(value: 1_762_000_045)), at)
        XCTAssertEqual(TeamCallRing.instant(NSNumber(value: 1_762_000_045.0)), at)
        XCTAssertEqual(TeamCallRing.instant(NSNumber(value: 1_762_000_045_000 as Int64)), at, "milliseconds")
        XCTAssertEqual(TeamCallRing.instant("1762000045"), at)
        XCTAssertEqual(TeamCallRing.instant(" 1762000045000 "), at)
        XCTAssertEqual(TeamCallRing.instant("2025-11-01T12:27:25Z"), at)
        XCTAssertEqual(TeamCallRing.instant("2025-11-01T12:27:25.000Z"), at)

        XCTAssertNil(TeamCallRing.instant(nil))
        XCTAssertNil(TeamCallRing.instant(NSNull()))
        XCTAssertNil(TeamCallRing.instant(NSNumber(value: true)), "a JSON true is an NSNumber, not a time")
        XCTAssertNil(TeamCallRing.instant(NSNumber(value: 0)))
        XCTAssertNil(TeamCallRing.instant(NSNumber(value: -5)))
        XCTAssertNil(TeamCallRing.instant("soon"))
        XCTAssertNil(TeamCallRing.instant(""))
        XCTAssertNil(TeamCallRing.instant(["at": 1_762_000_045]))
    }

    /// Each of these is reported to CallKit and ended at once
    /// (`CallManager.reportIncoming`), never left ringing.
    func testAnythingButAWellFormedColleagueRingIsNotARing() {
        var payload = ringPayload
        payload["kind"] = "call_ring"
        XCTAssertNil(TeamCallRing(payload: payload), "another kind")

        payload = ringPayload
        payload["event"] = "cancel"
        XCTAssertNil(TeamCallRing(payload: payload), "not an incoming ring")

        payload = ringPayload
        payload["call_id"] = "not-a-uuid"
        XCTAssertNil(TeamCallRing(payload: payload), "CallKit keys the call by a UUID")

        payload = ringPayload
        payload["expires_at"] = nil
        XCTAssertNil(TeamCallRing(payload: payload), "no expiry")

        payload = ringPayload
        payload["expires_at"] = NSNull()
        XCTAssertNil(TeamCallRing(payload: payload), "a null expiry")

        payload = ringPayload
        payload["workspace_id"] = ""
        XCTAssertNil(TeamCallRing(payload: payload), "no workspace")

        XCTAssertNil(TeamCallRing(payload: [:]))
    }

    /// A colleague without a profile name is "Colleague" in the operator's
    /// language, on the ring, on the call screen and on a call placed to
    /// them alike — never an e-mail, never "—".
    func testANamelessColleagueIsAColleagueAndAnUnknownChannelIsVoice() throws {
        var payload = ringPayload
        payload["caller_name"] = nil
        payload["channel"] = "smoke-signal"
        let ring = try XCTUnwrap(TeamCallRing(payload: payload))
        XCTAssertNil(ring.callerName)
        XCTAssertEqual(ring.channel, .audio)

        XCTAssertEqual(TeamCallName.shown(ring.callerName, .en), "Colleague")
        XCTAssertEqual(TeamCallName.shown("   ", .fa), "همکار")
        XCTAssertEqual(TeamCallName.shown(nil, .tr), "İş arkadaşı")
        XCTAssertEqual(TeamCallName.shown("  Sara Ahmadi ", .en), "Sara Ahmadi")
        XCTAssertEqual(active(.outgoing, .calling).peerName(.en), "Colleague")
    }

    /// The phone that rings stops at `expires_at`, with no allowance past
    /// it, and never rings longer than one ring.
    func testARingEndsAtItsExpiryAndRingsNoLongerThanOneRing() throws {
        let ring = try XCTUnwrap(TeamCallRing(payload: ringPayload))
        let expires = ring.expiresAt
        XCTAssertFalse(ring.isExpired(now: expires.addingTimeInterval(-1)))
        XCTAssertTrue(ring.isExpired(now: expires))
        XCTAssertTrue(ring.isExpired(now: expires.addingTimeInterval(1)))

        // On time: the server's expiry, exactly.
        let onTime = expires.addingTimeInterval(-40)
        XCTAssertEqual(TeamCallTiming.deadline(expiresAt: expires, receivedAt: onTime), expires)
        // A phone whose clock is behind sees a far-off expiry: it still
        // rings for one ring only.
        let received = expires.addingTimeInterval(-600)
        XCTAssertEqual(
            TeamCallTiming.deadline(expiresAt: expires, receivedAt: received),
            received.addingTimeInterval(TeamCallTiming.ringSeconds)
        )
        // The caller's phone waits a little past it for the server's word.
        XCTAssertGreaterThan(TeamCallTiming.callerGrace, 7, "the ticker's 5 s and a 2 s poll")
    }

    // MARK: - Realtime and the missed-call notification

    private func envelope(_ payload: [String: String]) throws -> JSONValue {
        let data = try JSONSerialization.data(withJSONObject: ["type": "event", "payload": payload])
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    func testATeamCallEventNamesItsCall() throws {
        let signal = try XCTUnwrap(TeamCallSignal.parse(envelope([
            "kind": "team_call", "workspace_id": "w1", "call_id": "c1", "state": "ended", "outcome": "declined",
        ])))
        XCTAssertEqual(signal.callID, "c1")
        XCTAssertNil(TeamCallSignal.parse(try envelope(["kind": "team_call", "workspace_id": "w1"])))
        XCTAssertNil(TeamCallSignal.parse(try envelope(["kind": "team_message", "call_id": "c1"])))
        // And a team call is not mistaken for a team message.
        XCTAssertNil(TeamEvent.parse(try envelope(["kind": "team_call", "call_id": "c1"])))
    }

    func testAMissedCallOpensTheThreadWithTheCaller() {
        let target = PushTarget(userInfo: [
            "type": "team_call_missed", "workspaceId": "w1", "peerId": "u2", "callId": "c1", "channel": "audio",
        ])
        XCTAssertEqual(target, .colleague(workspaceID: "w1", peerID: "u2"))
        XCTAssertNil(PushTarget(userInfo: ["type": "team_call_missed", "workspaceId": "w1", "callId": "c1"]))
    }

    // MARK: - How a call ends

    func testRingingAndAnsweredHereGoOn() {
        XCTAssertNil(TeamCallEnd.resolve(call(state: .ringing, role: .callee), deviceID: me))
        XCTAssertNil(TeamCallEnd.resolve(call(state: .ringing, role: .caller), deviceID: me))
        XCTAssertNil(TeamCallEnd.resolve(call(state: .connecting, role: .callee, answeredDeviceID: me), deviceID: me))
        XCTAssertNil(TeamCallEnd.resolve(call(state: .active, role: .callee, answeredDeviceID: me), deviceID: me))
        // The caller's call is answered by the colleague, whichever phone.
        XCTAssertNil(TeamCallEnd.resolve(call(state: .connecting, role: .caller, answeredDeviceID: "theirs"), deviceID: me))
    }

    func testAnAnswerOnAnotherPhoneStopsThisOne() {
        XCTAssertEqual(
            TeamCallEnd.resolve(call(state: .connecting, role: .callee, answeredDeviceID: "my-ipad"), deviceID: me),
            .answeredElsewhere
        )
        XCTAssertEqual(TeamCallEnd.resolve(call(state: .active, role: .callee), deviceID: me), .answeredElsewhere)
    }

    func testEachSideReadsTheEndItsOwnWay() {
        XCTAssertEqual(TeamCallEnd.resolve(call(state: .missed, outcome: .missed, role: .caller), deviceID: me), .noAnswer)
        XCTAssertEqual(TeamCallEnd.resolve(call(state: .missed, outcome: .missed, role: .callee), deviceID: me), .missed)
        XCTAssertEqual(TeamCallEnd.resolve(call(state: .cancelled, outcome: .cancelled, role: .callee), deviceID: me), .cancelled)
        XCTAssertEqual(TeamCallEnd.resolve(call(state: .ended, outcome: .declined, role: .caller), deviceID: me), .declined)
        XCTAssertEqual(
            TeamCallEnd.resolve(call(state: .ended, outcome: .declined, role: .callee), deviceID: me),
            .declinedElsewhere, "declined on another phone of this member's"
        )
        XCTAssertEqual(TeamCallEnd.resolve(call(state: .ended, outcome: .completed, role: .caller), deviceID: me), .remoteEnded)
        XCTAssertEqual(TeamCallEnd.resolve(call(state: .ended, role: .callee), deviceID: me), .remoteEnded)
        XCTAssertEqual(TeamCallEnd.resolve(call(state: .ended, outcome: .failed, role: .caller), deviceID: me), .failed)
        XCTAssertEqual(TeamCallEnd.resolve(call(state: .ended, outcome: .missed, role: .callee), deviceID: me), .missed)
    }

    func testCallKitIsToldWhyInItsOwnTerms() {
        XCTAssertEqual(TeamCallEnd.remoteEnded.callKitReason, .remoteEnded)
        XCTAssertEqual(TeamCallEnd.declined.callKitReason, .remoteEnded)
        XCTAssertEqual(TeamCallEnd.cancelled.callKitReason, .remoteEnded)
        XCTAssertEqual(TeamCallEnd.noAnswer.callKitReason, .unanswered)
        XCTAssertEqual(TeamCallEnd.missed.callKitReason, .unanswered)
        XCTAssertEqual(TeamCallEnd.answeredElsewhere.callKitReason, .answeredElsewhere)
        XCTAssertEqual(TeamCallEnd.declinedElsewhere.callKitReason, .declinedElsewhere)
        for end in [TeamCallEnd.busy, .notInPlan, .limitReached, .failed] {
            XCTAssertEqual(end.callKitReason, .failed, "\(end)")
        }
    }

    func testARefusedRingSaysWhy() {
        XCTAssertEqual(TeamCallEnd.refusal(status: 409, code: "callee_busy"), .busy)
        XCTAssertEqual(TeamCallEnd.refusal(status: 409, code: "caller_busy"), .busy)
        XCTAssertEqual(TeamCallEnd.refusal(status: 403, code: "upgrade_required"), .notInPlan)
        XCTAssertEqual(TeamCallEnd.refusal(status: 422, code: "limit_reached"), .limitReached)
        XCTAssertEqual(TeamCallEnd.refusal(status: 403, code: "not_a_member"), .failed)
        XCTAssertEqual(TeamCallEnd.refusal(status: 429, code: "too_many_calls"), .failed)
        XCTAssertEqual(TeamCallEnd.refusal(status: 400, code: nil), .failed)
    }

    // MARK: - What the server is told

    private func active(_ direction: ActiveTeamCall.Direction, _ phase: ActiveTeamCall.Phase, answered: Bool = false) -> ActiveTeamCall {
        ActiveTeamCall(
            uuid: UUID(),
            callID: "c1",
            direction: direction,
            channel: .audio,
            peerProfileName: nil,
            peerAvatarURL: nil,
            phase: phase,
            answered: answered,
            knownToCallKit: true,
            isSpeakerOn: false,
            isCameraOn: false
        )
    }

    /// The caller always hangs up: the server makes it a cancel while the
    /// colleague's phones ring and ends the call once they answered — which
    /// the caller's phone may not have heard yet.
    func testTheCallerAlwaysHangsUp() {
        XCTAssertEqual(TeamCallNotice.leaving(active(.outgoing, .calling)), .hangUp)
        XCTAssertEqual(TeamCallNotice.leaving(active(.outgoing, .ringing)), .hangUp)
        XCTAssertEqual(TeamCallNotice.leaving(active(.outgoing, .connecting, answered: true)), .hangUp)
        XCTAssertEqual(TeamCallNotice.leaving(active(.outgoing, .live(since: Date()), answered: true)), .hangUp)
    }

    /// The callee declines while it rings here — never a hang-up, which
    /// could end a call the member's other phone has just answered — hangs
    /// up once its own answer went through, and waits for the answer that is
    /// still out.
    func testTheCalleeDeclinesHangsUpOrWaitsForItsAnswer() {
        XCTAssertEqual(TeamCallNotice.leaving(active(.incoming, .ringing)), .decline)
        XCTAssertEqual(TeamCallNotice.leaving(active(.incoming, .connecting)), .afterTheAnswer)
        XCTAssertEqual(TeamCallNotice.leaving(active(.incoming, .connecting, answered: true)), .hangUp)
        XCTAssertEqual(TeamCallNotice.leaving(active(.incoming, .live(since: Date()), answered: true)), .hangUp)
    }

    func testAnAnswerIsThisPhonesOnlyWhenTheServerSaysSo() {
        let answeredHere = call(state: .connecting, role: .callee, answeredDeviceID: me)
        let answeredThere = call(state: .connecting, role: .callee, answeredDeviceID: "my-ipad")
        XCTAssertTrue(TeamCallAcceptance.accepted(answeredHere).isWon(by: me))
        XCTAssertTrue(TeamCallAcceptance.notRinging(answeredHere).isWon(by: me), "an answer sent twice")
        XCTAssertFalse(TeamCallAcceptance.notRinging(answeredThere).isWon(by: me))
        XCTAssertFalse(TeamCallAcceptance.notRinging(call(state: .ringing, role: .callee)).isWon(by: me))
        XCTAssertFalse(TeamCallAcceptance.notRinging(call(state: .cancelled, outcome: .cancelled, role: .callee)).isWon(by: me))
        XCTAssertFalse(TeamCallAcceptance.notRinging(nil).isWon(by: me))
        XCTAssertEqual(TeamCallAcceptance.notRinging(answeredThere).call, answeredThere)

        XCTAssertTrue(answeredHere.isAnswered(on: me))
        XCTAssertFalse(answeredThere.isAnswered(on: me))
        XCTAssertFalse(call(state: .connecting, role: .caller, answeredDeviceID: me).isAnswered(on: me), "the caller answers nothing")
    }

    func testEveryEndHasItsOwnLine() {
        XCTAssertEqual(TeamCallEnd.missed.title(.en, channel: .audio), "Missed voice call")
        XCTAssertEqual(TeamCallEnd.missed.title(.en, channel: .video), "Missed video call")
        XCTAssertEqual(TeamCallEnd.answeredElsewhere.title(.en, channel: .audio), "Answered on another device")
        XCTAssertEqual(TeamCallEnd.busy.title(.fa, channel: .audio), Str.teamCallBusy(.fa))
        XCTAssertEqual(TeamCallEnd.notInPlan.title(.tr, channel: .video), Str.teamCallNotInPlan(.tr))
    }
}
