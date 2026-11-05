import AVFoundation
import Foundation
import LiveKit

// The LiveKit side of a colleague call, kept apart from CallKit's and the
// server's (`CallManager`): every SDK call the colleague call makes is in
// this file, so a change in the SDK is a change here and nowhere else, but
// for the camera's caps, which it shares with visitor calls
// (`CallMediaBudget`). Read against client-sdk-swift 2.17.0 (`Docs/audio.md`,
// `AudioManager`).

/// Who configures the audio session, and when the engine may run.
///
/// A visitor call (`CallSession`) leaves both to LiveKit, which sets the
/// category from what its engine is doing. A colleague call is a CallKit
/// call, and CallKit owns the session: it activates it once the call is
/// answered or placed and deactivates it at the end, and an engine started
/// before that — or a category changed behind its back — is a call with no
/// sound. So for the length of a colleague call LiveKit's automatic setup is
/// off, the engine is held until CallKit's `didActivate`, and both go back
/// to LiveKit afterwards.
@MainActor
enum TeamCallAudio {
    /// CallKit is about to own the session: LiveKit keeps its hands off it,
    /// and its engine waits for `activated()`. Before any room is joined, as
    /// the SDK asks.
    static func handToCallKit() {
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        try? AudioManager.shared.setEngineAvailability(.none)
    }

    /// The category the call needs, set before CallKit activates the session
    /// (in the answer or start action): a voice call on the earpiece
    /// (`.voiceChat`), a video call on the loudspeaker (`.videoChat`), either
    /// on a Bluetooth headset when one is connected.
    static func configure(video: Bool) {
        try? AVAudioSession.sharedInstance().setCategory(
            .playAndRecord,
            mode: video ? .videoChat : .voiceChat,
            options: categoryOptions
        )
    }

    /// `.allowBluetoothHFP` is the iOS 26 SDK's name for what was
    /// `.allowBluetooth` (the same option, which iOS 17 understands); the
    /// SDK in use decides the spelling. The compiler's version, not the
    /// language mode's: this target builds in Swift 5 mode on a newer
    /// compiler.
    private static var categoryOptions: AVAudioSession.CategoryOptions {
        #if compiler(>=6.2)
        [.allowBluetoothHFP, .allowBluetoothA2DP]
        #else
        [.allowBluetooth, .allowBluetoothA2DP]
        #endif
    }

    /// CallKit activated the session: the engine may run. Throws when the
    /// microphone is refused (the SDK checks before opening it).
    static func activated() throws {
        try AudioManager.shared.setEngineAvailability(.default)
    }

    /// CallKit took the session away mid-call (another call, an
    /// interruption): the engine stops until it is given back.
    static func deactivated() {
        try? AudioManager.shared.setEngineAvailability(.none)
    }

    /// The call is over: LiveKit configures the session itself again, as a
    /// visitor call needs. After the room has disconnected, so the SDK has
    /// no engine to reconfigure on the way.
    static func handBack() {
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = true
        try? AudioManager.shared.setEngineAvailability(.default)
    }

    /// Earpiece or loudspeaker. Ours to set during a colleague call: the
    /// session is the app's (CallKit's), not LiveKit's.
    static func route(toSpeaker: Bool) {
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(toSpeaker ? .speaker : .none)
    }

    /// The call's sound plays somewhere other than the phone itself — a
    /// headset, AirPods in the ears, a car — as iOS routes it now. Read from
    /// the route only, never from the devices on offer: AirPods connected but
    /// lying on the desk are offered, and are not where the sound goes. Only
    /// meaningful while no loudspeaker override of ours hides the route
    /// (`CallManager.externalAudio` keeps the last such reading).
    static var routeIsExternal: Bool {
        let builtIn: Set<AVAudioSession.Port> = [.builtInReceiver, .builtInSpeaker]
        return AVAudioSession.sharedInstance().currentRoute.outputs.contains { !builtIn.contains($0.portType) }
    }

    /// The sound comes out of the phone's loudspeaker now, whoever chose it.
    static var playsOnLoudspeaker: Bool {
        AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .builtInSpeaker }
    }
}

/// The room of one colleague call: joining it, the microphone and camera,
/// and what the other side is sending.
///
/// The SDK's objects stay in here; `CallManager` hears what changed through
/// the callbacks and keeps the two pictures in properties SwiftUI observes —
/// a view reading `Room` directly only ever sees what was true at its last
/// redraw (`CallSession` has the long version of that story).
@MainActor
final class TeamCallRoom {
    /// The colleague came into the room, or left it.
    var onPresenceChanged: ((Bool) -> Void)?
    /// The room dropped under the call.
    var onDisconnected: (() -> Void)?
    /// A picture started or stopped, on either side.
    var onTracksChanged: (() -> Void)?

    private var room: Room?
    private var observer: TeamRoomObserver?

    /// The colleague is in the room.
    var remotePresent: Bool { !(room?.remoteParticipants.isEmpty ?? true) }

    /// Their camera, when it is sending; a muted publication is no picture.
    var remoteVideo: VideoTrack? {
        let remote = room?.remoteParticipants.values.flatMap(\.videoTracks) ?? []
        return remote.first { $0.isSubscribed && !$0.isMuted }?.track as? VideoTrack
    }

    /// This phone's own camera, when it is on.
    var localVideo: VideoTrack? {
        room?.localParticipant.videoTracks.first { !$0.isMuted }?.track as? VideoTrack
    }

    /// Joins the room with the token the server minted for this member.
    func connect(url: String, credentials: CallToken) async throws {
        let room = Room()
        let observer = TeamRoomObserver(owner: self)
        room.add(delegate: observer)
        self.room = room
        self.observer = observer
        try await room.connect(
            url: url,
            token: credentials.token,
            connectOptions: ConnectOptions(
                iceServers: Self.iceServers(from: credentials),
                iceTransportPolicy: credentials.relayOnly ? .relay : .all
            ),
            // The camera's caps, the same as a visitor call's (`CallMediaBudget`).
            roomOptions: RoomOptions(
                defaultCameraCaptureOptions: CallMediaBudget.cameraCapture,
                defaultVideoPublishOptions: CallMediaBudget.videoPublish,
                adaptiveStream: true,
                dynacast: true
            )
        )
    }

    /// Whether `room` is still the one being used — false once `disconnect()`
    /// ran while an await was in flight.
    var isConnected: Bool { room != nil }

    /// Best effort, as a visitor call's: a microphone that will not start is
    /// a degraded call, not a dropped one. False when it did not start.
    func setMicrophone(enabled: Bool) async -> Bool {
        guard let room else { return false }
        do {
            try await room.localParticipant.setMicrophone(enabled: enabled)
            return true
        } catch {
            return false
        }
    }

    /// The same for the camera; a video call goes on as voice without it.
    func setCamera(enabled: Bool) async -> Bool {
        guard let room else { return false }
        do {
            try await room.localParticipant.setCamera(enabled: enabled)
            if enabled { CallCamera.allowWhileMultitasking(room.localParticipant) }
            return true
        } catch {
            return false
        }
    }

    /// Front to back and back again. Nothing happens without a camera on.
    func switchCamera() async {
        guard let track = room?.localParticipant.firstCameraPublication?.track as? LocalVideoTrack,
              let camera = track.capturer as? CameraCapturer
        else { return }
        _ = try? await camera.switchCameraPosition()
        onTracksChanged?()
    }

    /// Unpublishes, then leaves: a capturer still running when the room goes
    /// leaves the camera light on.
    func disconnect() async {
        guard let room else { return }
        self.room = nil
        observer = nil
        _ = try? await room.localParticipant.setCamera(enabled: false)
        _ = try? await room.localParticipant.setMicrophone(enabled: false)
        await room.disconnect()
    }

    private static func iceServers(from credentials: CallToken) -> [IceServer] {
        guard let turn = credentials.turn, let urls = turn.urls, !urls.isEmpty else { return [] }
        return [IceServer(urls: urls, username: turn.username ?? "", credential: turn.credential ?? "")]
    }

    // MARK: - From the observer

    fileprivate func presenceChanged() {
        onPresenceChanged?(remotePresent)
    }

    fileprivate func disconnected() {
        guard room != nil else { return }
        onDisconnected?()
    }

    fileprivate func tracksChanged() {
        onTracksChanged?()
    }
}

/// LiveKit talks to its delegate on its own queue; this hops each event onto
/// the main actor, where the room's owner lives.
private final class TeamRoomObserver: RoomDelegate, @unchecked Sendable {
    private weak var owner: TeamCallRoom?

    init(owner: TeamCallRoom) {
        self.owner = owner
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor [weak owner] in owner?.presenceChanged() }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        Task { @MainActor [weak owner] in owner?.presenceChanged() }
    }

    func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        guard connectionState == .disconnected else { return }
        Task { @MainActor [weak owner] in owner?.disconnected() }
    }

    func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        tracksChanged()
    }

    func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        tracksChanged()
    }

    func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
        tracksChanged()
    }

    func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        tracksChanged()
    }

    func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) {
        tracksChanged()
    }

    private func tracksChanged() {
        Task { @MainActor [weak owner] in owner?.tracksChanged() }
    }
}
