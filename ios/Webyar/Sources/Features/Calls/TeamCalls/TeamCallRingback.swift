import AVFoundation
import Foundation

/// The caller's ringback on a colleague call: the tone heard while the
/// colleague's phone rings, and only then — not while the call is still
/// "Calling…" (owner, 2026-11-04: nothing says it rings before the other
/// phone does; `CallManager.syncRingback`).
///
/// The web panel's notes (`src/features/calls/callSound.ts`, `ringOnce`),
/// A4 and E5 twice, held fuller and longer, every 3 s (owner, 2026-11-05:
/// the short quiet beeps were not heard). Made here as PCM in memory rather
/// than shipped as a file, as the web makes it in the page.
///
/// It plays into the call's own audio session, which CallKit activated. A
/// voice call rings out on the loudspeaker away from the ear and on the
/// earpiece at it, until the member uses the Speaker control; a video call
/// on the loudspeaker (`CallManager.applyRoute`). Main-actor, as the manager
/// that drives it.
@MainActor
final class TeamCallRingback {
    private var player: AVAudioPlayer?

    var isPlaying: Bool { player?.isPlaying == true }

    func start() {
        guard !isPlaying else { return }
        if player == nil {
            player = try? AVAudioPlayer(data: RingbackTone.wav)
            player?.numberOfLoops = -1
            player?.volume = 1.0
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
    /// One cycle: about a second and a half of tone, then quiet until the
    /// next — a ringback's rhythm, heard at arm's length.
    private static let period: Double = 3.0
    /// The web's two notes (A4, E5), held longer and fuller: each is the
    /// note with a soft octave over it, so it carries on a phone's speaker.
    private static let notes: [(frequency: Double, at: Double, length: Double)] = [
        (440.0, 0.0, 0.38),
        (659.25, 0.38, 0.38),
        (440.0, 0.80, 0.38),
        (659.25, 1.18, 0.38),
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
                // 20 ms in, held, 60 ms out: no click, and loud for most of
                // the note rather than a blip.
                let attack = min(1, t / 0.02)
                let release = min(1, max(0, (note.length - t) / 0.06))
                let tone = sin(2 * .pi * note.frequency * t) + 0.35 * sin(4 * .pi * note.frequency * t)
                let value = tone / 1.35 * attack * release * 0.85
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
