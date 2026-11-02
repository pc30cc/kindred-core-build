import Foundation

// Colleague calls: a voice or video call between two members of one
// workspace, rung like a phone call. The contract is
// docs/operations/TEAM_CALLS.md; these are its `TeamCall`, its VoIP payload
// and its realtime event, read exactly as the doc spells them.

/// Where a colleague call is, as the server keeps it (`call_sessions.state`).
enum TeamCallState: String, Sendable, Equatable {
    case ringing, connecting, active, ended, missed, cancelled

    /// Answered, on whichever phone: the room is being joined or is in use.
    var isAnswered: Bool { self == .connecting || self == .active }

    /// Over, for good: nothing more will happen to this call.
    var isOver: Bool { self == .ended || self == .missed || self == .cancelled }
}

extension TeamCallState: Decodable {
    /// A state this build does not know is read as over. Every state the doc
    /// names is above; one added later is something this phone cannot act
    /// on, and a call it cannot act on is one it must stop ringing for.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TeamCallState(rawValue: raw) ?? .ended
    }
}

/// How a call finished (`metadata.team_call.outcome`).
enum TeamCallOutcome: String, Sendable, Equatable {
    case completed, declined, cancelled, missed, failed
}

extension TeamCallOutcome: Decodable {
    /// An outcome this build does not know reads as `failed`: the call is
    /// over, and the one thing the phone can honestly say is that it did not
    /// go as a call should.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TeamCallOutcome(rawValue: raw) ?? .failed
    }
}

/// Which side of the call the signed-in member is on.
enum TeamCallRole: String, Decodable, Sendable, Equatable {
    case caller, callee
}

/// One colleague call, as every `/api/team-calls` answer carries it.
///
/// The peer is always the OTHER member, seen from whoever asked: the same
/// call reads `role: caller, peer: <callee>` on one phone and the reverse on
/// the other. Nothing here is an identity a visitor could see; the LiveKit
/// identity is the server's (`internal:<opaque ref>`).
struct TeamCall: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let workspaceID: String
    let channel: CallChannel
    let state: TeamCallState
    let outcome: TeamCallOutcome?
    let role: TeamCallRole
    let peer: Peer
    /// The phone that answered (the `device_id` its accept carried): how the
    /// callee's other phones know the call went elsewhere.
    let answeredDeviceID: String?
    let createdAt: Date?
    let answeredAt: Date?
    let endedAt: Date?
    /// When the ring stops (`TEAM_CALL_RING_SECONDS` after it started).
    let expiresAt: Date?

    struct Peer: Decodable, Equatable, Sendable {
        let userID: String
        let name: String?
        let avatarURL: String?

        enum CodingKeys: String, CodingKey {
            case userID = "user_id"
            case name
            case avatarURL = "avatar_url"
        }
    }

    enum CodingKeys: String, CodingKey {
        case id, channel, state, outcome, role, peer
        case workspaceID = "workspace_id"
        case answeredDeviceID = "answered_device_id"
        case createdAt = "created_at"
        case answeredAt = "answered_at"
        case endedAt = "ended_at"
        case expiresAt = "expires_at"
    }

    init(
        id: String,
        workspaceID: String,
        channel: CallChannel,
        state: TeamCallState,
        outcome: TeamCallOutcome? = nil,
        role: TeamCallRole,
        peer: Peer,
        answeredDeviceID: String? = nil,
        createdAt: Date? = nil,
        answeredAt: Date? = nil,
        endedAt: Date? = nil,
        expiresAt: Date? = nil
    ) {
        self.id = id
        self.workspaceID = workspaceID
        self.channel = channel
        self.state = state
        self.outcome = outcome
        self.role = role
        self.peer = peer
        self.answeredDeviceID = answeredDeviceID
        self.createdAt = createdAt
        self.answeredAt = answeredAt
        self.endedAt = endedAt
        self.expiresAt = expiresAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        workspaceID = try c.decode(String.self, forKey: .workspaceID)
        // The server's own spelling; anything else is a voice call, as an
        // invitation's unknown channel is (`CallInvitation.kind`).
        channel = CallChannel(rawValue: (try? c.decode(String.self, forKey: .channel)) ?? "") ?? .audio
        state = try c.decode(TeamCallState.self, forKey: .state)
        outcome = try c.decodeIfPresent(TeamCallOutcome.self, forKey: .outcome)
        role = try c.decode(TeamCallRole.self, forKey: .role)
        peer = try c.decode(Peer.self, forKey: .peer)
        answeredDeviceID = try c.decodeIfPresent(String.self, forKey: .answeredDeviceID)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt)
        answeredAt = try c.decodeIfPresent(Date.self, forKey: .answeredAt)
        endedAt = try c.decodeIfPresent(Date.self, forKey: .endedAt)
        expiresAt = try c.decodeIfPresent(Date.self, forKey: .expiresAt)
    }

    /// Answered on the phone `deviceID` names, as the callee: this phone's
    /// call, and so this phone's to hang up.
    func isAnswered(on deviceID: String) -> Bool {
        role == .callee && state.isAnswered && answeredDeviceID == deviceID
    }
}

/// How a colleague call names the colleague — on the call screen, on
/// CallKit's own (the lock screen, the banner) and in either direction: their
/// profile name, trimmed, or "Colleague" in the operator's language for a
/// member who never set one. Never their e-mail (`Colleague.displayName`
/// falls back to it, which is right for a list of people and wrong for a call
/// screen a passer-by can read), never "—", and never a letter: the face
/// beside it is the member silhouette (`Avatar`, `.member`). The server names
/// nobody either — its `peer.name` and the ring's `caller_name` are the
/// profile name or nothing — and says "Colleague" in its own missed-call
/// notification, so a member is called the same on every phone and both
/// sides of a call.
enum TeamCallName {
    static func shown(_ profileName: String?, _ language: Language) -> String {
        let name = profileName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? Str.teamCallColleague(language) : name
    }
}

/// `{ "call": TeamCall }`: how every `/api/team-calls` route answers, a
/// `409 not_ringing` included.
struct TeamCallResponse: Decodable, Sendable {
    let call: TeamCall
}

/// What answering came to (`POST /api/team-calls/:id/accept`).
enum TeamCallAcceptance: Sendable, Equatable {
    /// This phone won: the call is `connecting` and the room is ours to join.
    case accepted(TeamCall)
    /// `409 not_ringing`: another phone answered first, or the call ended
    /// while the answer was on its way. The call as it now stands, when the
    /// server sent it.
    case notRinging(TeamCall?)

    /// The call as the server answered with it.
    var call: TeamCall? {
        switch self {
        case .accepted(let call): call
        case .notRinging(let call): call
        }
    }

    /// This phone has the call: its answer was taken now, or had been — an
    /// answer sent twice reads `not_ringing` with the call answered here.
    func isWon(by deviceID: String) -> Bool {
        switch self {
        case .accepted: true
        case .notRinging(let call): call?.isAnswered(on: deviceID) == true
        }
    }
}

/// How long a colleague call rings, on either phone.
enum TeamCallTiming {
    /// `TEAM_CALL_RING_SECONDS`.
    static let ringSeconds: TimeInterval = 45

    /// When a ringing phone stops on its own: at the server's `expires_at`,
    /// as the contract says, but never later than one ring after the ring
    /// reached it — a clock running behind the server's would otherwise ring
    /// for minutes. No allowance past `expires_at`: the server's ticker turns
    /// the call `missed` within five seconds of it and sends the missed-call
    /// alert then, and a phone still ringing after that alert would be
    /// offering a call that no longer exists.
    static func deadline(expiresAt: Date?, receivedAt: Date) -> Date {
        let ringEnd = receivedAt.addingTimeInterval(ringSeconds)
        return expiresAt.map { min($0, ringEnd) } ?? ringEnd
    }

    /// How long past its own deadline the caller's phone waits for the
    /// server's word before it gives up on the ring by itself: the ticker's
    /// five seconds, a poll's two and the request's way there and back. The
    /// caller's phone is not the one ringing, so nothing here offers a dead
    /// call; what it guards against is the opposite — an answer in the ring's
    /// last moments, which the caller must not walk away from
    /// (`CallManager.ringUntil`).
    static let callerGrace: TimeInterval = 10
}

/// A VoIP push that rings this phone for a colleague call (`kind:
/// "team_call"`, `event: "incoming"`), read off PushKit's payload.
///
/// Only the shape is checked here: whether the call is still ringing, and
/// for this member, is the server's to say (`GET /api/team-calls/:id`,
/// which answers 404 for anybody but the caller and the callee). The payload
/// is a routing hint, never authority — as a notification's is.
///
/// Read as PushKit hands it over: the APNs payload's JSON, parsed — strings
/// as `String`, `null` as `NSNull`, numbers as `NSNumber`. The server writes
/// `expires_at` as a number (Unix seconds, `teamCallVoipPayload`), and
/// `workspace_name` and `caller_avatar_url` as `null` when it has none
/// (src/test/ios/teamCallVoipPayload.test.ts holds the two sides together).
struct TeamCallRing: Equatable, Sendable {
    let callID: String
    let workspaceID: String
    let workspaceName: String?
    let channel: CallChannel
    /// The caller's profile name; nil without one (`TeamCallName`).
    let callerName: String?
    let callerAvatarURL: String?
    let callerUserID: String?
    let expiresAt: Date

    /// Nil for anything that is not a well-formed colleague ring: another
    /// kind, another event, a call id that is not a UUID (CallKit keys the
    /// call by it), or no expiry.
    init?(payload: [AnyHashable: Any]) {
        func text(_ key: String) -> String? {
            guard let value = payload[key] as? String else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        guard text("kind") == "team_call", text("event") == "incoming",
              let callID = text("call_id"), UUID(uuidString: callID) != nil,
              let workspaceID = text("workspace_id"),
              let expiresAt = Self.instant(payload["expires_at"])
        else { return nil }
        self.callID = callID
        self.workspaceID = workspaceID
        self.workspaceName = text("workspace_name")
        self.channel = CallChannel(rawValue: text("channel") ?? "") ?? .audio
        self.callerName = text("caller_name")
        self.callerAvatarURL = text("caller_avatar_url")
        self.callerUserID = text("caller_user_id")
        self.expiresAt = expiresAt
    }

    /// `expires_at` as the server writes it — Unix seconds, a JSON number,
    /// which arrives as an `NSNumber` — and, so that a change of encoding on
    /// the server cannot silently stop every iPhone ringing, the same number
    /// written as a string, or an ISO 8601 date. A JSON `true` is an
    /// `NSNumber` too, and is not a time.
    static func instant(_ value: Any?) -> Date? {
        guard let value else { return nil }
        if let number = value as? NSNumber {
            guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            return epoch(number.doubleValue)
        }
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let number = Double(trimmed) { return epoch(number) }
        return DateParsing.parse(trimmed)
    }

    /// Seconds since 1970 — or milliseconds, for a value no time in seconds
    /// reaches for thirty thousand years.
    private static func epoch(_ value: Double) -> Date? {
        guard value.isFinite, value > 0 else { return nil }
        return Date(timeIntervalSince1970: value >= 1e12 ? value / 1000 : value)
    }

    /// The UUID CallKit knows this call by: the call id itself, so a second
    /// push for the same call is recognised as the same call.
    var uuid: UUID { UUID(uuidString: callID) ?? UUID() }

    /// The ring has run out: `expires_at` has come. Such a ring is reported
    /// to CallKit and ended at once (`CallManager.reportIncoming`).
    func isExpired(now: Date) -> Bool {
        expiresAt <= now
    }
}

/// A colleague call changed, heard on the member's own channel
/// `ws:<workspace>:user:<uid>`: `{ type: "event", payload: { kind:
/// "team_call", workspace_id, call_id, state, outcome } }`, published to the
/// caller and the callee on every change. Only a nudge, so only the call's
/// id is taken from it: the call is read again over REST, where the answer
/// — the state, the outcome, which phone answered — is the member's own.
struct TeamCallSignal: Sendable, Equatable {
    static let kind = "team_call"

    let callID: String

    static func parse(_ data: JSONValue) -> TeamCallSignal? {
        let payload = data["payload"]
        guard payload?["kind"]?.stringValue == kind, let callID = payload?["call_id"]?.stringValue else { return nil }
        return TeamCallSignal(callID: callID)
    }
}

/// Why a colleague call ended, in the terms the call screen says it.
///
/// One value for every way a call can stop, on either side. Most of them come
/// from the server (`TeamCallEnd.resolve`); `hungUp` is this phone's own
/// End, Decline or Cancel; the refusals come from `POST /api/team-calls`.
enum TeamCallEnd: Equatable, Sendable {
    /// Ended on this phone: End after an answer, Decline, or Cancel.
    case hungUp
    /// The colleague hung up, or the room closed under the call.
    case remoteEnded
    /// The colleague declined (seen by the caller).
    case declined
    /// Declined on another phone of this member's (seen by the callee).
    case declinedElsewhere
    /// The caller gave up before an answer (seen by the callee).
    case cancelled
    /// Nobody answered in time, seen by the caller.
    case noAnswer
    /// Nobody answered in time, seen by the callee: a missed call.
    case missed
    /// Another phone of this member's answered first.
    case answeredElsewhere
    /// `409 callee_busy` / `409 caller_busy`: one of the two is in a call.
    case busy
    /// `403 upgrade_required`: the plan has no colleague calls.
    case notInPlan
    /// `422 limit_reached`: the plan's concurrent calls or monthly minutes.
    case limitReached
    /// Anything else: no network, no room, a refusal this build cannot place.
    case failed

    /// What a call the server reports as no longer ringing means for this
    /// phone, or nil while it is still ringing — or answered, and so going on.
    ///
    /// `deviceID` is the id this phone registers with (and answers with):
    /// a call answered with any other is the callee's other phone.
    static func resolve(_ call: TeamCall, deviceID: String) -> TeamCallEnd? {
        switch call.state {
        case .ringing:
            return nil
        case .connecting, .active:
            if call.role == .callee, call.answeredDeviceID != deviceID { return .answeredElsewhere }
            return nil
        case .missed:
            return call.role == .caller ? .noAnswer : .missed
        case .cancelled:
            return .cancelled
        case .ended:
            switch call.outcome {
            case .declined?:
                return call.role == .caller ? .declined : .declinedElsewhere
            case .missed?:
                return call.role == .caller ? .noAnswer : .missed
            case .cancelled?:
                return .cancelled
            case .failed?:
                return .failed
            case .completed?, nil:
                return .remoteEnded
            }
        }
    }

    /// Why `POST /api/team-calls` refused to ring, from its status and the
    /// `error` code in its body.
    static func refusal(status: Int, code: String?) -> TeamCallEnd {
        switch (status, code) {
        case (409, "callee_busy"?), (409, "caller_busy"?): .busy
        case (403, "upgrade_required"?): .notInPlan
        case (422, _): .limitReached
        default: .failed
        }
    }
}

extension Entitlements {
    /// Whether the plan allows a colleague call of this kind: `team_calls`
    /// on, the Voice & Video module on, and the call's own channel on —
    /// `voice` for a voice call, `video` for a video one — each exactly
    /// `true`, the web's one rule (`planAccess.ts`). Deny on create, allow
    /// on continuity: this only ever decides whether a call is offered, and
    /// a call already on is never cut by a plan read afterwards.
    func allowsTeamCall(_ channel: CallChannel) -> Bool {
        featureEnabled("team_calls")
            && moduleEnabled("voice_video")
            && channelEnabled(channel == .video ? "video" : "voice")
    }
}
