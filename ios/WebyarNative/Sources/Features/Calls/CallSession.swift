import Foundation
import AVFoundation
import Observation
import LiveKit

/// Where a call is in its life.
///
/// One value rather than a set of booleans, for the same reason `LoadState`
/// exists: it makes "connecting and also ended" unrepresentable, and every
/// one of those combinations is a bug somebody would otherwise have to find.
enum CallPhase: Equatable, Sendable {
    /// The invitation is out; the visitor has not answered.
    case waiting
    /// They answered; we are joining the room.
    case connecting
    /// Both sides are in.
    case connected
    /// Over, for the stated reason.
    case ended(CallOutcome)

    var isLive: Bool {
        switch self {
        case .waiting, .connecting, .connected: true
        case .ended: false
        }
    }
}

/// How a call finished. Each of these reads differently to an operator, and
/// telling them apart is most of what makes the screen feel honest.
enum CallOutcome: Equatable, Sendable {
    /// The operator hung up.
    case hungUp
    /// The visitor hung up, or closed the page.
    case visitorLeft
    /// The visitor said no.
    case declined
    /// Nobody answered in time.
    case expired
    /// We never got into the room.
    case failed(String)
}

/// One call, from the invitation going out to the room closing.
///
/// The shape of this deliberately mirrors what the operator console does,
/// because the two have to agree: the same invitation is polled, the same
/// `POST /api/calls/:id/token` is minted, and the same LiveKit room is joined
/// with the same participant type. A phone that took a shortcut here would be
/// a phone whose calls behave subtly differently from the desktop's, and
/// nobody would be able to say how.
@MainActor
@Observable
final class CallSession {

    private(set) var phase: CallPhase = .waiting
    /// The visitor, once they are actually in the room.
    private(set) var visitorPresent = false
    private(set) var isMuted = false
    private(set) var isCameraOn: Bool
    private(set) var isSpeakerOn = true
    /// When the two sides actually connected, which is what the timer counts
    /// from — not when the invitation was sent.
    private(set) var connectedAt: Date?
    /// Set when the server warned that TURN is unconfigured. Not fatal, but
    /// the first thing to look at when a call fails on a mobile network.
    private(set) var relayWarning = false

    let channel: CallChannel
    let contactName: String
    let contactAvatarURL: String?

    /// The room, once there is one. `nil` outside a connected call, which is
    /// also what releases the microphone.
    private(set) var room: Room?

    private let invitationID: String
    private let api: any WebyarAPI
    private var callSessionID: String?
    private var pollTask: Task<Void, Never>?
    private var roomDelegate: RoomObserver?

    init(
        invitation: CallInvitation,
        contactName: String,
        contactAvatarURL: String?,
        api: any WebyarAPI = Backend.current
    ) {
        self.invitationID = invitation.id
        self.channel = invitation.kind
        self.isCameraOn = invitation.kind == .video
        self.contactName = contactName
        self.contactAvatarURL = contactAvatarURL
        self.api = api
    }

    // MARK: - Lifecycle

    /// Waits for the visitor, then joins.
    ///
    /// Polling rather than realtime on purpose: the app has no realtime
    /// transport yet, an invitation lives for five minutes, and a request
    /// every two seconds for at most that long is cheaper to build and to
    /// reason about than a socket that exists for this one screen.
    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            await self?.waitForVisitor()
        }
    }

    private func waitForVisitor() async {
        while !Task.isCancelled, phase == .waiting {
            do {
                let invitation = try await api.invitation(id: invitationID)
                if let sessionID = invitation.callSessionId, invitation.isJoined {
                    callSessionID = sessionID
                    await join(callSessionID: sessionID)
                    return
                }
                if invitation.isTerminal {
                    phase = .ended(invitation.status == "declined" ? .declined : .expired)
                    return
                }
            } catch {
                // A single failed poll is a blip, not an answer. Only a
                // terminal invitation or the operator ends the wait.
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private func join(callSessionID: String) async {
        phase = .connecting
        do {
            let credentials = try await api.callToken(
                callSessionID: callSessionID,
                displayName: nil
            )
            relayWarning = credentials.warnings?.contains("turn_missing") == true

            guard let url = credentials.signallingURL else {
                phase = .ended(.failed("no_server_url"))
                return
            }

            configureAudioSession()

            let room = Room()
            let observer = RoomObserver(session: self)
            room.add(delegate: observer)
            roomDelegate = observer
            self.room = room

            try await room.connect(
                url: url,
                token: credentials.token,
                connectOptions: ConnectOptions(
                    iceServers: iceServers(from: credentials),
                    iceTransportPolicy: credentials.relayOnly ? .relay : .all
                ),
                roomOptions: RoomOptions(
                    defaultCameraCaptureOptions: CameraCaptureOptions(
                        position: .front,
                        dimensions: .h720_169
                    ),
                    adaptiveStream: true,
                    dynacast: true
                )
            )

            try await room.localParticipant.setMicrophone(enabled: true)
            if channel == .video {
                try await room.localParticipant.setCamera(enabled: true)
            }

            phase = .connected
            connectedAt = Date()
            refreshVisitorPresence()
        } catch {
            phase = .ended(.failed(String(describing: error)))
            await teardown()
        }
    }

    private func iceServers(from credentials: CallToken) -> [IceServer] {
        guard let turn = credentials.turn, let urls = turn.urls, !urls.isEmpty else { return [] }
        return [
            IceServer(
                urls: urls,
                username: turn.username ?? "",
                credential: turn.credential ?? ""
            ),
        ]
    }

    // MARK: - Controls

    func toggleMute() {
        guard let room else { return }
        let next = !isMuted
        isMuted = next
        Task { try? await room.localParticipant.setMicrophone(enabled: !next) }
    }

    func toggleCamera() {
        guard let room, channel == .video else { return }
        let next = !isCameraOn
        isCameraOn = next
        Task { try? await room.localParticipant.setCamera(enabled: next) }
    }

    /// Earpiece or loudspeaker. A voice call starts on the loudspeaker
    /// because the operator is at a desk, not holding the phone to their ear.
    func toggleSpeaker() {
        isSpeakerOn.toggle()
        let session = AVAudioSession.sharedInstance()
        try? session.overrideOutputAudioPort(isSpeakerOn ? .speaker : .none)
    }

    /// Ends the call for both sides.
    func hangUp() async {
        pollTask?.cancel()
        pollTask = nil
        if let callSessionID {
            try? await api.hangUp(callSessionID: callSessionID)
        } else {
            // Never answered: there is no session to end, only an offer to
            // withdraw.
            try? await api.cancelInvitation(id: invitationID)
        }
        phase = .ended(.hungUp)
        await teardown()
    }

    /// Called when the room tells us the other side has gone.
    fileprivate func visitorDisconnected() {
        guard phase.isLive else { return }
        phase = .ended(.visitorLeft)
        Task { await teardown() }
    }

    fileprivate func refreshVisitorPresence() {
        visitorPresent = !(room?.remoteParticipants.isEmpty ?? true)
    }

    private func teardown() async {
        await room?.disconnect()
        room = nil
        roomDelegate = nil
        // Handing the session back is what lets other audio — music, a real
        // phone call — resume instead of staying ducked forever.
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }

    // MARK: - Audio

    /// `.voiceChat` is what turns on echo cancellation, noise suppression and
    /// the earpiece/loudspeaker routing a call needs. It also implies
    /// Bluetooth HFP, so a headset works without asking for it by name.
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetoothA2DP, .defaultToSpeaker]
        )
        try? session.setActive(true)
    }
}

/// LiveKit talks to its delegate on its own queue; this hops each event onto
/// the main actor, where the session's state lives.
private final class RoomObserver: RoomDelegate, @unchecked Sendable {
    private weak var session: CallSession?

    init(session: CallSession) {
        self.session = session
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor [weak session] in session?.refreshVisitorPresence() }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        Task { @MainActor [weak session] in
            session?.refreshVisitorPresence()
            // The visitor leaving the room ends the call: there is nobody
            // else it could be, and an operator left listening to silence
            // would have to work out for themselves that it was over.
            session?.visitorDisconnected()
        }
    }

    func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        guard connectionState == .disconnected else { return }
        Task { @MainActor [weak session] in session?.visitorDisconnected() }
    }
}
