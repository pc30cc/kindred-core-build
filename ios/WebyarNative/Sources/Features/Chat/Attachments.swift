import SwiftUI
import AVFoundation
import ImageIO
import AVKit
import QuickLook

// MARK: - Decoding

/// Photo previews, decoded once at the size a bubble draws them.
///
/// The bytes come from `AttachmentStore` (memory, disk, then the server).
/// What is kept here is the decoded picture, small: a bubble is at most 260
/// points, so a twelve-megapixel photo is decoded straight to 800 pixels —
/// a fraction of a megabyte of bitmap instead of fifty — with ImageIO, the
/// same way `ImageCache` decodes avatars. The full photo is decoded only when
/// the operator opens it.
///
/// On the main actor so a bubble scrolled back into view gets its picture in
/// the same frame, with no placeholder flash.
@MainActor
enum AttachmentPreviews {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = CachePolicy.attachmentPreviewCount
        return cache
    }()

    static func cached(_ id: String) -> UIImage? { cache.object(forKey: id as NSString) }
    static func store(_ image: UIImage, for id: String) { cache.setObject(image, forKey: id as NSString) }
    static func clear() { cache.removeAllObjects() }

    /// Decodes to at most `maxPixel` on the longest side, off the main thread.
    /// Nil when the bytes are not a picture.
    static func decode(_ data: Data, maxPixel: Int) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            Self.downsample(data, maxPixel: maxPixel)
        }.value
    }

    nonisolated static func downsample(_ data: Data, maxPixel: Int) -> UIImage? {
        // No cache of the full-size decode: only the thumbnail is ever built.
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: thumbnail)
    }
}

/// What a single attachment view knows about its picture.
private enum PreviewState {
    case loading
    case ready(UIImage)
    case failed
}

/// Holds a file open while something plays or shows it, so neither a trim
/// nor Clear Cache removes it from under the player.
private func pin(_ url: URL?) {
    guard let url else { return }
    Task { await AttachmentDiskCache.shared.pin(url) }
}

private func unpin(_ url: URL?) {
    guard let url else { return }
    Task { await AttachmentDiskCache.shared.unpin(url) }
}

// MARK: - Entry point

/// One file under a message: a photo, a voice note, a video, a document.
struct AttachmentView: View {
    let attachment: MessageAttachment
    let isOutgoing: Bool
    let language: Language
    /// True on the last thing drawn in the last message of a run, which is
    /// the one the avatar sits beside.
    var hasBeak: Bool = false

    var body: some View {
        switch attachment.resolvedKind {
        case .image:
            ImageAttachmentView(
                attachment: attachment, isOutgoing: isOutgoing,
                language: language, hasBeak: hasBeak
            )
        case .audio:
            VoiceNoteView(
                attachment: attachment, isOutgoing: isOutgoing,
                language: language, hasBeak: hasBeak
            )
        case .video:
            VideoAttachmentView(
                attachment: attachment, isOutgoing: isOutgoing,
                language: language, hasBeak: hasBeak
            )
        case .file:
            FileAttachmentView(
                attachment: attachment, isOutgoing: isOutgoing,
                language: language, hasBeak: hasBeak
            )
        }
    }
}

// MARK: - Image

/// A photo, at its own proportions inside a fixed box, opening full screen.
///
/// Photos are the one kind of file fetched as soon as the bubble is drawn —
/// a photo is content to be seen, not an action to take. What is decoded for
/// the bubble is a thumbnail; the viewer decodes a larger one when opened.
private struct ImageAttachmentView: View {
    let attachment: MessageAttachment
    let isOutgoing: Bool
    let language: Language
    let hasBeak: Bool

    @State private var state: PreviewState = .loading
    @State private var isOpen = false

    private var image: UIImage? {
        if case .ready(let image) = state { return image }
        // Already decoded for another bubble, or before a scroll: same frame.
        return AttachmentPreviews.cached(attachment.id)
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 220, maxHeight: 260)
                    // A photo is its own bubble, so the beak is cut out of it
                    // rather than drawn behind it.
                    .chatBubbleClip(hasBeak: hasBeak, pointsRight: isOutgoing)
                    .onTapGesture { isOpen = true }
            } else if case .failed = state {
                FileCard(
                    icon: "photo",
                    title: attachment.displayName ?? Str.photo(language),
                    subtitle: Str.attachmentFailed(language),
                    isOutgoing: isOutgoing,
                    hasBeak: hasBeak
                )
            } else {
                placeholder
            }
        }
        .task { await load() }
        .fullScreenCover(isPresented: $isOpen) {
            if let image {
                ImageViewer(attachment: attachment, preview: image, language: language)
            }
        }
    }

    /// A box the size the photo will be, so the bubble does not jump when the
    /// bytes land.
    private var placeholder: some View {
        ChatBubble(radius: Theme.Radius.lg, hasBeak: hasBeak, pointsRight: isOutgoing)
            .fill(Theme.Palette.surfaceElevated)
            .frame(width: 180, height: 132)
            .overlay {
                Label(Str.receivingFile(language), systemImage: "arrow.down.circle")
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
            }
    }

    private func load() async {
        if let cached = AttachmentPreviews.cached(attachment.id) {
            state = .ready(cached)
            return
        }
        guard case .loading = state else { return }
        do {
            let data = try await AttachmentStore.shared.data(for: attachment, api: Backend.current)
            if let decoded = await AttachmentPreviews.decode(data, maxPixel: CachePolicy.attachmentPreviewPixels) {
                AttachmentPreviews.store(decoded, for: attachment.id)
                state = .ready(decoded)
                return
            }
            // Not a picture after all — most likely a damaged copy on disk.
            // Dropped, and fetched from the server once more.
            await AttachmentStore.shared.discard(attachment)
            let fresh = try await AttachmentStore.shared.data(for: attachment, api: Backend.current)
            guard let decoded = await AttachmentPreviews.decode(fresh, maxPixel: CachePolicy.attachmentPreviewPixels) else {
                state = .failed
                return
            }
            AttachmentPreviews.store(decoded, for: attachment.id)
            state = .ready(decoded)
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed
        }
    }
}

/// Full-screen photo, pinchable, dismissed by tapping the close button or
/// swiping down — the two gestures everyone already tries.
private struct ImageViewer: View {
    let attachment: MessageAttachment
    /// The bubble's thumbnail, shown at once while the sharper one decodes.
    let preview: UIImage
    let language: Language
    @Environment(\.dismiss) private var dismiss

    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1
    @State private var full: UIImage?

    private var image: UIImage { full ?? preview }

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
        .task {
            // Sharp enough to zoom into, and still not the full bitmap of a
            // forty-megapixel original. The bytes are already in memory or on
            // disk from the bubble, so this does not fetch again.
            guard full == nil,
                  let data = try? await AttachmentStore.shared.data(for: attachment, api: Backend.current)
            else { return }
            full = await AttachmentPreviews.decode(data, maxPixel: CachePolicy.attachmentViewerPixels)
        }
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
    let hasBeak: Bool

    @State private var player: AudioNotePlayer?
    /// The file this note plays from, held open (pinned) while it can play.
    @State private var file: URL?
    @State private var isFetching = false
    @State private var failed = false
    @State private var unsupported = false
    /// Asked for with Play: start as soon as the file is here.
    @State private var playWhenReady = false

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
        .chatBubble(
            isOutgoing ? Theme.Palette.bubbleOutgoing : Theme.Palette.bubbleIncoming,
            hasBeak: hasBeak,
            pointsRight: isOutgoing
        )
        // Only a look at this phone's disk: a note already downloaded shows
        // its length at once. Nothing is fetched until Play is tapped.
        .task { await prepareFromDisk() }
        .onDisappear {
            player?.stop()
            unpin(file)
            file = nil
            player = nil
        }
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
        } else if isFetching {
            ProgressView()
                .tint(tint)
                .frame(width: 32, height: 32)
                .background(Circle().fill(tint.opacity(0.08)))
        } else if unsupported {
            Image(systemName: "waveform.slash")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tint.opacity(0.5))
                .frame(width: 32, height: 32)
                .background(Circle().fill(tint.opacity(0.08)))
        } else {
            // Play before the file is here: the tap is what downloads it.
            Button {
                Task { await fetchAndPlay() }
            } label: {
                Image(systemName: "play.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(tint.opacity(0.14)))
            }
            .buttonStyle(.plain)
        }
    }

    /// The bar and the line under it.
    ///
    /// The bar itself is forced left-to-right by the view around it, because
    /// a timeline runs left-to-right in every language — play on the left,
    /// progress filling rightwards. The line *under* it is ordinary prose and
    /// does not: in Persian it belongs on the right, like every other piece
    /// of text in the app. Letting the bar's direction leak into it was what
    /// stranded the duration on the wrong side.
    @ViewBuilder
    private var timeline: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let player {
                track(progress: player.progress)
                caption(Format.voiceTime(player.displayedSeconds, locale: language.locale))
                    .monospacedDigit()
            } else {
                track(progress: 0)
                caption(loadingText)
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(tint.opacity(0.7))
            .lineLimit(1)
            // Which end of the bar this sits under is decided physically, not
            // by an alignment constant: `.trailing` means "right" only in a
            // left-to-right context, so setting the direction *and* the
            // alignment from the language cancels the two out and the caption
            // lands back on the left. The direction is pinned, the side is
            // chosen.
            .frame(maxWidth: .infinity, alignment: isRightToLeft ? .trailing : .leading)
            .environment(\.layoutDirection, .leftToRight)
    }

    private var isRightToLeft: Bool {
        language.layoutDirection == .rightToLeft
    }

    private var loadingText: String {
        if unsupported { return Str.playbackUnsupported(language) }
        if failed { return Str.attachmentFailed(language) }
        if isFetching { return Str.receivingFile(language) }
        // Not downloaded yet: how much tapping Play will cost.
        return attachment.sizeBytes.map { Format.fileSize($0, language: language) } ?? Str.voiceNote(language)
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

    private func prepareFromDisk() async {
        guard player == nil, !unsupported,
              let saved = await AttachmentStore.shared.cachedFileURL(for: attachment),
              !Task.isCancelled
        else { return }
        adopt(saved)
    }

    private func fetchAndPlay() async {
        guard !isFetching, player == nil else { return }
        isFetching = true
        failed = false
        defer { isFetching = false }
        do {
            let url = try await AttachmentStore.shared.fileURL(for: attachment, api: Backend.current)
            adopt(url)
            player?.toggle()
        } catch {
            failed = true
        }
    }

    private func adopt(_ url: URL) {
        // A format with no decoder on this phone — an Opus note from
        // Telegram, say — fails here. The file is not broken and the
        // operator should be told which of the two it is.
        guard let made = AudioNotePlayer(url: url) else {
            unsupported = true
            return
        }
        pin(url)
        file = url
        player = made
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

    /// Plays from the file on disk rather than from a copy in memory.
    init?(url: URL) {
        guard let player = try? AVAudioPlayer(contentsOf: url) else { return nil }
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

/// A video: nothing is downloaded until the operator taps it.
///
/// Then it is downloaded straight to a file (never held whole in memory) and
/// played from there, and the file is kept — a video opened once plays again
/// at once, relaunches included, with no second download. One `AVPlayer`
/// per bubble, made once; it used to be rebuilt on every redraw.
private struct VideoAttachmentView: View {
    let attachment: MessageAttachment
    let isOutgoing: Bool
    let language: Language
    let hasBeak: Bool

    @State private var player: AVPlayer?
    @State private var file: URL?
    @State private var isFetching = false
    @State private var failed = false

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
                    .frame(width: 240, height: 160)
                    .chatBubbleClip(hasBeak: hasBeak, pointsRight: isOutgoing)
            } else if failed {
                Button {
                    Task { await fetchAndPlay() }
                } label: {
                    FileCard(
                        icon: "video",
                        title: attachment.displayName ?? Str.videoFile(language),
                        subtitle: Str.attachmentFailed(language),
                        isOutgoing: isOutgoing,
                        hasBeak: hasBeak
                    )
                }
                .buttonStyle(.plain)
            } else {
                Button {
                    Task { await fetchAndPlay() }
                } label: {
                    ChatBubble(radius: Theme.Radius.lg, hasBeak: hasBeak, pointsRight: isOutgoing)
                        .fill(Theme.Palette.surfaceElevated)
                        .frame(width: 240, height: 160)
                        .overlay { poster }
                }
                .buttonStyle(.plain)
            }
        }
        // Already on this phone: ready to play, from disk, without a tap to download.
        .task {
            guard player == nil, let saved = await AttachmentStore.shared.cachedFileURL(for: attachment),
                  !Task.isCancelled else { return }
            adopt(saved, autoplay: false)
        }
        .onDisappear {
            player?.pause()
            unpin(file)
            file = nil
            player = nil
        }
    }

    @ViewBuilder
    private var poster: some View {
        if isFetching {
            Label(Str.receivingFile(language), systemImage: "arrow.down.circle")
                .font(Theme.Typo.meta)
                .foregroundStyle(Theme.Palette.labelSecondary)
        } else {
            VStack(spacing: Theme.Space.xs) {
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                if let size = attachment.sizeBytes {
                    Text(Format.fileSize(size, language: language))
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(attachment.displayName ?? Str.videoFile(language))
        }
    }

    private func fetchAndPlay() async {
        guard !isFetching, player == nil else { return }
        isFetching = true
        failed = false
        defer { isFetching = false }
        do {
            let url = try await AttachmentStore.shared.fileURL(for: attachment, api: Backend.current)
            adopt(url, autoplay: true)
        } catch {
            failed = true
        }
    }

    private func adopt(_ url: URL, autoplay: Bool) {
        pin(url)
        file = url
        let made = AVPlayer(url: url)
        player = made
        if autoplay { made.play() }
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
    let hasBeak: Bool

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
                isOutgoing: isOutgoing,
                hasBeak: hasBeak
            )
        }
        .buttonStyle(.plain)
        .quickLookPreview($url)
        // Held open while Quick Look shows it; let go when it closes.
        .onChange(of: url) { old, new in
            unpin(old)
            pin(new)
        }
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
            // From this phone's disk when it was opened before; downloaded
            // (straight to a file) only the first time.
            url = try await AttachmentStore.shared.fileURL(for: attachment, api: Backend.current)
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
    var hasBeak: Bool = false

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
        .chatBubble(
            isOutgoing ? Theme.Palette.bubbleOutgoing : Theme.Palette.bubbleIncoming,
            hasBeak: hasBeak,
            pointsRight: isOutgoing
        )
    }
}
