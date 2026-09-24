import AVFoundation
import Foundation
import LiveKit
import Observation

/// Where a call is in its life: one value, so "connecting and also ended" cannot happen.
enum CallPhase: Equatable {
    /// The invitation is out (or, on the desk, the room is being opened).
    case waiting
    /// The visitor answered; joining the room.
    case connecting
    /// Both sides are in.
    case connected
    /// Over, for the stated reason.
    case ended(CallOutcome)

    var isLive: Bool {
        if case .ended = self { return false }
        return true
    }
}

/// How a call finished — each reads differently to the operator.
enum CallOutcome: Equatable {
    case hungUp
    case visitorLeft
    case declined
    case expired
    case failed
    /// Handed to a colleague: this operator left, the call goes on without them.
    case transferred

    var textKey: String {
        switch self {
        case .declined: return "callDeclined"
        case .expired: return "callNoAnswer"
        case .failed: return "callFailed"
        case .hungUp, .visitorLeft: return "callEnded"
        case .transferred: return "callTransferredOut"
        }
    }
}

/// A note shown beside the call: the call's own notes on the desk, the
/// conversation's internal notes on a call made from a conversation.
struct CallWindowNote: Identifiable, Hashable {
    let id: String
    let text: String
    let author: String?
    let at: Date?
}

/// One call with a visitor, from the invitation to the room closing — the
/// Windows CallWindow's logic with the LiveKit Swift SDK in place of its
/// WebView2 page. An operator never dials a visitor directly: the invitation
/// is the offer, the widget accepts it, and only then does a room exist — so
/// this waits on the invitation, then joins the room with the token the web
/// console would get. A call answered on the call-center desk skips the wait:
/// the server already made the room and gave us its token.
@MainActor
@Observable
final class LiveCall {
    struct Desk {
        let callId: String
        let accept: CallAccept
    }

    @ObservationIgnored unowned let app: AppModel
    let channel: String
    let name: String
    let conversation: Conversation?
    let desk: Desk?
    let workspaceId: String

    private(set) var phase: CallPhase = .waiting
    private(set) var isMuted = false
    private(set) var isCameraOn: Bool
    /// When the two sides connected: what the timer counts from.
    private(set) var connectedAt: Date?
    /// The string key of the notice over the call (relay missing, no microphone, no camera).
    private(set) var warningKey: String?
    /// macOS refused the microphone or camera: say where to allow it.
    private(set) var mediaBlocked: AVMediaType?
    /// The call session once there is one (the desk call's id from the start).
    private(set) var sessionId: String?
    /// The two pictures, updated from the room's events (SwiftUI does not observe `Room`).
    private(set) var remoteVideoTrack: VideoTrack?
    private(set) var localVideoTrack: VideoTrack?

    // Transfer and notes

    /// Handed to this colleague (or department): the window says so and stays until they join.
    private(set) var transferredTo: String?
    private(set) var transferring = false
    /// Why the last transfer failed, for the transfer panel.
    private(set) var transferError: String?
    /// The colleague the call was handed to is in the room: this operator is about to leave.
    private(set) var handoverJoined = false
    /// Newest read of the notes; nil until the first one arrives.
    private(set) var notes: [CallWindowNote]?
    var noteDraft = ""
    private(set) var addingNote = false
    private(set) var noteError: String?
    @ObservationIgnored private var transferTargetId: String?
    @ObservationIgnored private var notesTask: Task<Void, Never>?
    @ObservationIgnored private var handoverTask: Task<Void, Never>?

    /// Only a call-center call can be handed on (the server's transfer is the desk's).
    var canTransfer: Bool { desk != nil }
    /// The desk call has its own notes; a conversation call shows the conversation's.
    var hasNotes: Bool { desk != nil || conversation != nil }

    /// Called once the ended call has shown why for a moment: closes the window.
    @ObservationIgnored var onFinished: (() -> Void)?

    @ObservationIgnored private var room: Room?
    @ObservationIgnored private var observer: CallRoomObserver?
    @ObservationIgnored private var invitation: CallInvitation?
    @ObservationIgnored private var runTask: Task<Void, Never>?
    @ObservationIgnored private var leftTask: Task<Void, Never>?
    @ObservationIgnored private var accessTask: Task<MediaAccess, Never>?
    @ObservationIgnored private var ended = false

    var isVideo: Bool { channel == "video" }
    var isEnded: Bool { ended }

    init(app: AppModel, conversation: Conversation?, desk: Desk?, workspaceId: String, channel: String, name: String) {
        self.app = app
        self.conversation = conversation
        self.desk = desk
        self.workspaceId = workspaceId
        self.channel = channel
        self.name = name
        isCameraOn = channel == "video"
        sessionId = desk?.callId
    }

    // MARK: Lifecycle

    func start() {
        guard runTask == nil else { return }
        // Ask macOS for the microphone (and camera) while the visitor is still being rung,
        // so the prompt never holds up a call that has already been answered.
        let video = isVideo
        accessTask = Task { await Self.requestAccess(video: video) }
        runTask = Task { [weak self] in await self?.run() }
        if hasNotes { startNotes() }
    }

    private func run() async {
        #if DEBUG
        if desk != nil, DebugTools.sample {
            // Sample mode has no media server: show the desk call as if it had connected.
            phase = .connected
            connectedAt = Date()
            return
        }
        #endif
        if let desk {
            // Accepted on the desk: the server made the room and gave us its token.
            guard desk.accept.connect?.supported == true,
                  let url = desk.accept.connect?.serverUrl, !url.isEmpty,
                  let token = desk.accept.token, !token.isEmpty else {
                finish(.failed, desk.accept.connect?.reason ?? "no_server_url")
                return
            }
            await join(url: url, token: token, ice: [], relay: false)
            return
        }
        guard let conversation else { return }
        do {
            // Not cancelled with the call: hung up while this is on its way, the server may still
            // make the invitation, and it is withdrawn below rather than left ringing the visitor.
            let api = app.api, conversationId = conversation.id, workspaceId = workspaceId, channel = channel
            let inv = try await Task { try await api.inviteToCall(conversationId: conversationId, workspaceId: workspaceId, channel: channel) }.value
            invitation = inv
            Log.write("[call] invited \(inv.id) \(channel)")
            if ended {
                try? await api.cancelInvitation(inv.id)
                return
            }
            // Two seconds for as long as the invitation lives — cheaper than a realtime channel for one wait.
            while !Task.isCancelled && !ended {
                let current = try await app.api.invitation(inv.id)
                if let session = current.callSessionId, current.status == "joined" {
                    sessionId = session
                    try await joinSession(session)
                    return
                }
                let status = current.status ?? ""
                if status == "expired" || status == "cancelled" || status == "declined" {
                    finish(status == "declined" ? .declined : .expired, nil)
                    return
                }
                try await Task.sleep(nanoseconds: 2_000_000_000)
            }
        } catch {
            if ended || error is CancellationError { return }
            Log.error("call invite", error)
            finish(.failed, "\(error)")
        }
    }

    /// The visitor joined: mint the operator's token for the room, as the web console does.
    private func joinSession(_ session: String) async throws {
        phase = .connecting
        var me: String? = app.user?.email
        if let n = app.user?.fullName, !n.isEmpty { me = n }
        let token = try await app.api.callToken(callSessionId: session, displayName: me)
        guard !ended else { return }
        guard let url = token.wsUrl ?? token.rtcUrl, !url.isEmpty else {
            finish(.failed, "no_server_url")
            return
        }
        if token.warnings?.contains("turn_missing") == true { warningKey = "callRelayWarning" }
        var ice: [IceServer] = []
        if let turn = token.turn, let urls = turn.urls, !urls.isEmpty {
            ice = [IceServer(urls: urls, username: turn.username ?? "", credential: turn.credential ?? "")]
        }
        await join(url: url, token: token.token, ice: ice, relay: token.icePolicy == "relay")
    }

    private func join(url: String, token: String, ice: [IceServer], relay: Bool) async {
        phase = .connecting
        let room = Room()
        let observer = CallRoomObserver(call: self)
        room.add(delegate: observer)
        self.room = room
        self.observer = observer
        // Only a relay policy with a TURN server: an empty list keeps the server's own ICE servers.
        let connectOptions = ConnectOptions(iceServers: ice, iceTransportPolicy: relay && !ice.isEmpty ? .relay : .all)
        let roomOptions = RoomOptions(
            defaultCameraCaptureOptions: CameraCaptureOptions(dimensions: .h720_169),
            adaptiveStream: true,
            dynacast: true
        )
        Log.write("[call] joining \(URL(string: url)?.host ?? "?") ice=\(ice.count) relay=\(relay)")
        do {
            try await room.connect(url: url, token: token, connectOptions: connectOptions, roomOptions: roomOptions)
        } catch {
            finish(.failed, Self.describe(error))
            return
        }
        guard !ended else { return }

        // Publishing is best-effort: a microphone or camera that will not start is a
        // reason to carry on and say so, not to drop a call the visitor already answered.
        let access = await accessTask?.value ?? MediaAccess(microphone: true, camera: true)
        guard !ended else { return }
        if access.microphone {
            do {
                try await room.localParticipant.setMicrophone(enabled: true)
            } catch {
                Log.error("call microphone", error)
                isMuted = true
                warningKey = "callNoMicrophone"
            }
        } else {
            isMuted = true
            warningKey = "callNoMicrophone"
            mediaBlocked = .audio
        }
        if isVideo {
            if access.camera {
                do {
                    try await room.localParticipant.setCamera(enabled: true)
                } catch {
                    Log.error("call camera", error)
                    isCameraOn = false
                    warningKey = "callNoCamera"
                }
            } else {
                isCameraOn = false
                warningKey = "callNoCamera"
                if mediaBlocked == nil { mediaBlocked = .video }
            }
        }
        guard !ended else { return }
        phase = .connected
        connectedAt = Date()
        Log.write("[call] connected \(sessionId ?? "")")
        syncTracks()
    }

    // MARK: Controls

    func toggleMute() {
        guard let room, phase == .connected else { return }
        let next = !isMuted
        isMuted = next
        Task { _ = try? await room.localParticipant.setMicrophone(enabled: !next) }
    }

    func toggleCamera() {
        guard let room, isVideo, phase == .connected else { return }
        let next = !isCameraOn
        isCameraOn = next
        Task { _ = try? await room.localParticipant.setCamera(enabled: next) }
    }

    func hangUp() {
        finish(.hungUp, nil)
    }

    // MARK: Room events

    /// A reconnect drops and re-adds everyone, so an empty room only means
    /// "the visitor left" after a grace period.
    fileprivate func checkLeft() {
        leftTask?.cancel()
        leftTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled, let self, let room = self.room else { return }
            if room.connectionState == .connected && room.remoteParticipants.isEmpty {
                self.finish(.visitorLeft, nil)
            }
        }
    }

    fileprivate func roomDisconnected() {
        guard !ended, phase == .connected else { return }
        finish(.visitorLeft, nil)
    }

    /// Re-reads which cameras are actually sending. A muted publication counts as no picture.
    fileprivate func syncTracks() {
        guard let room else {
            remoteVideoTrack = nil
            localVideoTrack = nil
            return
        }
        // The visitor's camera first: a colleague joining a handed-over call is not who the operator is talking to.
        let people = room.remoteParticipants.values.sorted { !Self.isOperator($0) && Self.isOperator($1) }
        let remote: [TrackPublication] = people.flatMap { $0.videoTracks }
        remoteVideoTrack = remote.first { $0.isSubscribed && !$0.isMuted }?.track as? VideoTrack
        localVideoTrack = room.localParticipant.videoTracks.first { !$0.isMuted }?.track as? VideoTrack
        checkHandover()
    }

    /// Operators join as `operator:<user id>` (the server's LiveKit identity); visitors as something else.
    private static func isOperator(_ p: Participant) -> Bool {
        p.identity?.stringValue.hasPrefix("operator:") == true
    }

    #if DEBUG
    /// A panel of the call window to open, for DebugTools (`callui notes|transfer`).
    var debugOpen: String?
    #endif

    // MARK: Transfer

    /// Hands the desk call to a colleague or a department. The call goes on: whoever takes it
    /// joins this same room, and this operator leaves once they are in (or when they choose).
    @discardableResult
    func transfer(toAgent agentId: String?, department departmentId: String?, name: String, reason: String?) async -> Bool {
        guard let callId = desk?.callId, !transferring, !ended else { return false }
        transferring = true
        transferError = nil
        defer { transferring = false }
        do {
            try await app.api.transferCall(workspaceId: workspaceId, callId: callId, toAgentId: agentId,
                                           toDepartmentId: departmentId, reason: reason)
            Log.write("[call] transferred \(callId) to \(agentId ?? departmentId ?? "?")")
            transferTargetId = agentId
            transferredTo = name
            checkHandover()
            return true
        } catch {
            Log.error("call transfer", error)
            transferError = ErrorText.of(error, app.strings)
            return false
        }
    }

    /// Leaves a handed-over call without ending it for the visitor and the colleague.
    func leave() {
        finish(.transferred, nil)
    }

    /// After a transfer: the colleague is in the room, so step out a moment later.
    private func checkHandover() {
        guard transferredTo != nil, !handoverJoined, !ended, let room else { return }
        let me = room.localParticipant.identity?.stringValue
        let joined = room.remoteParticipants.values.contains { p in
            guard Self.isOperator(p), let id = p.identity?.stringValue, id != me else { return false }
            return transferTargetId.map { id == "operator:\($0)" } ?? true
        }
        guard joined else { return }
        handoverJoined = true
        Log.write("[call] colleague joined, leaving")
        handoverTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard !Task.isCancelled else { return }
            self?.leave()
        }
    }

    // MARK: Notes

    /// Reads the notes now and every few seconds, so a note a colleague adds shows up here.
    private func startNotes() {
        notesTask?.cancel()
        notesTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.loadNotes()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    func loadNotes() async {
        do {
            var list: [CallWindowNote] = []
            if let callId = desk?.callId {
                list = try await app.api.callNotes(workspaceId: workspaceId, callId: callId)
                    .map { CallWindowNote(id: $0.id, text: $0.note, author: $0.authorName, at: $0.createdAt) }
            } else if let conversation {
                list = try await app.api.notes(conversationId: conversation.id, workspaceId: workspaceId)
                    .map { n in
                        let author = n.author?.fullName ?? n.author?.email ?? n.authorId.map { app.memberName($0) }
                        return CallWindowNote(id: n.id, text: n.body, author: author, at: n.createdAt)
                    }
            }
            notes = list.sorted { ($0.at ?? .distantPast) < ($1.at ?? .distantPast) }
        } catch {
            if error is CancellationError { return }
            if notes == nil { notes = [] }
            Log.error("call notes", error)
        }
    }

    func addNote() async {
        let text = noteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !addingNote else { return }
        addingNote = true
        noteError = nil
        defer { addingNote = false }
        do {
            if let callId = desk?.callId {
                try await app.api.addCallNote(workspaceId: workspaceId, callId: callId, note: text)
            } else if let conversation {
                try await app.api.addNote(conversationId: conversation.id, workspaceId: workspaceId, body: text)
            }
            noteDraft = ""
            await loadNotes()
        } catch {
            Log.error("call note", error)
            noteError = ErrorText.of(error, app.strings)
        }
    }

    // MARK: Ending

    /// The single way a call ends: the server is told on every path, including the failed ones.
    /// The telling runs in a task of its own, so ending from inside the (now cancelled) wait still reaches the server.
    func finish(_ outcome: CallOutcome, _ detail: String?) {
        guard !ended else { return }
        ended = true
        runTask?.cancel()
        leftTask?.cancel()
        handoverTask?.cancel()
        notesTask?.cancel()
        Log.write("[call] ended \(outcome) \(detail ?? "")")
        phase = .ended(outcome)
        let room = self.room
        self.room = nil
        observer = nil
        syncTracks()
        if let room {
            Task {
                // Unpublish before disconnecting, so the camera light goes off.
                _ = try? await room.localParticipant.setCamera(enabled: false)
                _ = try? await room.localParticipant.setMicrophone(enabled: false)
                await room.disconnect()
            }
        }
        Task { await self.tellServer(outcome) }
    }

    private func tellServer(_ outcome: CallOutcome) async {
        // Ending is idempotent server-side, so a race with the visitor's own hang-up is harmless.
        do {
            if outcome == .transferred {
                // Handed on: the call is the colleague's now, and it goes on without this operator.
            } else if let desk {
                try await app.api.endCall(workspaceId: workspaceId, callId: desk.callId)
            } else if let sessionId {
                try await app.api.hangUp(callSessionId: sessionId)
            } else if let invitation {
                try await app.api.cancelInvitation(invitation.id)
            }
        } catch let e as ApiError where e.serverMessage == "call_not_active" || (e.body?.contains("call_not_active") ?? false) {
            // The visitor hung up first: the call is already over, nothing to end.
        } catch {
            Log.error("call hang up", error)
        }
        // An ended call says why for a moment, then gets out of the way.
        let pause: UInt64 = outcome == .failed ? 4_000_000_000 : 1_800_000_000
        try? await Task.sleep(nanoseconds: pause)
        onFinished?()
    }

    // MARK: Helpers

    struct MediaAccess {
        var microphone: Bool
        var camera: Bool
    }

    private static func requestAccess(video: Bool) async -> MediaAccess {
        let mic = await allowed(.audio)
        var cam = true
        if video { cam = await allowed(.video) }
        return MediaAccess(microphone: mic, camera: cam)
    }

    private static func allowed(_ type: AVMediaType) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: type)
        default: return false
        }
    }

    /// LiveKit errors stringify into a paragraph; the log keeps the one sentence.
    private static func describe(_ error: Error) -> String {
        if let e = error as? LiveKitError { return e.message ?? "\(e.type)" }
        return (error as NSError).localizedDescription
    }
}

/// LiveKit talks to its delegate on its own queue; this hops each event onto the main actor.
private final class CallRoomObserver: RoomDelegate, @unchecked Sendable {
    private weak var call: LiveCall?

    init(call: LiveCall) {
        self.call = call
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        sync()
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        Task { @MainActor [weak call] in
            call?.syncTracks()
            call?.checkLeft()
        }
    }

    func room(_ room: Room, didCompleteReconnectWithMode reconnectMode: ReconnectMode) {
        Task { @MainActor [weak call] in call?.checkLeft() }
    }

    func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        guard connectionState == .disconnected else { return }
        Task { @MainActor [weak call] in call?.roomDisconnected() }
    }

    func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        sync()
    }

    func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        sync()
    }

    func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
        sync()
    }

    func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        sync()
    }

    func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) {
        sync()
    }

    private func sync() {
        Task { @MainActor [weak call] in call?.syncTracks() }
    }
}
