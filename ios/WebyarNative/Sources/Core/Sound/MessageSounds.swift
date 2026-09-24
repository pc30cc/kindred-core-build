import AVFoundation
import Foundation

/// The four moments a chat app makes a noise, and what it should sound like.
///
/// Three of them are the app's own, played from here. The fourth — a push
/// arriving while the app is not in front of anybody — belongs to iOS, and
/// the server already asks for it (`apns.ts` sets `aps.sound`). What this
/// file also does, deliberately, is take the sound OFF the banner while the
/// app IS in front of somebody, so a message that arrives over both the
/// socket and APNs makes one sound rather than two — and the one it makes is
/// the one that knows whether the operator is looking at that thread.
///
/// The sounds themselves are synthesised and shipped in the bundle rather
/// than borrowed from the system. `AudioServicesPlaySystemSound` with an
/// undocumented identifier gets you Apple's own iMessage tones, which belong
/// to Apple and, worse, tell the operator that Messages made the sound.
@MainActor
final class MessageSounds {

    static let shared = MessageSounds()

    enum Cue: String {
        /// The operator sent something. Short, low and quiet: they hear this
        /// a hundred times a day and they already know they pressed send.
        case sent
        /// A visitor wrote, and the operator is reading that very thread.
        /// Almost subliminal — the message is arriving in front of their eyes.
        case receivedHere = "received-here"
        /// A visitor wrote, and the operator is somewhere else. This one is
        /// news, so it rises and carries a little further.
        case receivedAway = "received-away"
    }

    /// Whether the operator wants to hear any of this.
    ///
    /// Mirrors the `play_sound` notification preference into `UserDefaults`
    /// when Settings reads or writes it, so a sound that has to be decided in
    /// a few milliseconds never waits on a request. Absent means on, which is
    /// the server's own default.
    private static let enabledKey = "webyar.sound.messages"

    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    private var players: [Cue: AVAudioPlayer] = [:]
    private var hasConfiguredSession = false
    /// Message ids already sounded for, so one message arriving over two
    /// transports is still one sound.
    private var sounded: [String: Date] = [:]

    private init() {}

    /// Plays a cue, once per message.
    ///
    /// `messageID` nil means "there is nothing to deduplicate against" — the
    /// operator's own send, which happens once by construction.
    func play(_ cue: Cue, messageID: String? = nil) {
        guard Self.isEnabled else { return }

        if let messageID {
            let now = Date()
            // Cheap, bounded prune: anything older than the window cannot
            // still be a duplicate of something in flight.
            sounded = sounded.filter { now.timeIntervalSince($0.value) < 20 }
            if sounded[messageID] != nil { return }
            sounded[messageID] = now
        }

        configureSessionIfNeeded()
        guard let player = player(for: cue) else { return }
        player.currentTime = 0
        player.play()
    }

    private func player(for cue: Cue) -> AVAudioPlayer? {
        if let existing = players[cue] { return existing }
        // Both spellings, because whether a folder inside `Resources` is
        // flattened into the bundle root or kept as a directory is a
        // build-setting detail, and a silent app is a poor way to find out
        // which one this project does.
        let url = Bundle.main.url(forResource: cue.rawValue, withExtension: "wav")
            ?? Bundle.main.url(forResource: cue.rawValue, withExtension: "wav", subdirectory: "Sounds")
        guard let url, let player = try? AVAudioPlayer(contentsOf: url) else { return nil }
        player.prepareToPlay()
        players[cue] = player
        return player
    }

    /// `.ambient` with `.mixWithOthers`, and only once.
    ///
    /// `.ambient` is the category that is silenced by the Ring/Silent switch,
    /// which is the control an operator already knows how to reach — and
    /// mixing means a seventy-millisecond blip never pauses whatever they
    /// are listening to.
    ///
    /// Skipped outright while a call owns the session. LiveKit puts the
    /// session into `.playAndRecord` for the duration of a call, and quietly
    /// replacing that with `.ambient` to play a notification tone would take
    /// the microphone away from a conversation in progress.
    private func configureSessionIfNeeded() {
        guard !hasConfiguredSession else { return }
        let session = AVAudioSession.sharedInstance()
        guard session.category != .playAndRecord else { return }
        try? session.setCategory(.ambient, options: [.mixWithOthers])
        hasConfiguredSession = true
    }
}
