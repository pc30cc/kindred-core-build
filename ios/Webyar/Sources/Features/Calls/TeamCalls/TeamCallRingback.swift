import AVFoundation
import Foundation

/// The caller's ringback on a colleague call: the tone heard while the
/// colleague's phone rings, and only then — not while the call is still
/// "Calling…" (owner, 2026-11-04: nothing says it rings before the other
/// phone does; `CallManager.syncRingback`).
///
/// The web panel's tone (`src/features/calls/callSound.ts`, `ringOnce`): a
/// soft two-tone warble, A4 and E5 twice, every 1.9 s. Made here as PCM in
/// memory rather than shipped as a file, as the web makes it in the page.
///
/// It plays into the call's own audio session, which CallKit activated: on
/// the earpiece for a voice call, the loudspeaker for a video call — as a
/// phone's own ringback is heard. Main-actor, as the manager that drives it.
@MainActor
final class TeamCallRingback {
    private var player: AVAudioPlayer?

    var isPlaying: Bool { player?.isPlaying == true }

    func start() {
        guard !isPlaying else { return }
        if player == nil {
            player = try? AVAudioPlayer(data: RingbackTone.wav)
            player?.numberOfLoops = -1
            player?.volume = 0.6
            player?.prepareToPlay()
        }
        player?.currentTime = 0
        player?.play()
    }

    func stop() {
        player?.stop()
        player = nil
    }
}

/// The ringback's sound: one cycle as a WAV file, made once.
enum RingbackTone {
    private static let sampleRate = 22_050
    /// One cycle: the four notes, then silence until the next.
    private static let period: Double = 1.9
    /// `ringOnce`'s notes: frequency, start, length (seconds).
    private static let notes: [(frequency: Double, at: Double, length: Double)] = [
        (440.0, 0.0, 0.22),
        (659.25, 0.22, 0.22),
        (440.0, 0.46, 0.22),
        (659.25, 0.68, 0.22),
    ]

    /// A WAV file of one cycle: 16-bit mono PCM.
    static let wav: Data = {
        let count = Int(Double(sampleRate) * period)
        var samples = [Int16](repeating: 0, count: count)
        for note in notes {
            let start = Int(note.at * Double(sampleRate))
            let length = Int(note.length * Double(sampleRate))
            for i in 0..<length where start + i < count {
                let t = Double(i) / Double(sampleRate)
                // 30 ms in, then an exponential fall to silence, as the web's
                // gain ramps.
                let attack = min(1, t / 0.03)
                let decay = t < 0.03 ? 1 : exp(-(t - 0.03) * 22)
                let value = sin(2 * .pi * note.frequency * t) * attack * decay * 0.5
                samples[start + i] = Int16(max(-1, min(1, value)) * Double(Int16.max))
            }
        }
        return encode(samples)
    }()

    private static func encode(_ samples: [Int16]) -> Data {
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        let bytes = samples.count * 2
        data.append(contentsOf: Array("RIFF".utf8))
        append(UInt32(36 + bytes))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        append(UInt32(16))
        append(UInt16(1)) // PCM
        append(UInt16(1)) // mono
        append(UInt32(sampleRate))
        append(UInt32(sampleRate * 2))
        append(UInt16(2))
        append(UInt16(16))
        data.append(contentsOf: Array("data".utf8))
        append(UInt32(bytes))
        for sample in samples { append(sample) }
        return data
    }
}
