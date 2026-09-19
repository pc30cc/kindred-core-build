import Foundation
import AVFoundation
import Observation

/// Records a voice note the operator can send.
///
/// Deliberately AAC in an MP4 container: `audio/mp4` is on the server's
/// allowed list (`server/routes/conversationAttachments.ts`), it is what
/// Safari's `MediaRecorder` produces so the console already sends the same
/// thing, and every platform that might play it back has a decoder. The other
/// formats iOS records natively — CAF, AIFF — are on nobody's allowed list.
@MainActor
@Observable
final class VoiceRecorder {

    enum Failure: Equatable {
        /// The operator said no to the microphone, or it is off in Settings.
        case permissionDenied
        /// Recording would not start at all.
        case unavailable
    }

    private(set) var isRecording = false
    private(set) var seconds: TimeInterval = 0
    private(set) var failure: Failure?

    /// Five minutes, matching the console's recorder. A voice note longer
    /// than that is a phone call somebody should have made instead.
    static let maximumSeconds: TimeInterval = 300

    var mimeType: String { "audio/mp4" }
    var fileName: String { "voice-note.m4a" }

    private var recorder: AVAudioRecorder?
    private var ticker: Task<Void, Never>?
    private var url: URL?

    /// Asks for the microphone and starts. The permission prompt is the
    /// system's, and the text in it is the one in `InfoPlist.strings`.
    func start() async {
        guard !isRecording else { return }
        failure = nil

        guard await Self.requestPermission() else {
            failure = .permissionDenied
            return
        }

        let session = AVAudioSession.sharedInstance()
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-\(UUID().uuidString).m4a")

        do {
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)

            let recorder = try AVAudioRecorder(
                url: destination,
                settings: [
                    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                    // Voice, not music: 24 kHz mono at 48 kbps is clear and
                    // keeps a two-minute note well inside a megabyte.
                    AVSampleRateKey: 24_000,
                    AVNumberOfChannelsKey: 1,
                    AVEncoderBitRateKey: 48_000,
                ]
            )
            recorder.record(forDuration: Self.maximumSeconds)
            self.recorder = recorder
            self.url = destination
            isRecording = true
            startTicking()
        } catch {
            failure = .unavailable
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// Stops and hands back what was recorded, or nil if there is nothing
    /// worth sending.
    func finish() -> Data? {
        defer { cleanUp() }
        guard let recorder, let url else { return nil }
        recorder.stop()
        // Under a second is a mis-tap, not a message.
        guard seconds >= 1, let data = try? Data(contentsOf: url) else { return nil }
        return data
    }

    /// Throws the recording away — the operator changed their mind.
    func cancel() {
        recorder?.stop()
        cleanUp()
    }

    private func cleanUp() {
        ticker?.cancel()
        ticker = nil
        if let url { try? FileManager.default.removeItem(at: url) }
        url = nil
        recorder = nil
        isRecording = false
        seconds = 0
        try? AVAudioSession.sharedInstance()
            .setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func startTicking() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self, let recorder = self.recorder else { return }
                self.seconds = recorder.currentTime
                // `record(forDuration:)` stops on its own at the cap; follow
                // it rather than letting the timer run past the audio.
                if !recorder.isRecording {
                    self.isRecording = false
                    return
                }
            }
        }
    }

    /// The app's floor is iOS 17, which is exactly where this spelling
    /// arrived — so there is no older branch to keep.
    private static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }
}
