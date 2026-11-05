import AVFoundation
import CallKit
import Foundation
import LiveKit
import Observation
import UIKit

/// A colleague call on this phone, as the call screen draws it.
///
/// One value, so the screen and CallKit read the same thing: which call,
/// which side, where it is, and the state of the controls.
struct ActiveTeamCall: Equatable, Sendable {
    enum Direction: Equatable, Sendable {
        /// A colleague rang this phone (a VoIP push).
        case incoming
        /// Placed from a colleague's thread.
        case outgoing
    }

    enum Phase: Equatable, Sendable {
        /// Outgoing: the request to ring is on its way.
        case calling
        /// The colleague's phones are ringing (outgoing), or this one is.
        case ringing
        /// Answered; the room is being joined.
        case connecting
        /// Both in the room, since then.
        case live(since: Date)
        /// Over, for the stated reason.
        case ended(TeamCallEnd)

        var isOver: Bool {
            if case .ended = self { return true }
            return false
        }
    }

    /// CallKit's key for the call: the call id itself for a ring (so a
    /// second push for the same call is the same call), a fresh one for a
    /// call placed here — it exists before the server has named the call.
    let uuid: UUID
    /// The server's call id; nil while an outgoing call is being placed.
    var callID: String?
    let direction: Direction
    let channel: CallChannel
    /// The colleague's profile name, nil without one: from the ring for a
    /// call rung here, from the colleague's thread for one placed here.
    let peerProfileName: String?
    let peerAvatarURL: String?
    var phase: Phase
    /// The answer is the server's: this phone's accept went through
    /// (incoming), or the colleague answered (outgoing).
    var answered = false
    /// CallKit has the call: a ring was reported, or the start action
    /// performed. Before that, CallKit's actions cannot reach it.
    var knownToCallKit: Bool
    var isMuted = false
    /// A voice call starts on the earpiece, a video call on the loudspeaker.
    var isSpeakerOn: Bool
    var isCameraOn: Bool
    /// Connected, without everything it was meant to carry.
    var degraded: CallDegradation?
    /// The server warned that TURN is not configured.
    var relayWarning = false

    var isRinging: Bool { phase == .calling || phase == .ringing }

    var isLive: Bool {
        if case .live = phase { return true }
        return false
    }

    /// The colleague, as the call screen and CallKit name them
    /// (`TeamCallName`).
    func peerName(_ language: Language) -> String {
        TeamCallName.shown(peerProfileName, language)
    }
}

/// What this phone tells the server when a call ends here, and the end is
/// this phone's news (`CallManager.finish`).
///
/// Decided by what this phone knows, which may be behind the server: an
/// answer reaches the caller's phone at its next poll or realtime nudge, and
/// this phone's own answer is on its way for a moment. So the requests are
/// the ones whose meaning the server settles by the call's state when they
/// land, and none of them can end a call the member's other phone holds.
enum TeamCallNotice: Equatable, Sendable {
    /// `POST /hangup`. Always, from the caller's phone: while the colleague's
    /// phones ring the server makes it a cancel, and once they have answered
    /// it ends the call for both — where `POST /cancel` would do nothing and
    /// leave the colleague talking to an empty room. And from the callee's
    /// phone once its own answer went through.
    case hangUp
    /// `POST /decline`: the callee's phone, while it rings. A no-op on a call
    /// already answered, so a Decline here never ends one the member's other
    /// phone has just picked up — which a hang-up would.
    case decline
    /// Not yet: this phone's answer is on its way, or came to nothing it can
    /// read. Whose the call is comes first — it is hung up only if the server
    /// says it is this phone's (`TeamCallAcceptance.isWon(by:)`), and left
    /// alone otherwise, for the member's other phone.
    case afterTheAnswer

    /// Read before the call is marked ended.
    static func leaving(_ call: ActiveTeamCall) -> TeamCallNotice {
        switch call.direction {
        case .outgoing:
            return .hangUp
        case .incoming:
            if call.answered { return .hangUp }
            return call.phase == .ringing ? .decline : .afterTheAnswer
        }
    }
}

/// Every colleague call on this phone, from the ring (or the tap on a
/// colleague's thread) to the room closing. One, app-wide.
///
/// It owns what a call is made of — CallKit's provider and controller
/// (`CallKitBridge`), the room (`TeamCallRoom`), the polling, the server's
/// answers — and the state the call screen draws (`call`), which is why the
/// screen is drawn above everything from here (`TeamCallWindow`): a call
/// answered on the lock screen, before the app had a single view, has a
/// screen when the app opens.
///
/// It depends on nothing the app's views set up. A VoIP push can launch the
/// app with no scene at all; the session token is the Keychain's
/// (`APIClient` reads it when it is made, and again while it holds none —
/// before the phone's first unlock it cannot be read), the origin is the
/// stored one (`PlatformOrigin`), the language CallKit names the colleague
/// in is the stored one (`AppState.storedLanguage()`), and this device's id
/// is `PushController`'s — none of it waits for `RootView`'s launch task.
///
/// The rules it keeps (docs/operations/TEAM_CALLS.md):
/// - every VoIP push is reported to CallKit at once; one that is not a live
///   colleague ring for whoever is signed in here is ended at once;
/// - while it rings it asks the server every two seconds, and listens on the
///   member's own channel when the app is open; the server never sends a
///   VoIP push to stop a ring;
/// - CallKit owns the audio session; LiveKit's engine waits for its
///   `didActivate` (`TeamCallAudio`).
@MainActor
@Observable
final class CallManager {
    static let shared = CallManager()

    /// The call on screen, if any; an ended one lingers a moment so its
    /// outcome can be read.
    private(set) var call: ActiveTeamCall?
    /// The colleague's camera and this phone's own, held here for SwiftUI to
    /// observe (`TeamCallRoom` explains why not read from the room).
    private(set) var remoteVideo: VideoTrack?
    private(set) var localVideo: VideoTrack?

    @ObservationIgnored private let api: any WebyarAPI
    @ObservationIgnored private let callKit: CallKitBridge
    /// The room of the call being joined or held; a fresh one per call, so
    /// the last call's teardown can never reach the next one's.
    @ObservationIgnored private var room: TeamCallRoom?
    /// CallKit's answer, held until the server has taken it: fulfilled when
    /// this phone won the answer, failed when it did not.
    @ObservationIgnored private var pendingAnswer: CXAnswerCallAction?
    /// This phone's answer on its way to the server (`POST /accept`); its
    /// value is nil when it did not come back, so whether it landed is not
    /// known. Kept so that a call ended here meanwhile can still be hung up
    /// once the answer says it was this phone's (`TeamCallNotice`).
    @ObservationIgnored private var answering: Task<TeamCallAcceptance?, Never>?
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var ringTimer: Task<Void, Never>?
    @ObservationIgnored private var joinTimer: Task<Void, Never>?
    @ObservationIgnored private var clearTimer: Task<Void, Never>?
    @ObservationIgnored private var signals: Task<Void, Never>?

    /// Asked every two seconds while ringing, as the contract says; once
    /// answered, every ten — a safety net under the room's own events, for a
    /// call the server ends on its own (a limit, the webhook).
    private static let ringingPoll: TimeInterval = 2
    private static let answeredPoll: TimeInterval = 10
    /// An answered call whose room has not brought the two together by then
    /// is not going to.
    private static let joinTimeout: TimeInterval = 30
    /// How long an ended call stays on screen.
    private static let endedLinger: TimeInterval = 2

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
        callKit = CallKitBridge(configuration: Self.providerConfiguration())
        callKit.manager = self
        listenForSignals()
    }

    /// The id this phone answers with, and the one the server compares
    /// `answered_device_id` against for the callee's other phones.
    private var deviceID: String { PushController.shared.deviceID }

    /// A call holds the audio: one that has not ended.
    private var holdsAudio: Bool { call.map { !$0.phase.isOver } ?? false }

    /// The language CallKit names the colleague in: the app's, as stored —
    /// a ring can launch the app with no scene and no `AppState`.
    private static var language: Language { AppState.storedLanguage() }

    // MARK: - CallKit's provider

    /// Video, one call at a time, the call id as an opaque handle, nothing in
    /// the phone's Recents (a colleague's name is not a phone number), and the
    /// brand mark on CallKit's screen.
    private static func providerConfiguration() -> CXProviderConfiguration {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = false
        configuration.iconTemplateImageData = brandMarkTemplate()
        return configuration
    }

    /// The asset catalog's `BrandMark` (both brands have one), drawn at the
    /// 40-point square CallKit asks for. CallKit reads only its alpha.
    private static func brandMarkTemplate() -> Data? {
        guard let mark = UIImage(named: "BrandMark"), mark.size.width > 0, mark.size.height > 0 else { return nil }
        let side: CGFloat = 40
        let scale = min(side / mark.size.width, side / mark.size.height)
        let size = CGSize(width: mark.size.width * scale, height: mark.size.height * scale)
        let image = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            mark.draw(in: CGRect(x: (side - size.width) / 2, y: (side - size.height) / 2, width: size.width, height: size.height))
        }
        return image.pngData()
    }

    /// What CallKit shows for a call: the colleague's name, the call id as
    /// the handle — never an e-mail or a user id — and no holding, grouping
    /// or keypad, none of which a colleague call has.
    private static func update(callID: String, name: String, video: Bool) -> CXCallUpdate {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callID)
        update.localizedCallerName = name
        update.hasVideo = video
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        return update
    }

    // MARK: - A ring (VoIP push)

    /// Called by `VoIPPushes` for every VoIP push, synchronously, before the
    /// push is done with.
    ///
    /// Every one is reported to CallKit — iOS's condition for delivering VoIP
    /// pushes at all. One that is not a well-formed, unexpired colleague
    /// ring, that arrives with nobody signed in here, while another call
    /// holds this phone, or for a workspace whose plan has the mobile app off
    /// (`TeamCallRing.mayRing`), is reported and ended at once. One that is is left
    /// ringing, and the server decides the rest: it is read at once and then
    /// every two seconds (`watch`), which is where a ring for somebody else
    /// (404), or one already answered elsewhere, ends.
    func reportIncoming(_ payload: [AnyHashable: Any]) {
        let ring = TeamCallRing(payload: payload)
        let now = Date()
        let uuid = ring?.uuid ?? UUID()
        let update = Self.update(
            callID: ring?.callID ?? uuid.uuidString,
            name: TeamCallName.shown(ring?.callerName, Self.language),
            video: ring?.channel == .video
        )

        // The same call again — APNs may deliver one push twice. Still
        // ringing or answered here: CallKit already has it under this UUID
        // and answers the report with `callUUIDAlreadyExists`, which
        // `incomingReportFailed` leaves alone. Already over here: it is not
        // rung a second time.
        if let ring, let current = call, current.uuid == ring.uuid {
            report(uuid, update)
            if current.phase.isOver {
                callKit.provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
            }
            return
        }

        // Synchronous reads only, so the report below is never delayed: the
        // Keychain's token, and the plan's mobile app switch as this phone
        // last read it for the ring's workspace (`MobileAppLock`) — a locked
        // workspace's ring is reported and ended at once
        // (docs/operations/MOBILE_APP_PLAN.md).
        let accepted: TeamCallRing? = ring.flatMap { ring in
            guard ring.mayRing(
                now: now,
                holdsAudio: holdsAudio,
                signedIn: TokenStore.read() != nil,
                workspaceLocked: MobileAppLock.isLocked(workspaceID: ring.workspaceID)
            ) else { return nil }
            return ring
        }
        report(uuid, update)
        guard let ring = accepted else {
            callKit.provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
            // Ended for what this phone last read of that workspace's plan,
            // which goes stale when the plan is switched back on while
            // another workspace is open here: ask it again, so the next ring
            // rings unless it still says the mobile app is off.
            if let ring, MobileAppLock.isLocked(workspaceID: ring.workspaceID) {
                let api = self.api, workspaceID = ring.workspaceID
                Task { _ = await MobileAppLock.recheck(workspaceID: workspaceID, api: api) }
            }
            return
        }

        clearEnded()
        call = ActiveTeamCall(
            uuid: uuid,
            callID: ring.callID,
            direction: .incoming,
            channel: ring.channel,
            peerProfileName: ring.callerName,
            peerAvatarURL: ring.callerAvatarURL,
            phase: .ringing,
            knownToCallKit: true,
            isSpeakerOn: ring.channel == .video,
            isCameraOn: ring.channel == .video
        )
        takeAudio()
        watch(ring.callID, now: true)
        ringUntil(TeamCallTiming.deadline(expiresAt: ring.expiresAt, receivedAt: now), uuid: uuid)
    }

    private func report(_ uuid: UUID, _ update: CXCallUpdate) {
        callKit.provider.reportNewIncomingCall(with: uuid, update: update) { @Sendable error in
            guard let error else { return }
            Task { @MainActor in CallManager.shared.incomingReportFailed(uuid: uuid, error: error) }
        }
    }

    /// CallKit did not take the ring: Do Not Disturb, a Focus, a blocked
    /// handle. Nothing rings here then, so nothing is held for it — and the
    /// server is not told: the colleague's other phones may still answer.
    private func incomingReportFailed(uuid: UUID, error: Error) {
        if (error as? CXErrorCodeIncomingCallError)?.code == .callUUIDAlreadyExists { return }
        guard let call, call.uuid == uuid, !call.phase.isOver else { return }
        self.call = nil
        stopTimers()
        teardown()
    }

    // MARK: - Placing a call

    /// Rings a colleague from their thread. The microphone (and, for video,
    /// the camera) were asked for before this, by the thread.
    ///
    /// The server rings first, then CallKit hears of the call — its handle
    /// is the call id, which only exists once the server has made the row.
    func place(to colleague: Colleague, channel: CallChannel, workspaceID: String) {
        guard !holdsAudio else { return }
        clearEnded()
        let uuid = UUID()
        call = ActiveTeamCall(
            uuid: uuid,
            callID: nil,
            direction: .outgoing,
            channel: channel,
            // The profile name, never `displayName`, which falls back to the
            // colleague's e-mail (`TeamCallName`).
            peerProfileName: colleague.fullName,
            peerAvatarURL: colleague.avatarURL,
            phase: .calling,
            knownToCallKit: false,
            isSpeakerOn: channel == .video,
            isCameraOn: channel == .video
        )
        takeAudio()
        Task { await startOnServer(uuid: uuid, calleeID: colleague.userId, channel: channel, workspaceID: workspaceID) }
    }

    private func startOnServer(uuid: UUID, calleeID: String, channel: CallChannel, workspaceID: String) async {
        let placed: TeamCall
        do {
            placed = try await api.startTeamCall(workspaceID: workspaceID, calleeID: calleeID, channel: channel)
        } catch APIError.server(let status, let code) {
            finish(uuid, .refusal(status: status, code: code), tellServer: false, reportToCallKit: false)
            return
        } catch {
            finish(uuid, .failed, tellServer: false, reportToCallKit: false)
            return
        }
        // Ended on this phone while the request was out: the ring it started
        // is withdrawn at once — by a hang-up, which the server makes a
        // cancel while it rings and an end should the colleague already have
        // answered.
        guard var call, call.uuid == uuid, !call.phase.isOver else {
            tell(.hangUp, callID: placed.id, answering: nil)
            return
        }
        call.callID = placed.id
        self.call = call

        let start = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: placed.id))
        start.isVideo = channel == .video
        callKit.controller.request(CXTransaction(action: start)) { @Sendable error in
            guard error != nil else { return }
            Task { @MainActor in
                CallManager.shared.finish(uuid, .failed, tellServer: true, reportToCallKit: false)
            }
        }
        watch(placed.id, now: false)
        ringUntil(
            TeamCallTiming.deadline(expiresAt: placed.expiresAt, receivedAt: Date())
                .addingTimeInterval(TeamCallTiming.callerGrace),
            uuid: uuid
        )
        apply(placed)
    }

    // MARK: - What the server says

    /// Reads the call every two seconds while it rings and every ten once
    /// answered, until it is over here. `now` reads it at once first — a
    /// ring is checked against the server the moment it arrives.
    private func watch(_ callID: String, now: Bool) {
        watcher?.cancel()
        watcher = Task { [weak self] in
            if now { await self?.read(callID) }
            while !Task.isCancelled {
                guard let interval = self?.pollInterval(callID) else { return }
                try? await Task.sleep(for: .seconds(interval))
                guard !Task.isCancelled else { return }
                await self?.read(callID)
            }
        }
    }

    private func pollInterval(_ callID: String) -> TimeInterval? {
        guard let call, call.callID == callID, !call.phase.isOver else { return nil }
        return call.isRinging && !call.answered ? Self.ringingPoll : Self.answeredPoll
    }

    private func read(_ callID: String) async {
        do {
            apply(try await api.teamCall(id: callID))
        } catch APIError.unauthorized {
            endCall(callID, .failed)
        } catch APIError.server(let status, _) where status == 404 {
            // Not this member's call — a ring for whoever held this phone's
            // address before, or a call that no longer exists.
            endCall(callID, .failed)
        } catch {
            // A blip. The next read, or the ring's deadline, settles it.
        }
    }

    /// The server's word on the call, from a read, a realtime nudge, the
    /// call just placed or an answer refused.
    private func apply(_ fresh: TeamCall) {
        guard var call, call.callID == fresh.id, !call.phase.isOver else { return }
        switch call.direction {
        case .outgoing:
            if fresh.state.isAnswered {
                guard !call.answered else { return }
                call.answered = true
                self.call = call
                ringTimer?.cancel()
                Task { await join(fresh.id) }
            } else if let end = TeamCallEnd.resolve(fresh, deviceID: deviceID) {
                endCall(fresh.id, end)
            } else if call.phase == .calling {
                self.call?.phase = .ringing
            }
        case .incoming:
            if call.answered || call.phase != .ringing {
                // Answered here, or the answer is on its way: only the end
                // of the call matters now.
                guard fresh.state.isOver else { return }
                endCall(fresh.id, TeamCallEnd.resolve(fresh, deviceID: deviceID) ?? .remoteEnded)
            } else if let end = TeamCallEnd.resolve(fresh, deviceID: deviceID) {
                endCall(fresh.id, end)
            }
        }
    }

    /// Stops the ring at its deadline when the server's word has not come.
    ///
    /// On the phone that rings, at `expires_at` (`TeamCallTiming.deadline`),
    /// and without a word to the server: its ticker is turning the call
    /// `missed`. On the caller's, a little after (`callerGrace`), and with a
    /// hang-up: the server, not this phone, knows whether the colleague
    /// answered at the last moment, and a hang-up ends either call — an
    /// answered one for both, one still ringing as a cancel, one already
    /// missed not at all.
    private func ringUntil(_ deadline: Date, uuid: UUID) {
        ringTimer?.cancel()
        ringTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
            guard !Task.isCancelled, let self, let call = self.call, call.uuid == uuid,
                  !call.answered, call.isRinging
            else { return }
            let calling = call.direction == .outgoing
            self.finish(uuid, calling ? .noAnswer : .missed, tellServer: calling, reportToCallKit: true)
        }
    }

    /// Realtime, while the app is open: a change to a call on the member's
    /// own channel reads it at once rather than at the next poll.
    private func listenForSignals() {
        signals = Task { [weak self] in
            for await signal in SyncCoordinator.shared.teamCallSignals() {
                guard let self else { return }
                guard let call = self.call, call.callID == signal.callID, !call.phase.isOver else { continue }
                await self.read(signal.callID)
            }
        }
    }

    // MARK: - Answering

    /// CallKit's answer — from the lock screen, its banner, or the call
    /// screen's Answer. The server decides who won: the action is fulfilled
    /// when this phone did, failed when another phone did or the call ended.
    fileprivate func perform(answer action: CXAnswerCallAction) {
        guard var call, call.uuid == action.callUUID, call.direction == .incoming,
              call.phase == .ringing, let callID = call.callID
        else {
            action.fail()
            return
        }
        call.phase = .connecting
        self.call = call
        ringTimer?.cancel()
        TeamCallAudio.configure(video: call.channel == .video)
        pendingAnswer = action
        let uuid = call.uuid
        let deviceID = self.deviceID
        let answering = Task { [api] () async -> TeamCallAcceptance? in
            try? await api.acceptTeamCall(id: callID, deviceID: deviceID)
        }
        self.answering = answering
        Task { await accepted(answering, callID: callID, uuid: uuid) }
    }

    /// The server's answer to this phone's, while the call is still on here.
    /// One that ended here meanwhile has had the server seen to by `finish`.
    private func accepted(_ answering: Task<TeamCallAcceptance?, Never>, callID: String, uuid: UUID) async {
        let answer = await answering.value
        guard let call, call.uuid == uuid, !call.phase.isOver else { return }
        guard let answer else {
            // No answer back: whether it landed is not known. The call
            // fails here, and `finish` asks the server whose it is before
            // hanging up (`TeamCallNotice.afterTheAnswer`).
            finish(uuid, .failed, tellServer: true, reportToCallKit: true)
            return
        }
        guard answer.isWon(by: deviceID) else {
            let end = answer.call.flatMap { TeamCallEnd.resolve($0, deviceID: deviceID) } ?? .failed
            finish(uuid, end, tellServer: false, reportToCallKit: true)
            return
        }
        self.answering = nil
        settleAnswer(won: true)
        self.call?.answered = true
        await join(callID)
    }

    private func settleAnswer(won: Bool) {
        if won { pendingAnswer?.fulfill() } else { pendingAnswer?.fail() }
        pendingAnswer = nil
    }

    // MARK: - The room

    /// Both sides, once the call is answered: this member's token, then the
    /// room, then the microphone and the camera. Live when the colleague is
    /// in the room too.
    private func join(_ callID: String) async {
        guard var call, call.callID == callID, !call.phase.isOver else { return }
        let uuid = call.uuid
        if call.phase != .connecting {
            call.phase = .connecting
            self.call = call
        }
        startJoinTimer(uuid)
        do {
            let credentials = try await api.teamCallToken(id: callID)
            guard isCurrent(uuid) else { return }
            self.call?.relayWarning = credentials.warnings?.contains("turn_missing") == true
            // RESPOK never joins a room on a WebYar server, whatever its own names (`AppBrand`).
            guard let url = credentials.signallingURL, AppBrand.accepts(url) else {
                finish(uuid, .failed, tellServer: true, reportToCallKit: true)
                return
            }
            let room = TeamCallRoom()
            room.onPresenceChanged = { [weak self] present in self?.presenceChanged(present, uuid: uuid) }
            room.onDisconnected = { [weak self] in self?.roomDropped(uuid) }
            room.onTracksChanged = { [weak self] in self?.syncTracks() }
            self.room = room
            try await room.connect(url: url, credentials: credentials)
            guard isCurrent(uuid), room.isConnected else { return }

            // Best effort, as a visitor call's: what will not start degrades
            // the call rather than dropping it.
            let muted = self.call?.isMuted ?? false
            if !(await room.setMicrophone(enabled: !muted)) {
                self.call?.isMuted = true
                self.call?.degraded = .noMicrophone
            }
            if call.channel == .video, self.call?.isCameraOn == true, !(await room.setCamera(enabled: true)) {
                self.call?.isCameraOn = false
                if self.call?.degraded == nil { self.call?.degraded = .noCamera }
            }
            guard isCurrent(uuid) else { return }
            syncTracks()
            if room.remotePresent { goLive(uuid) }
        } catch {
            guard isCurrent(uuid) else { return }
            finish(uuid, .failed, tellServer: true, reportToCallKit: true)
        }
    }

    private func isCurrent(_ uuid: UUID) -> Bool {
        guard let call else { return false }
        return call.uuid == uuid && !call.phase.isOver
    }

    private func startJoinTimer(_ uuid: UUID) {
        joinTimer?.cancel()
        joinTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.joinTimeout))
            guard !Task.isCancelled, let self, let call = self.call, call.uuid == uuid, call.phase == .connecting else { return }
            self.finish(uuid, .failed, tellServer: true, reportToCallKit: true)
        }
    }

    private func goLive(_ uuid: UUID) {
        guard var call, call.uuid == uuid, call.phase == .connecting else { return }
        let now = Date()
        call.phase = .live(since: now)
        self.call = call
        joinTimer?.cancel()
        if call.direction == .outgoing {
            callKit.provider.reportOutgoingCall(with: uuid, connectedAt: now)
        }
        applyRoute()
    }

    private func presenceChanged(_ present: Bool, uuid: UUID) {
        guard let call, call.uuid == uuid else { return }
        if present {
            goLive(uuid)
        } else if call.isLive {
            // The colleague left the room: the call is over for both, and
            // the server is told in case the room's webhook has not yet.
            finish(uuid, .remoteEnded, tellServer: true, reportToCallKit: true)
        }
    }

    /// The room dropped under the call. Before the two met it is a join that
    /// never landed; after, the call ending.
    private func roomDropped(_ uuid: UUID) {
        guard let call, call.uuid == uuid, !call.phase.isOver else { return }
        finish(uuid, call.isLive ? .remoteEnded : .failed, tellServer: true, reportToCallKit: true)
    }

    private func syncTracks() {
        remoteVideo = room?.remoteVideo
        localVideo = room?.localVideo
    }

    // MARK: - CallKit's other actions

    /// CallKit has placed the call: the session gets its category before
    /// CallKit activates it, and the system's call UI learns the colleague's
    /// name.
    fileprivate func perform(start action: CXStartCallAction) {
        guard var call, call.uuid == action.callUUID, call.direction == .outgoing,
              !call.phase.isOver, let callID = call.callID
        else {
            action.fail()
            return
        }
        call.knownToCallKit = true
        self.call = call
        TeamCallAudio.configure(video: call.channel == .video)
        callKit.provider.reportOutgoingCall(with: call.uuid, startedConnectingAt: Date())
        callKit.provider.reportCall(
            with: call.uuid,
            updated: Self.update(callID: callID, name: call.peerName(Self.language), video: call.channel == .video)
        )
        action.fulfill()
    }

    /// End, Decline or Cancel — CallKit's buttons and the call screen's.
    fileprivate func perform(end action: CXEndCallAction) {
        if let call, call.uuid == action.callUUID {
            finish(call.uuid, Self.endedHere(call), tellServer: true, reportToCallKit: false)
        }
        action.fulfill()
    }

    fileprivate func perform(mute action: CXSetMutedCallAction) {
        guard call?.uuid == action.callUUID else {
            action.fail()
            return
        }
        setMuted(action.isMuted)
        action.fulfill()
    }

    /// CallKit gave up waiting for an action (an answer the server took too
    /// long over): the call cannot go on as CallKit sees it.
    fileprivate func timedOut(_ action: CXAction) {
        guard let call, !call.phase.isOver else { return }
        if action is CXAnswerCallAction { pendingAnswer = nil }
        finish(call.uuid, .failed, tellServer: true, reportToCallKit: true)
    }

    /// CallKit dropped every call it had (the system's own reset).
    fileprivate func providerReset() {
        pendingAnswer = nil
        guard let call, !call.phase.isOver else { return }
        finish(call.uuid, .failed, tellServer: true, reportToCallKit: false)
    }

    /// CallKit activated the session: LiveKit's engine may run now.
    fileprivate func audioActivated() {
        guard holdsAudio else { return }
        do {
            try TeamCallAudio.activated()
        } catch {
            call?.isMuted = true
            if call?.degraded == nil { call?.degraded = .noMicrophone }
        }
        applyRoute()
    }

    /// CallKit deactivated it: mid-call, the engine waits for it back; after
    /// the call, the session goes back to LiveKit for visitor calls.
    fileprivate func audioDeactivated() {
        if holdsAudio {
            TeamCallAudio.deactivated()
        } else {
            TeamCallAudio.handBack()
        }
    }

    /// What this phone's own End means on the call screen: a decline while
    /// ringing here, a cancel while the colleague's phones ring, a hang-up
    /// after. What the server is sent is `TeamCallNotice`'s to say.
    private static func endedHere(_ call: ActiveTeamCall) -> TeamCallEnd {
        call.direction == .outgoing && !call.answered ? .cancelled : .hungUp
    }

    // MARK: - The call screen's controls

    /// Answer, from the call screen. Through CallKit, which then performs it.
    func answer() {
        guard let call, call.direction == .incoming, call.phase == .ringing else { return }
        let uuid = call.uuid
        callKit.controller.request(CXTransaction(action: CXAnswerCallAction(call: uuid))) { @Sendable error in
            guard error != nil else { return }
            Task { @MainActor in
                CallManager.shared.finish(uuid, .failed, tellServer: true, reportToCallKit: true)
            }
        }
    }

    /// End, Decline or Cancel, from the call screen.
    ///
    /// Through CallKit when it has the call; directly while an outgoing call
    /// is still being placed, which CallKit has not heard of yet.
    func end() {
        guard let call, !call.phase.isOver else { return }
        guard call.knownToCallKit else {
            finish(call.uuid, Self.endedHere(call), tellServer: true, reportToCallKit: false)
            return
        }
        let uuid = call.uuid
        callKit.controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { @Sendable error in
            guard error != nil else { return }
            // CallKit no longer has it: ended here all the same.
            Task { @MainActor in
                let manager = CallManager.shared
                guard let call = manager.call, call.uuid == uuid else { return }
                manager.finish(uuid, CallManager.endedHere(call), tellServer: true, reportToCallKit: false)
            }
        }
    }

    /// Mute and unmute, through CallKit so its own button agrees.
    func toggleMute() {
        guard let call, !call.phase.isOver else { return }
        let muted = !call.isMuted
        guard call.knownToCallKit else {
            setMuted(muted)
            return
        }
        callKit.controller.request(CXTransaction(action: CXSetMutedCallAction(call: call.uuid, muted: muted))) { @Sendable error in
            guard error != nil else { return }
            Task { @MainActor in CallManager.shared.setMuted(muted) }
        }
    }

    private func setMuted(_ muted: Bool) {
        call?.isMuted = muted
        guard let room else { return }
        Task { _ = await room.setMicrophone(enabled: !muted) }
    }

    /// Earpiece or loudspeaker, for a voice call.
    func toggleSpeaker() {
        guard let call, call.channel == .audio, !call.phase.isOver else { return }
        self.call?.isSpeakerOn = !call.isSpeakerOn
        applyRoute()
    }

    /// The camera on and off, for a video call: answered with it off is a
    /// video call all the same.
    func toggleCamera() {
        guard let call, call.channel == .video, !call.phase.isOver else { return }
        let on = !call.isCameraOn
        self.call?.isCameraOn = on
        guard let room else { return }
        Task {
            if !(await room.setCamera(enabled: on)), on {
                self.call?.isCameraOn = false
            }
            self.syncTracks()
        }
    }

    func switchCamera() {
        guard let call, call.channel == .video, call.isCameraOn, let room else { return }
        Task {
            await room.switchCamera()
            self.syncTracks()
        }
    }

    /// Done, on an ended call.
    func dismiss() {
        guard let call, call.phase.isOver else { return }
        clearEnded()
    }

    /// The speaker and the proximity sensor follow the call: a voice call on
    /// the earpiece turns the screen off at the ear; on the loudspeaker, or
    /// on a video call, it stays on.
    private func applyRoute() {
        guard let call, !call.phase.isOver else { return }
        if call.channel == .audio {
            TeamCallAudio.route(toSpeaker: call.isSpeakerOn)
        }
        UIDevice.current.isProximityMonitoringEnabled = call.channel == .audio && !call.isSpeakerOn && call.isLive
    }

    // MARK: - Signing out

    /// The session ended on this phone (signed out, expired, the account
    /// deleted). A call cannot outlive it: it ends here, and the room's
    /// webhook ends it for the colleague.
    func sessionEnded() {
        guard let call else { return }
        if !call.phase.isOver {
            finish(call.uuid, .failed, tellServer: false, reportToCallKit: true)
        }
        clearEnded()
    }

    // MARK: - Ending

    /// The call `callID` names ended as the server said — so the server is
    /// not told again.
    private func endCall(_ callID: String, _ end: TeamCallEnd) {
        guard let call, call.callID == callID else { return }
        finish(call.uuid, end, tellServer: false, reportToCallKit: true)
    }

    /// The single way a call ends on this phone.
    ///
    /// `tellServer` when the end is this phone's news — its own End, a room
    /// that dropped, a failure — and not when the server is where it came
    /// from. `reportToCallKit` unless CallKit is the one ending it (its end
    /// action) or never had it.
    private func finish(_ uuid: UUID, _ end: TeamCallEnd, tellServer: Bool, reportToCallKit: Bool) {
        guard var call, call.uuid == uuid, !call.phase.isOver else { return }
        let wasRingingHere = call.direction == .incoming && call.phase == .ringing
        let notice = TeamCallNotice.leaving(call)
        call.phase = .ended(end)
        self.call = call
        stopTimers()
        settleAnswer(won: false)
        let answering = self.answering
        self.answering = nil

        if tellServer, let callID = call.callID {
            tell(notice, callID: callID, answering: answering)
        }
        if reportToCallKit, call.knownToCallKit {
            callKit.provider.reportCall(with: uuid, endedAt: nil, reason: end.callKitReason)
        }
        teardown()

        // A ring declined here has nothing to say, and one cancelled or
        // missed is said by the missed-call notification alone
        // (`closesRingAtOnce`); anything else lingers a moment so the outcome
        // can be read.
        if wasRingingHere, end.closesRingAtOnce {
            self.call = nil
        } else {
            clearTimer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(Self.endedLinger))
                guard !Task.isCancelled, let self, self.call?.uuid == uuid else { return }
                self.call = nil
            }
        }
    }

    /// Tells the server the call ended here, with iOS's leave to finish
    /// saying it. CallKit's call is gone by the time the request is on its
    /// way — `perform(end:)` fulfils the end action straight after `finish`
    /// — and an app a VoIP push launched in the background has nothing else
    /// keeping it running: suspended first, a Decline on the lock screen
    /// would leave the colleague ringing out to "No answer", and a missed
    /// call behind for a call that was declined.
    ///
    /// `answering` is this phone's answer, for `.afterTheAnswer`: awaited,
    /// and when it did not come back, the server is asked instead.
    private func tell(_ notice: TeamCallNotice, callID: String, answering: Task<TeamCallAcceptance?, Never>?) {
        let deviceID = self.deviceID
        BackgroundGrace.run("Colleague call end") { [api] in
            switch notice {
            case .hangUp:
                try? await api.hangUpTeamCall(id: callID)
            case .decline:
                try? await api.declineTeamCall(id: callID)
            case .afterTheAnswer:
                let won: Bool
                if let answer = await answering?.value {
                    won = answer.isWon(by: deviceID)
                } else {
                    won = (try? await api.teamCall(id: callID))?.isAnswered(on: deviceID) == true
                }
                guard won else { return }
                try? await api.hangUpTeamCall(id: callID)
            }
        }
    }

    private func stopTimers() {
        watcher?.cancel()
        ringTimer?.cancel()
        joinTimer?.cancel()
        watcher = nil
        ringTimer = nil
        joinTimer = nil
    }

    /// An ended call still on screen goes, for the next one or for Done.
    private func clearEnded() {
        clearTimer?.cancel()
        clearTimer = nil
        if call?.phase.isOver == true { call = nil }
    }

    /// The audio is the call's from the ring (or the tap) on: voice notes
    /// stop, and LiveKit leaves the session to CallKit.
    private func takeAudio() {
        CallAudioFocus.shared.callBegan()
        TeamCallAudio.handToCallKit()
    }

    /// The room goes, the pictures with it, and the audio is given back —
    /// to voice notes at once, to LiveKit once the room has disconnected,
    /// unless a ring that arrived meanwhile has taken it.
    ///
    /// Leaving the room is given iOS's leave to finish too (`tell`): a room
    /// left half-way would keep the colleague listening to silence until
    /// LiveKit noticed this phone had gone.
    private func teardown() {
        let leaving = room
        room = nil
        remoteVideo = nil
        localVideo = nil
        UIDevice.current.isProximityMonitoringEnabled = false
        CallAudioFocus.shared.callEnded()
        BackgroundGrace.run("Colleague call room") {
            await leaving?.disconnect()
            guard !self.holdsAudio else { return }
            TeamCallAudio.handBack()
        }
    }
}

/// A little of iOS's time to finish what a call's end has started, after
/// the call that kept the app running is gone (`beginBackgroundTask`).
///
/// Begun at once, where the work is started — not inside it, which may only
/// run after the app was suspended — and ended when the work is done, or when
/// iOS says the time is up, whichever comes first. Main-actor, as UIKit's
/// background tasks are; the expiry handler asserts it rather than relying
/// on how a given SDK annotates it.
@MainActor
private final class BackgroundGrace {
    private var id: UIBackgroundTaskIdentifier = .invalid

    static func run(_ name: String, _ work: @escaping @MainActor @Sendable () async -> Void) {
        let grace = BackgroundGrace()
        grace.id = UIApplication.shared.beginBackgroundTask(withName: name) {
            MainActor.assumeIsolated { grace.end() }
        }
        Task { @MainActor in
            await work()
            grace.end()
        }
    }

    private func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

extension TeamCallEnd {
    /// What CallKit is told when the call ends anywhere but at its own end
    /// action (which needs no report).
    var callKitReason: CXCallEndedReason {
        switch self {
        case .remoteEnded, .declined, .cancelled, .hungUp: .remoteEnded
        case .noAnswer, .missed: .unanswered
        case .answeredElsewhere: .answeredElsewhere
        case .declinedElsewhere: .declinedElsewhere
        case .busy, .notInPlan, .limitReached, .failed: .failed
        }
    }
}

/// CallKit's provider and controller, and its delegate, which hands every
/// action to `CallManager`.
///
/// Its own object rather than the manager's conformance: the delegate has to
/// be an `NSObject`, and the manager is `@Observable`. Main-actor, with the
/// delegate's queue left nil — which is the main queue — and the conformance
/// `@preconcurrency`, as `AppDelegate`'s are: CallKit predates Swift
/// concurrency and does not say where it calls, and this is where it does.
@MainActor
final class CallKitBridge: NSObject, @preconcurrency CXProviderDelegate {
    let provider: CXProvider
    let controller = CXCallController()
    weak var manager: CallManager?

    init(configuration: CXProviderConfiguration) {
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    func providerDidReset(_ provider: CXProvider) {
        manager?.providerReset()
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard let manager else { return action.fail() }
        manager.perform(start: action)
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let manager else { return action.fail() }
        manager.perform(answer: action)
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        guard let manager else { return action.fulfill() }
        manager.perform(end: action)
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        guard let manager else { return action.fail() }
        manager.perform(mute: action)
    }

    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        manager?.timedOut(action)
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        manager?.audioActivated()
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        manager?.audioDeactivated()
    }
}
