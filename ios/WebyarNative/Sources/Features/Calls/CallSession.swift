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

/// A call that connected, but not with everything it was supposed to carry.
///
/// Worth its own type rather than a boolean: an operator who cannot be heard
/// and an operator who cannot be seen have different problems, and telling
/// them "something went wrong" helps with neither.
enum CallDegradation: Equatable, Sendable {
    /// The microphone would not start — permission, or another app holding it.
    case noMicrophone
    /// The camera would not start. The call carries on as audio.
    case noCamera

    func title(_ language: Language) -> String {
        switch self {
        case .noMicrophone: Str.callNoMicrophone(language)
        case .noCamera: Str.callNoCamera(language)
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
    /// Set when the call connected but something could not be published.
    private(set) var degraded: CallDegradation?

    let channel: CallChannel
    let contactName: String
    let contactAvatarURL: String?

    /// The room, once there is one. `nil` outside a connected call, which is
    /// also what releases the microphone.
    private(set) var room: Room?

    /// The two pictures, held here rather than read out of `Room` whenever a
    /// view happens to redraw.
    ///
    /// `Room` is a LiveKit object; SwiftUI does not observe it. A view that
    /// reaches into `room.remoteParticipants` therefore only ever sees what
    /// was true the last time something *else* invalidated it — so a visitor
    /// who switches their camera on a moment after answering stays invisible
    /// until, by luck, some unrelated state changes. Keeping the tracks in
    /// observed properties and updating them from the room's own events is
    /// what makes the picture arrive when it actually arrives.
    private(set) var remoteVideoTrack: VideoTrack?
    private(set) var localVideoTrack: VideoTrack?

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

            // No audio-session setup here: `AudioManager` inside the SDK owns
            // the session and configures `.playAndRecord` itself. Doing it by
            // hand is what made the engine tear down and rebuild mid-call.
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

            // Publishing is best-effort, deliberately. A camera that will not
            // start — no camera at all on the simulator, permission refused,
            // another app holding it — is a reason to carry on without video,
            // not a reason to drop a call the visitor has already answered.
            // Before this, one throw here took the whole call down.
            do {
                try await room.localParticipant.setMicrophone(enabled: true)
            } catch {
                isMuted = true
                degraded = .noMicrophone
            }

            if channel == .video {
                do {
                    try await room.localParticipant.setCamera(enabled: true)
                } catch {
                    isCameraOn = false
                    if degraded == nil { degraded = .noCamera }
                }
            }

            phase = .connected
            connectedAt = Date()
            refreshVisitorPresence()
            syncTracks()
        } catch {
            // Only a failure to reach the room itself gets here now.
            await finish(.failed(Self.describe(error)))
        }
    }

    /// LiveKit errors stringify into a paragraph. The operator needs the one
    /// sentence, and the log keeps the rest.
    private static func describe(_ error: Error) -> String {
        if let error = error as? LiveKitError { return error.message ?? "\(error.type)" }
        return (error as NSError).localizedDescription
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
    ///
    /// Routed through LiveKit rather than `AVAudioSession` directly: the SDK
    /// owns the session's configuration, and overriding the port behind its
    /// back made the audio engine tear itself down and rebuild mid-call.
    func toggleSpeaker() {
        isSpeakerOn.toggle()
        AudioManager.shared.isSpeakerOutputPreferred = isSpeakerOn
    }

    /// Ends the call for both sides.
    func hangUp() async {
        await finish(.hungUp)
    }

    /// Called when the room tells us the other side has gone.
    fileprivate func visitorDisconnected() {
        guard phase.isLive else { return }
        Task { await finish(.visitorLeft) }
    }

    /// The single way a call ends.
    ///
    /// Every path goes through here because the server has to be told on all
    /// of them — including the ones that failed. It was not, and the evidence
    /// was two call sessions left in `connecting` forever: the app had given
    /// up, the visitor's browser had not, and the platform still counted a
    /// call that nobody was on.
    private func finish(_ outcome: CallOutcome) async {
        guard phase.isLive else { return }
        phase = .ended(outcome)
        pollTask?.cancel()
        pollTask = nil

        if let callSessionID {
            // Idempotent server-side, which is what makes it safe to send
            // even when the visitor hung up first and the call is already
            // over as far as the server is concerned.
            try? await api.hangUp(callSessionID: callSessionID)
        } else {
            // Never answered: there is no session to end, only an offer to
            // withdraw.
            try? await api.cancelInvitation(id: invitationID)
        }
        await teardown()
    }

    fileprivate func refreshVisitorPresence() {
        visitorPresent = !(room?.remoteParticipants.isEmpty ?? true)
    }

    /// Re-reads which cameras are actually sending. Cheap enough to call from
    /// every event that could change the answer, which is exactly what the
    /// room observer does.
    ///
    /// A muted publication counts as no picture: that is what the other side
    /// turning their camera off looks like on the wire, and showing a frozen
    /// last frame would be worse than showing their face.
    fileprivate func syncTracks() {
        guard let room else {
            remoteVideoTrack = nil
            localVideoTrack = nil
            return
        }
        let remote = room.remoteParticipants.values.flatMap(\.videoTracks)
        remoteVideoTrack = remote.first { $0.isSubscribed && !$0.isMuted }?.track as? VideoTrack
        localVideoTrack = room.localParticipant.videoTracks.first { !$0.isMuted }?.track as? VideoTrack
    }

    private func teardown() async {
        if let room {
            // Unpublish before disconnecting. Tearing the room down with a
            // capturer still running leaves the camera light on and makes the
            // SDK complain that it was deinitialised mid-capture.
            _ = try? await room.localParticipant.setCamera(enabled: false)
            _ = try? await room.localParticipant.setMicrophone(enabled: false)
            await room.disconnect()
        }
        room = nil
        roomDelegate = nil
        syncTracks()
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

    // Everything that can change what is on screen. Subscribing to the
    // visitor's camera is the one that matters most — it is the event that
    // says their picture is ready — but a camera switched off mid-call, and
    // our own publication completing, change the layout too.

    func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        syncTracks()
    }

    func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        syncTracks()
    }

    func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
        syncTracks()
    }

    func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        syncTracks()
    }

    func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) {
        syncTracks()
    }

    private func syncTracks() {
        Task { @MainActor [weak session] in session?.syncTracks() }
    }
}
