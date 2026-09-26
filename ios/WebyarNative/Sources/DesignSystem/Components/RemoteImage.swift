import SwiftUI
import UIKit
import ImageIO

/// One picture, fetched once.
///
/// `AsyncImage` is the obvious choice and it is the wrong one for a list. It
/// holds nothing across a view's lifetime, so every time a row scrolls off and
/// back it starts the download again — and between the row appearing and the
/// bytes arriving it shows its placeholder. In a scrolling inbox that reads as
/// faces blinking: picture, placeholder, picture, one flash per row per pass.
/// Worse, the placeholder and the image are two different views swapped inside
/// the same slot, so a slow connection shows one drawn over the other.
///
/// This keeps a decoded image per URL for the life of the app and hands it
/// back synchronously when it is already there. A face that has been seen once
/// never flashes again, and a face being seen for the first time shows a
/// skeleton — a quiet shape in the right place — rather than something that
/// looks like content and then is replaced.
/// Not `@Observable`: nothing watches it. Views ask it for a picture inside a
/// `.task` and hold the answer themselves, which is what makes a cache hit a
/// synchronous read rather than a state change and a second render pass.
@MainActor
final class ImageCache {
    static let shared = ImageCache()

    /// Keyed by the picture *and* the size it was decoded for.
    ///
    /// The same picture can be wanted as a 32-point avatar and as a 260-point
    /// promotion, and handing the avatar a full-resolution bitmap is how a
    /// list of faces eats a hundred megabytes. A key of "picture|maxPixel"
    /// keeps the two apart and lets each be as small as it needs to be.
    ///
    /// The picture is its link less any signature (`identity(of:)`): the
    /// platform's avatar and logo links are plain CDN paths today, but a
    /// provider that signs them would otherwise make every read of the same
    /// face a new picture.
    private struct Key: Hashable {
        let identity: String
        let maxPixel: Int
    }

    private var images: [Key: UIImage] = [:]
    /// Downloads already in flight, so eight rows sharing one avatar make one
    /// request rather than eight.
    private var loading: [Key: Task<UIImage?, Never>] = [:]
    /// When each picture last failed, so a broken link is not retried on
    /// every scroll — and IS retried a minute later. It used to be a set kept
    /// for the life of the process: one failed read during a network blip
    /// left that face blank until the app was killed.
    private var failedAt: [String: Date] = [:]

    /// Bounded, because an inbox scrolled all day would otherwise hold every
    /// face it has ever drawn. Faces are small; a few hundred is nothing, and
    /// dropping the oldest is the right thing when the list moves on.
    private static let limit = CachePolicy.remoteImageMemoryCount
    private var order: [Key] = []

    private init() {
        // The decoded faces are the one thing here worth giving back when
        // iOS runs short: the bytes stay in the URL cache on disk.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { ImageCache.shared.clearMemory() }
        }
    }

    /// Query parameters of signed links (S3 and compatible, CloudFront,
    /// Google Cloud Storage) that name the signature and its expiry rather
    /// than the file.
    nonisolated private static let signatureParameters: Set<String> = [
        "x-amz-algorithm", "x-amz-credential", "x-amz-date", "x-amz-expires", "x-amz-signedheaders",
        "x-amz-signature", "x-amz-security-token", "x-goog-algorithm", "x-goog-credential", "x-goog-date",
        "x-goog-expires", "x-goog-signedheaders", "x-goog-signature", "expires", "signature", "key-pair-id", "policy",
    ]

    /// What a picture is known by in memory: its link without the signature.
    /// Only the decoded image is shared this way — the download always uses
    /// the link as given, so an expired link is never replayed.
    nonisolated static func identity(of url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = components.queryItems, !items.isEmpty
        else { return url.absoluteString }
        let kept = items.filter { !signatureParameters.contains($0.name.lowercased()) }
        guard kept.count != items.count else { return url.absoluteString }
        components.queryItems = kept.isEmpty ? nil : kept
        return components.string ?? url.absoluteString
    }

    func cached(_ url: URL, maxPixel: Int) -> UIImage? { images[Key(identity: Self.identity(of: url), maxPixel: maxPixel)] }

    func hasFailed(_ url: URL, now: Date = Date()) -> Bool {
        guard let at = failedAt[Self.identity(of: url)] else { return false }
        return now.timeIntervalSince(at) < CachePolicy.remoteImageFailureTTL
    }

    /// Decoded pictures and failure marks go; the bytes on disk stay.
    func clearMemory() {
        images = [:]
        order = []
        failedAt = [:]
    }

    /// Clear Cache: the disk copies too.
    func clearAll() {
        clearMemory()
        Self.session.configuration.urlCache?.removeAllCachedResponses()
    }

    /// The pictures' disk cache, for Settings.
    var diskBytes: Int {
        Self.session.configuration.urlCache?.currentDiskUsage ?? 0
    }

    func load(_ url: URL, maxPixel: Int) async -> UIImage? {
        let identity = Self.identity(of: url)
        let key = Key(identity: identity, maxPixel: maxPixel)
        if let image = images[key] { return image }
        if hasFailed(url) { return nil }
        if let existing = loading[key] { return await existing.value }

        // Detached on purpose. A plain `Task` here would inherit this class's
        // main-actor isolation, and while the download itself only suspends,
        // `decode` is real CPU work — turning a two-thousand-pixel PNG into a
        // thumbnail on the main thread is a visible hitch in a scrolling list,
        // which is the exact thing this whole file exists to prevent. The
        // session is captured here, on the main actor, rather than read inside.
        let task = Task<UIImage?, Never>.detached(priority: .utility) { [session = Self.session] in
            do {
                let (data, response) = try await session.data(from: url)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
                else { return nil }
                return Self.decode(data, maxPixel: maxPixel)
            } catch {
                return nil
            }
        }
        loading[key] = task
        let image = await task.value
        loading[key] = nil

        if let image {
            store(image, for: key)
            failedAt[identity] = nil
        } else {
            failedAt[identity] = Date()
        }
        return image
    }

    /// Decodes straight to the size that will be drawn.
    ///
    /// `UIImage(data:)` keeps whatever the file happens to be — a workspace
    /// logo uploaded from a desktop is routinely two thousand pixels square,
    /// which is sixteen megabytes of bitmap to show inside a thirty-two point
    /// circle. `CGImageSourceCreateThumbnailAtIndex` never builds the large
    /// one at all, so the cost is the small image plus the file, not both
    /// bitmaps. `kCGImageSourceCreateThumbnailWithTransform` keeps a photo
    /// taken sideways the right way up.
    private nonisolated static func decode(_ data: Data, maxPixel: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return UIImage(data: data)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else {
            return UIImage(data: data)
        }
        return UIImage(cgImage: thumbnail)
    }

    private func store(_ image: UIImage, for key: Key) {
        if images[key] == nil { order.append(key) }
        images[key] = image
        while order.count > Self.limit, let oldest = order.first {
            order.removeFirst()
            images[oldest] = nil
        }
    }

    /// Its own session with a real disk cache, so a face survives a relaunch
    /// as well as a scroll.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.urlCache = URLCache(
            memoryCapacity: CachePolicy.remoteImageURLCacheMemory,
            diskCapacity: CachePolicy.remoteImageURLCacheDisk,
            diskPath: "webyar-images"
        )
        return URLSession(configuration: configuration)
    }()
}

/// A remote picture with a skeleton in its place until it arrives.
///
/// `fallback` is for a link that is broken or missing — initials, an OS mark,
/// whatever the caller shows when there is no picture. The skeleton is only
/// ever shown while a fetch is genuinely outstanding, so a missing picture goes
/// straight to the fallback rather than pretending to load first.
struct RemoteImage<Fallback: View>: View {
    let url: URL?
    /// The longest side this picture will ever be drawn at, in pixels.
    ///
    /// The default suits an avatar: the largest one in the app is 72 points,
    /// which is 216 pixels on a 3× screen. A view that draws bigger says so.
    var maxPixel: Int = 256
    @ViewBuilder let fallback: Fallback

    @State private var image: UIImage?
    @State private var isLoading = false

    var body: some View {
        content
            .task(id: url) { await fetch() }
    }

    @ViewBuilder
    private var content: some View {
        if let image {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else if isLoading {
            SkeletonFill()
        } else {
            fallback
        }
    }

    private func fetch() async {
        guard let url else {
            image = nil
            isLoading = false
            return
        }
        // Synchronous hit: no skeleton, no flash, no frame where the row is
        // anything other than finished.
        if let cached = ImageCache.shared.cached(url, maxPixel: maxPixel) {
            image = cached
            isLoading = false
            return
        }
        if ImageCache.shared.hasFailed(url) {
            image = nil
            isLoading = false
            return
        }
        image = nil
        isLoading = true
        let loaded = await ImageCache.shared.load(url, maxPixel: maxPixel)
        guard !Task.isCancelled else { return }
        image = loaded
        isLoading = false
    }
}

/// The grey shape that stands in for a picture while it loads.
///
/// A slow sweep rather than a pulse: a pulse in a list of eight avatars turns
/// the whole column on and off together, which reads as a fault. The sweep is
/// also stopped for anyone who has asked the system to reduce motion.
struct SkeletonFill: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    var body: some View {
        GeometryReader { proxy in
            let width = max(proxy.size.width, 1)
            Theme.Palette.surfaceElevated
                .overlay {
                    if !reduceMotion {
                        LinearGradient(
                            colors: [.clear, .white.opacity(0.35), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: width * 0.8)
                        .offset(x: phase * width * 1.6)
                        .blendMode(.plusLighter)
                    }
                }
                .onAppear {
                    guard !reduceMotion else { return }
                    withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
                        phase = 1
                    }
                }
        }
        .accessibilityHidden(true)
    }
}
