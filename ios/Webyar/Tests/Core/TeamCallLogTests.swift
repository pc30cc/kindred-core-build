import Foundation
import XCTest
@testable import Webyar

/// The call in the chat (docs/operations/TEAM_CALLS.md, "The call in the
/// chat"): `call` on a team-chat line, read exactly as the server writes it,
/// and the rules its bubble and the colleagues list draw it by — the title by
/// who is looking, the danger colour, the arrow, the length.
final class TeamCallLogTests: XCTestCase {
    private let me = "u-me"
    private let peer = "u-peer"

    private func thread(_ json: String) throws -> TeamThreadResponse {
        try StoreCoding.decoder().decode(TeamThreadResponse.self, from: Data(json.utf8))
    }

    private func call(
        _ outcome: TeamCallOutcome,
        _ channel: CallChannel = .audio,
        seconds: Int? = nil,
        caller: String? = nil
    ) -> TeamChatCall {
        TeamChatCall(id: "c1", channel: channel, outcome: outcome, durationSeconds: seconds, callerID: caller ?? me)
    }

    // MARK: - Decoding

    /// The contract's shape, on a thread's line: a completed video call with
    /// its length, beside a message that is not a call at all.
    func testTheThreadsCallDecodes() throws {
        let response = try thread(#"""
        {"me": "u-me", "messages": [
          {"id": "m1", "sender_id": "u-me", "recipient_id": "u-peer", "body": "📹 4:05",
           "attachment": null, "read_at": "2026-11-02T10:05:00.000Z", "created_at": "2026-11-02T10:00:00.000Z",
           "call": {"id": "c1", "channel": "video", "outcome": "completed", "duration_seconds": 245, "caller_id": "u-me"}},
          {"id": "m2", "sender_id": "u-peer", "recipient_id": "u-me", "body": "hi",
           "attachment": null, "read_at": null, "created_at": "2026-11-02T10:06:00.000Z", "call": null},
          {"id": "m3", "sender_id": "u-peer", "recipient_id": "u-me", "body": "older server",
           "attachment": null, "read_at": null, "created_at": "2026-11-02T10:07:00.000Z"}
        ]}
        """#)
        XCTAssertEqual(response.messages.count, 3)
        let line = try XCTUnwrap(response.messages[0].call)
        XCTAssertEqual(line, TeamChatCall(id: "c1", channel: .video, outcome: .completed, durationSeconds: 245, callerID: "u-me"))
        XCTAssertNil(response.messages[1].call)
        XCTAssertNil(response.messages[2].call)
        XCTAssertEqual(response.messages[2].body, "older server")
    }

    /// A call this build cannot draw — an outcome or a channel it does not
    /// know, no caller — is no call, and never fails the thread around it:
    /// the line reads as its body, the fallback the server wrote for it.
    func testACallItCannotDrawLeavesTheLineAndTheThread() throws {
        let response = try thread(#"""
        {"me": "u-me", "messages": [
          {"id": "m1", "sender_id": "u-me", "body": "📞",
           "call": {"id": "c1", "channel": "audio", "outcome": "transferred", "duration_seconds": null, "caller_id": "u-me"}},
          {"id": "m2", "sender_id": "u-me", "body": "📞",
           "call": {"id": "c2", "channel": "hologram", "outcome": "missed", "duration_seconds": null, "caller_id": "u-me"}},
          {"id": "m3", "sender_id": "u-me", "body": "📞",
           "call": {"id": "c3", "channel": "audio", "outcome": "missed", "duration_seconds": null, "caller_id": ""}},
          {"id": "m4", "sender_id": "u-me", "body": "📞", "call": "c4"},
          {"id": "m5", "sender_id": "u-me", "body": "📞",
           "call": {"id": "c5", "channel": "audio", "outcome": "completed", "duration_seconds": "245", "caller_id": "u-me"}},
          {"id": "m6", "sender_id": "u-me", "body": "📞",
           "call": {"id": "c6", "channel": "audio", "outcome": "completed", "duration_seconds": -3, "caller_id": "u-me"}}
        ]}
        """#)
        XCTAssertEqual(response.messages.map(\.id), ["m1", "m2", "m3", "m4", "m5", "m6"])
        XCTAssertNil(response.messages[0].call)
        XCTAssertNil(response.messages[1].call)
        XCTAssertNil(response.messages[2].call)
        XCTAssertNil(response.messages[3].call)
        XCTAssertEqual(response.messages[0].body, "📞")
        // A length that is not a number, or is negative, is a length nobody
        // knows: the call is still drawn, without one.
        XCTAssertEqual(response.messages[4].call?.outcome, .completed)
        XCTAssertNil(response.messages[4].call?.durationSeconds)
        XCTAssertNil(response.messages[5].call?.durationSeconds)
    }

    /// The colleagues list carries the same `call` on `last_message`.
    func testTheListsLastMessageCarriesTheCall() throws {
        let response = try StoreCoding.decoder().decode(ColleaguesResponse.self, from: Data(#"""
        {"me": "u-me", "total_unread": 1, "colleagues": [
          {"user_id": "u-peer", "full_name": "Daniel Carter", "unread": 1,
           "last_message": {"body": "📹", "created_at": "2026-11-02T10:00:00.000Z", "outgoing": false,
             "attachment_kind": null,
             "call": {"id": "c1", "channel": "video", "outcome": "missed", "duration_seconds": null, "caller_id": "u-peer"}}},
          {"user_id": "u-other", "full_name": "Sara", "unread": 0,
           "last_message": {"body": "hi", "created_at": "2026-11-02T09:00:00.000Z", "outgoing": true,
             "attachment_kind": null, "call": null}}
        ]}
        """#.utf8))
        let missed = try XCTUnwrap(response.colleagues[0].lastMessage?.call)
        XCTAssertEqual(missed.channel, .video)
        XCTAssertEqual(missed.outcome, .missed)
        XCTAssertEqual(missed.callerID, "u-peer")
        XCTAssertNil(response.colleagues[1].lastMessage?.call)
        XCTAssertFalse(TeamCallLog.viewerIsCaller(missed, peerID: "u-peer"))
        XCTAssertEqual(
            TeamCallLog.headline(missed, viewerIsCaller: false, language: .en),
            "Missed video call"
        )
    }

    // MARK: - Who is looking

    func testTheCallerIsWhoeverTheColleagueIsNot() {
        XCTAssertTrue(TeamCallLog.viewerIsCaller(call(.completed, caller: me), peerID: peer))
        XCTAssertFalse(TeamCallLog.viewerIsCaller(call(.completed, caller: peer), peerID: peer))
    }

    // MARK: - Titles (the contract's table)

    func testTitlesByOutcomeAndSide() {
        typealias Row = (TeamCallOutcome, CallChannel, caller: TeamCallLog.Title, callee: TeamCallLog.Title)
        let table: [Row] = [
            (.completed, .audio, .voice, .voice),
            (.completed, .video, .video, .video),
            (.missed, .audio, .noAnswer, .missedVoice),
            (.missed, .video, .noAnswer, .missedVideo),
            (.cancelled, .audio, .cancelled, .missedVoice),
            (.cancelled, .video, .cancelled, .missedVideo),
            (.declined, .audio, .declined, .declined),
            (.declined, .video, .declined, .declined),
            (.failed, .audio, .failed, .failed),
            (.failed, .video, .failed, .failed),
        ]
        for row in table {
            let line = call(row.0, row.1)
            XCTAssertEqual(TeamCallLog.title(line, viewerIsCaller: true), row.caller, "\(row.0) \(row.1), caller")
            XCTAssertEqual(TeamCallLog.title(line, viewerIsCaller: false), row.callee, "\(row.0) \(row.1), callee")
        }
    }

    func testTitlesReadTheContractsWords() {
        XCTAssertEqual(TeamCallLog.Title.voice.text(.en), "Voice call")
        XCTAssertEqual(TeamCallLog.Title.video.text(.en), "Video call")
        XCTAssertEqual(TeamCallLog.Title.missedVoice.text(.en), "Missed voice call")
        XCTAssertEqual(TeamCallLog.Title.missedVideo.text(.en), "Missed video call")
        XCTAssertEqual(TeamCallLog.Title.noAnswer.text(.en), "No answer")
        XCTAssertEqual(TeamCallLog.Title.declined.text(.en), "Declined")
        XCTAssertEqual(TeamCallLog.Title.cancelled.text(.en), "Cancelled")
        XCTAssertEqual(TeamCallLog.Title.failed.text(.en), "Call failed")
        XCTAssertEqual(TeamCallLog.Title.missedVoice.text(.fa), "تماس صوتی بی‌پاسخ")
        XCTAssertEqual(Str.teamCallLogCallBack(.en), "Call back")
    }

    /// Missed on either side, and cancelled for the callee only — for whom
    /// it is a missed call.
    func testTheDangerColourIsForMissedCalls() {
        XCTAssertTrue(TeamCallLog.isMissed(call(.missed), viewerIsCaller: true))
        XCTAssertTrue(TeamCallLog.isMissed(call(.missed), viewerIsCaller: false))
        XCTAssertTrue(TeamCallLog.isMissed(call(.cancelled), viewerIsCaller: false))
        XCTAssertFalse(TeamCallLog.isMissed(call(.cancelled), viewerIsCaller: true))
        for outcome in [TeamCallOutcome.completed, .declined, .failed] {
            XCTAssertFalse(TeamCallLog.isMissed(call(outcome), viewerIsCaller: true))
            XCTAssertFalse(TeamCallLog.isMissed(call(outcome), viewerIsCaller: false))
        }
    }

    // MARK: - Icon and arrow

    func testTheIconIsTheChannelAndTheArrowTheDirection() {
        XCTAssertEqual(TeamCallLog.channelSymbol(.audio), "phone.fill")
        XCTAssertEqual(TeamCallLog.channelSymbol(.video), "video.fill")
        XCTAssertEqual(TeamCallLog.arrowSymbol(viewerIsCaller: true), "arrow.up.right")
        XCTAssertEqual(TeamCallLog.arrowSymbol(viewerIsCaller: false), "arrow.down.left")
    }

    // MARK: - Length

    /// `m:ss`, or `h:mm:ss` from an hour on, as the server's body and the web
    /// write it.
    func testTheLengthIsAClock() {
        let en = Language.en.locale
        XCTAssertEqual(TeamCallLog.duration(0, locale: en), "0:00")
        XCTAssertEqual(TeamCallLog.duration(7, locale: en), "0:07")
        XCTAssertEqual(TeamCallLog.duration(65, locale: en), "1:05")
        XCTAssertEqual(TeamCallLog.duration(245, locale: en), "4:05")
        XCTAssertEqual(TeamCallLog.duration(599, locale: en), "9:59")
        XCTAssertEqual(TeamCallLog.duration(600, locale: en), "10:00")
        XCTAssertEqual(TeamCallLog.duration(3599, locale: en), "59:59")
        XCTAssertEqual(TeamCallLog.duration(3600, locale: en), "1:00:00")
        XCTAssertEqual(TeamCallLog.duration(3723, locale: en), "1:02:03")
        XCTAssertEqual(TeamCallLog.duration(-5, locale: en), "0:00")
    }

    /// In the reader's own digits.
    func testTheLengthIsInTheReadersDigits() {
        XCTAssertEqual(TeamCallLog.duration(65, locale: Language.fa.locale), "۱:۰۵")
        XCTAssertEqual(TeamCallLog.duration(3723, locale: Language.fa.locale), "۱:۰۲:۰۳")
        XCTAssertEqual(TeamCallLog.duration(65, locale: Language.ar.locale), "١:٠٥")
        XCTAssertEqual(TeamCallLog.duration(65, locale: Language.tr.locale), "1:05")
    }

    /// Only a completed call has a length on its line.
    func testOnlyACompletedCallShowsItsLength() {
        let en = Language.en.locale
        XCTAssertEqual(TeamCallLog.duration(of: call(.completed, seconds: 245), locale: en), "4:05")
        XCTAssertNil(TeamCallLog.duration(of: call(.completed), locale: en))
        for outcome in [TeamCallOutcome.missed, .cancelled, .declined, .failed] {
            XCTAssertNil(TeamCallLog.duration(of: call(outcome, seconds: 245), locale: en), "\(outcome)")
        }
        XCTAssertEqual(
            TeamCallLog.headline(call(.completed, .video, seconds: 245), viewerIsCaller: true, language: .en),
            "Video call · 4:05"
        )
        XCTAssertEqual(TeamCallLog.headline(call(.declined), viewerIsCaller: false, language: .en), "Declined")
    }

    // MARK: - What the screen reader says

    /// The title (with the length), the direction and the time.
    func testTheAccessibilityLabel() {
        XCTAssertEqual(
            TeamCallLog.accessibilityLabel(call(.completed, seconds: 245), viewerIsCaller: true, time: "10:32", language: .en),
            "Voice call, 4:05, Outgoing, 10:32"
        )
        XCTAssertEqual(
            TeamCallLog.accessibilityLabel(call(.missed, .video), viewerIsCaller: false, time: "9:15", language: .en),
            "Missed video call, Incoming, 9:15"
        )
        XCTAssertEqual(
            TeamCallLog.accessibilityLabel(call(.declined), viewerIsCaller: true, time: "", language: .en),
            "Declined, Outgoing"
        )
        XCTAssertEqual(
            TeamCallLog.accessibilityLabel(call(.missed), viewerIsCaller: true, time: "۱۰:۳۲", language: .fa),
            "بی‌پاسخ، خروجی، ۱۰:۳۲"
        )
    }
}
