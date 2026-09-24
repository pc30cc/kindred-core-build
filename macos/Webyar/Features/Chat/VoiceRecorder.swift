import AVFoundation
import Foundation
import Observation

/// Records a voice note to AAC in an .m4a, the format every channel plays.
@MainActor
@Observable
final class VoiceRecorder {
    enum Failure: Error { case denied, failed }

    private(set) var isRecording = false
    private(set) var elapsed: TimeInterval = 0

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var url: URL?
    @ObservationIgnored private var started = Date()
    @ObservationIgnored private var timer: Timer?

    func start() async throws {
        guard !isRecording else { return }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .audio) else { throw Failure.denied }
        default: throw Failure.denied
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        let r = try AVAudioRecorder(url: file, settings: settings)
        guard r.record() else { throw Failure.failed }
        recorder = r
        url = file
        started = Date()
        elapsed = 0
        isRecording = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isRecording else { return }
                self.elapsed = Date().timeIntervalSince(self.started)
            }
        }
    }

    /// Stops and hands back the file and its length.
    func stop() -> (Data, TimeInterval)? {
        guard isRecording, let recorder, let url else { return nil }
        let length = Date().timeIntervalSince(started)
        recorder.stop()
        finish()
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (data, length)
    }

    func cancel() {
        recorder?.stop()
        if let url { try? FileManager.default.removeItem(at: url) }
        finish()
    }

    private func finish() {
        timer?.invalidate()
        timer = nil
        recorder = nil
        url = nil
        isRecording = false
    }
}
