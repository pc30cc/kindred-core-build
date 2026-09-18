import SwiftUI
import AVFoundation
import AVKit
import QuickLook

// MARK: - Fetching

/// Attachment bytes, fetched once and kept.
///
/// Media cannot be loaded by `AsyncImage` or handed straight to `AVPlayer`
/// here: the stream endpoint authorizes on the operator's bearer token and
/// neither of those can carry a header. So every file is fetched by hand,
/// and it is fetched once — a 1.6 MB photo re-downloaded every time a row is
/// rebuilt is the difference between a chat that feels native and one that
/// does not.
actor AttachmentStore {
    static let shared = AttachmentStore()

    /// `NSCache` rather than a dictionary because it gives the bytes back when
    /// the system is short of memory, which is not a moment we could pick
    /// better ourselves.
    private let cache = NSCache<NSString, NSData>()
    /// One request per attachment, however many views ask at once.
    private var inFlight: [String: Task<Data, Error>] = [:]

    private init() {
        cache.totalCostLimit = 48 * 1024 * 1024
    }

    func data(for id: String, api: any WebyarAPI) async throws -> Data {
        if let hit = cache.object(forKey: id as NSString) { return hit as Data }
        if let running = inFlight[id] { return try await running.value }

        let task = Task<Data, Error> { try await api.attachmentData(id: id) }
        inFlight[id] = task
        defer { inFlight[id] = nil }

        let data = try await task.value
        cache.setObject(data as NSData, forKey: id as NSString, cost: data.count)
        return data
    }

    /// Writes the bytes somewhere `AVPlayer` can open them.
    ///
    /// `AVPlayer` reads from a URL, not from memory, and the one URL it must
    /// never be given is the server's — it would arrive without the operator's
    /// token. A file in the caches directory, named by the attachment, is the
    /// shortest honest path to a working player.
    func fileURL(for id: String, fileExtension: String, api: any WebyarAPI) async throws -> URL {
        let bytes = try await data(for: id, api: api)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("attachments", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(id).appendingPathExtension(fileExtension)
        if !FileManager.default.fileExists(atPath: url.path) {
            try bytes.write(to: url, options: .atomic)
        }
        return url
    }
}

/// What a single attachment view knows about its bytes.
private enum MediaState {
    case loading
    case ready(Data)
    case failed
}

// MARK: - Entry point

/// One file under a message: a photo, a voice note, a video, a document.
struct AttachmentView: View {
    let attachment: MessageAttachment
    let isOutgoing: Bool
    let language: Language

    var body: some View {
        switch attachment.resolvedKind {
        case .image:
            ImageAttachmentView(attachment: attachment, language: language)
        case .audio:
            VoiceNoteView(attachment: attachment, isOutgoing: isOutgoing, language: language)
        case .video:
            VideoAttachmentView(attachment: attachment, language: language)
        case .file:
            FileAttachmentView(attachment: attachment, isOutgoing: isOutgoing, language: language)
        }
    }
}

// MARK: - Image

/// A photo, at its own proportions inside a fixed box, opening full screen.
private struct ImageAttachmentView: View {
    let attachment: MessageAttachment
    let language: Language

    @State private var state: MediaState = .loading
    @State private var isOpen = false

    private var image: UIImage? {
        guard case .ready(let data) = state else { return nil }
        return UIImage(data: data)
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 220, maxHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
                    .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
                    .onTapGesture { isOpen = true }
            } else if case .failed = state {
                FileCard(
                    icon: "photo",
                    title: attachment.displayName ?? Str.photo(language),
                    subtitle: Str.attachmentFailed(language),
                    isOutgoing: false
                )
            } else {
                placeholder
            }
        }
        .task { await load() }
        .fullScreenCover(isPresented: $isOpen) {
            if let image {
                ImageViewer(image: image, language: language)
            }
        }
    }

    /// A box the size the photo will be, so the bubble does not jump when the
    /// bytes land.
    private var placeholder: some View {
        RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
            .fill(Theme.Palette.surfaceElevated)
            .frame(width: 180, height: 132)
            .overlay {
                Label(Str.receivingFile(language), systemImage: "arrow.down.circle")
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
            }
    }

    private func load() async {
        guard case .loading = state else { return }
        do {
            let data = try await AttachmentStore.shared.data(for: attachment.id, api: Backend.current)
            state = .ready(data)
        } catch {
            state = .failed
        }
    }
}

/// Full-screen photo, pinchable, dismissed by tapping the close button or
/// swiping down — the two gestures everyone already tries.
private struct ImageViewer: View {
    let image: UIImage
    let language: Language
    @Environment(\.dismiss) private var dismiss

    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()

            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(max(1, zoom * pinch))
                .gesture(
                    MagnificationGesture()
                        .updating($pinch) { value, state, _ in state = value }
                        .onEnded { value in zoom = max(1, zoom * value) }
                )
                .onTapGesture(count: 2) {
                    withAnimation(Theme.Motion.standard) { zoom = zoom > 1 ? 1 : 2.5 }
                }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(.white.opacity(0.18)))
            }
            .padding(Theme.Space.lg)
            .accessibilityLabel(Str.close(language))
        }
        .preferredColorScheme(.dark)
    }
}

// MARK: - Voice note

/// A recording, with the transport every phone has taught people to expect.
///
/// The transport is forced left-to-right. A timeline reads left→right in every
/// locale — play on the left, progress filling rightwards — and the console
/// does the same thing for the same reason.
private struct VoiceNoteView: View {
    let attachment: MessageAttachment
    let isOutgoing: Bool
    let language: Language

    @State private var player: AudioNotePlayer?
    @State private var state: MediaState = .loading
    @State private var unsupported = false

    private var tint: Color {
        isOutgoing ? Theme.Palette.bubbleOutgoingText : Theme.Palette.bubbleIncomingText
    }

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            button
            timeline
        }
        .environment(\.layoutDirection, .leftToRight)
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm + 2)
        .frame(width: 236)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(isOutgoing ? Theme.Palette.bubbleOutgoing : Theme.Palette.bubbleIncoming)
        )
        .task { await load() }
        .onDisappear { player?.stop() }
    }

    @ViewBuilder
    private var button: some View {
        if let player {
            Button {
                player.toggle()
            } label: {
                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(tint.opacity(0.14)))
            }
            .buttonStyle(.plain)
        } else {
            Image(systemName: unsupported ? "waveform.slash" : "waveform")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tint.opacity(0.5))
                .frame(width: 32, height: 32)
                .background(Circle().fill(tint.opacity(0.08)))
        }
    }

    @ViewBuilder
    private var timeline: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let player {
                track(progress: player.progress)
                Text(Format.voiceTime(player.displayedSeconds, locale: language.locale))
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(tint.opacity(0.7))
            } else {
                track(progress: 0)
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(tint.opacity(0.7))
                    .lineLimit(1)
            }
        }
    }

    private var caption: String {
        if unsupported { return Str.playbackUnsupported(language) }
        if case .failed = state { return Str.attachmentFailed(language) }
        return Str.receivingFile(language)
    }

    private func track(progress: Double) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(tint.opacity(0.18))
                Capsule()
                    .fill(tint.opacity(0.85))
                    .frame(width: max(0, min(1, progress)) * geo.size.width)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0).onChanged { value in
                    guard geo.size.width > 0 else { return }
                    player?.seek(to: value.location.x / geo.size.width)
                }
            )
        }
        .frame(height: 4)
    }

    private func load() async {
        guard case .loading = state, player == nil else { return }
        do {
            let data = try await AttachmentStore.shared.data(for: attachment.id, api: Backend.current)
            state = .ready(data)
            // A format with no decoder on this phone — an Opus note from
            // Telegram, say — throws here. The file is not broken and the
            // operator should be told which of the two it is.
            guard let made = AudioNotePlayer(data: data) else {
                unsupported = true
                return
            }
            player = made
        } catch {
            state = .failed
        }
    }
}

/// Owns one `AVAudioPlayer` and the tick that moves the progress bar.
@MainActor
@Observable
final class AudioNotePlayer {
    private let player: AVAudioPlayer
    private var ticker: Task<Void, Never>?

    private(set) var isPlaying = false
    private(set) var elapsed: TimeInterval = 0

    var duration: TimeInterval { player.duration }

    /// The number under the bar: how far in while playing, how long in total
    /// while stopped — which is what every voice note does.
    var displayedSeconds: TimeInterval { isPlaying || elapsed > 0 ? elapsed : duration }

    var progress: Double {
        guard duration > 0 else { return 0 }
        return elapsed / duration
    }

    init?(data: Data) {
        guard let player = try? AVAudioPlayer(data: data) else { return nil }
        self.player = player
        player.prepareToPlay()
    }

    func toggle() {
        if player.isPlaying {
            player.pause()
            isPlaying = false
            ticker?.cancel()
            return
        }
        // Playback shares the session with calls, so ask for it rather than
        // reconfiguring: a voice note must never leave the category in a
        // state that breaks the next call.
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)

        // Replaying after it finished starts from the top, not from the end.
        if player.currentTime >= player.duration - 0.05 { player.currentTime = 0 }
        player.play()
        isPlaying = true
        startTicking()
    }

    func seek(to ratio: Double) {
        let clamped = max(0, min(1, ratio))
        player.currentTime = clamped * player.duration
        elapsed = player.currentTime
    }

    func stop() {
        player.stop()
        isPlaying = false
        ticker?.cancel()
        ticker = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func startTicking() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(80))
                guard let self else { return }
                self.elapsed = self.player.currentTime
                if !self.player.isPlaying {
                    self.isPlaying = false
                    // Finished rather than paused: park the bar at the end so
                    // it does not look like it stopped halfway.
                    if self.player.currentTime >= self.player.duration - 0.05 {
                        self.elapsed = self.player.duration
                    }
                    return
                }
            }
        }
    }
}

// MARK: - Video

private struct VideoAttachmentView: View {
    let attachment: MessageAttachment
    let language: Language

    @State private var url: URL?
    @State private var failed = false

    var body: some View {
        Group {
            if let url {
                VideoPlayer(player: AVPlayer(url: url))
                    .frame(width: 240, height: 160)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
            } else if failed {
                FileCard(
                    icon: "video",
                    title: attachment.displayName ?? Str.videoFile(language),
                    subtitle: Str.attachmentFailed(language),
                    isOutgoing: false
                )
            } else {
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(Theme.Palette.surfaceElevated)
                    .frame(width: 240, height: 160)
                    .overlay {
                        Label(Str.receivingFile(language), systemImage: "arrow.down.circle")
                            .font(Theme.Typo.meta)
                            .foregroundStyle(Theme.Palette.labelSecondary)
                    }
            }
        }
        .task {
            guard url == nil, !failed else { return }
            do {
                url = try await AttachmentStore.shared.fileURL(
                    for: attachment.id,
                    fileExtension: AttachmentFormat.fileExtension(for: attachment) ?? "mp4",
                    api: Backend.current
                )
            } catch {
                failed = true
            }
        }
    }
}

// MARK: - Everything else

/// A document: what it is, how big, and — on a tap — what is in it.
///
/// A card the operator cannot open is half a feature. Quick Look is the
/// system's own reader and already knows PDFs, Office files, text and
/// archives, so the file only has to be put on disk for it.
private struct FileAttachmentView: View {
    let attachment: MessageAttachment
    let isOutgoing: Bool
    let language: Language

    @State private var url: URL?
    @State private var isOpening = false
    @State private var failed = false

    var body: some View {
        Button {
            Task { await open() }
        } label: {
            FileCard(
                icon: failed ? "doc.badge.ellipsis" : "doc.fill",
                title: attachment.displayName ?? Str.file(language),
                subtitle: subtitle,
                isOutgoing: isOutgoing
            )
        }
        .buttonStyle(.plain)
        .quickLookPreview($url)
    }

    private var subtitle: String? {
        if failed { return Str.attachmentFailed(language) }
        if isOpening { return Str.receivingFile(language) }
        return attachment.sizeBytes.map { Format.fileSize($0, language: language) }
    }

    private func open() async {
        guard !isOpening else { return }
        isOpening = true
        failed = false
        defer { isOpening = false }
        do {
            url = try await AttachmentStore.shared.fileURL(
                for: attachment.id,
                fileExtension: AttachmentFormat.fileExtension(for: attachment) ?? "dat",
                api: Backend.current
            )
        } catch {
            failed = true
        }
    }
}

/// The shared shape for anything that is not drawn as media.
private struct FileCard: View {
    let icon: String
    let title: String
    var subtitle: String?
    let isOutgoing: Bool

    private var tint: Color {
        isOutgoing ? Theme.Palette.bubbleOutgoingText : Theme.Palette.bubbleIncomingText
    }

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(tint)
                .frame(width: 32, height: 32)
                .background(Circle().fill(tint.opacity(0.14)))

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(Theme.Typo.rowTitle)
                    .foregroundStyle(tint)
                    .lineLimit(1)
                    .truncationMode(.middle)

                if let subtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(tint.opacity(0.7))
                }
            }
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .frame(maxWidth: 236, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(isOutgoing ? Theme.Palette.bubbleOutgoing : Theme.Palette.bubbleIncoming)
        )
    }
}

/// Maps a MIME type onto a file extension, which is the only thing `AVPlayer`
/// uses to decide how to open a file on disk.
enum AttachmentFormat {
    static func fileExtension(for attachment: MessageAttachment) -> String? {
        // The name is checked before the MIME type because it is the more
        // specific of the two — but only when it really carries an extension.
        // A widget voice note arrives named `m4a`, with no dot in it at all.
        if let name = attachment.fileName,
           let dot = name.lastIndex(of: "."),
           dot < name.index(before: name.endIndex) {
            return String(name[name.index(after: dot)...])
        }
        switch attachment.mimeType {
        case "video/mp4", "video/quicktime": return "mp4"
        case "video/webm": return "webm"
        case "audio/mp4", "audio/m4a", "audio/x-m4a": return "m4a"
        case "audio/mpeg": return "mp3"
        default: return nil
        }
    }
}
