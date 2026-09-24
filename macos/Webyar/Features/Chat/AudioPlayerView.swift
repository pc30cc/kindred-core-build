import AVFoundation
import SwiftUI

/// Plays a voice note inside the conversation: the file is fetched with the
/// operator's session (attachments are private) and played from memory. A
/// waveform shows the position and seeks on click; one note plays at a time.
struct AudioPlayerView: View {
    let attachment: AttachmentInfo
    let outgoing: Bool
    @State private var player = NotePlayer()
    @Environment(AppModel.self) private var app

    private static let bars = 38

    var body: some View {
        HStack(spacing: 10) {
            Button { Task { await player.toggle(attachment) } } label: {
                ZStack {
                    Circle().fill(outgoing ? Color.white : Palette.brand)
                    if player.loading {
                        ProgressView().controlSize(.small).tint(outgoing ? Palette.brand : .white)
                    } else {
                        Image(systemName: player.failed ? "exclamationmark" : (player.playing ? "pause.fill" : "play.fill"))
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(outgoing ? Palette.brand : .white)
                            .offset(x: player.playing || player.failed ? 0 : 1)
                    }
                }
                .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .help(player.failed ? app.strings["audioUnsupported"] : "")

            GeometryReader { geo in
                let heights = Self.shape(attachment.id)
                let played = Int((player.fraction * Double(Self.bars)).rounded())
                HStack(alignment: .center, spacing: 2) {
                    ForEach(0..<Self.bars, id: \.self) { i in
                        Capsule()
                            .fill(i < played ? (outgoing ? Color.white : Palette.brand) : (outgoing ? Color.white.opacity(0.45) : Palette.waveIn))
                            .frame(width: 3, height: heights[i])
                    }
                }
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .onTapGesture { loc in player.seek(to: min(1, max(0, loc.x / max(1, geo.size.width)))) }
            }
            .frame(width: CGFloat(Self.bars) * 5, height: 30)

            Text(player.timeText(fallback: attachment.sizeText))
                .appFont(11)
                .monospacedDigit()
                .foregroundStyle(outgoing ? Color.white.opacity(0.8) : Palette.text3)
                .frame(minWidth: 40, alignment: .leading)
        }
        .environment(\.layoutDirection, .leftToRight)
        .padding(.leading, 9)
        .padding(.trailing, 14)
        .padding(.vertical, 9)
        .background {
            let shape = Capsule()
            if outgoing { shape.fill(Palette.bubbleOutgoing) } else { shape.fill(Palette.bubbleIncoming).overlay(shape.strokeBorder(Palette.bubbleIncomingBorder, lineWidth: 1)) }
        }
        .onDisappear { player.stop() }
    }

    /// A stable, speech-like outline per note: louder in the middle, tapering at both ends.
    static func shape(_ seed: String) -> [CGFloat] {
        var rng = SeededRandom(seed: UInt64(Palette.hash(seed)))
        var prev = 0.5
        return (0..<bars).map { i in
            let envelope = sin(Double.pi * (Double(i) + 0.5) / Double(bars)) * 0.55 + 0.45
            let v = prev * 0.45 + rng.next() * 0.55
            prev = v
            return CGFloat(max(4, (4 + 22 * v * envelope).rounded()))
        }
    }
}

struct SeededRandom {
    private var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E3779B97F4A7C15 }
    mutating func next() -> Double {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Double(state >> 11) / Double(1 << 53)
    }
}

@MainActor
@Observable
final class NotePlayer: NSObject, AVAudioPlayerDelegate {
    @ObservationIgnored private static weak var current: NotePlayer?
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var timer: Timer?

    private(set) var playing = false
    private(set) var loading = false
    private(set) var failed = false
    private(set) var fraction: Double = 0
    private(set) var position: TimeInterval = 0
    private(set) var duration: TimeInterval = 0

    func toggle(_ a: AttachmentInfo) async {
        if player == nil {
            loading = true
            defer { loading = false }
            do {
                let data = try await AttachmentStore.shared.data(a.id)
                let p = try AVAudioPlayer(data: data)
                p.delegate = self
                p.prepareToPlay()
                player = p
                duration = p.duration
            } catch {
                Log.write("[audio] cannot play \(a.mimeType): \(error)")
                failed = true
                return
            }
        }
        guard let player else { return }
        if player.isPlaying {
            player.pause()
            setPlaying(false)
            return
        }
        if let other = Self.current, other !== self { other.stop() }
        Self.current = self
        player.play()
        setPlaying(true)
    }

    func seek(to f: Double) {
        guard let player, player.duration > 0 else { return }
        player.currentTime = player.duration * f
        tick()
    }

    func stop() {
        player?.pause()
        setPlaying(false)
    }

    private func setPlaying(_ on: Bool) {
        playing = on
        timer?.invalidate()
        timer = nil
        if on {
            timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        }
        tick()
    }

    private func tick() {
        guard let player else { return }
        position = player.currentTime
        fraction = player.duration > 0 ? player.currentTime / player.duration : 0
    }

    func timeText(fallback: String) -> String {
        guard duration > 0 else { return fallback.isEmpty ? "0:00" : fallback }
        let shown = playing || position > 0 ? position : duration
        return Self.format(shown) + (playing || position > 0 ? " / " + Self.format(duration) : "")
    }

    private static func format(_ t: TimeInterval) -> String {
        let s = Int(t.rounded(.down))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.player?.currentTime = 0
            self.setPlaying(false)
            self.position = 0
            self.fraction = 0
        }
    }
}
