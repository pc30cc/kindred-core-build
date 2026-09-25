import AppKit
import SwiftUI

/// Query parameters of signed links (S3 and compatible, CloudFront, Google Cloud Storage) that
/// name the signature and its expiry rather than the file.
private let signatureParams: Set<String> = [
    "x-amz-algorithm", "x-amz-credential", "x-amz-date", "x-amz-expires", "x-amz-signedheaders",
    "x-amz-signature", "x-amz-security-token", "x-goog-algorithm", "x-goog-credential", "x-goog-date",
    "x-goog-expires", "x-goog-signedheaders", "x-goog-signature", "expires", "signature", "key-pair-id", "policy",
]

/// Pictures from the storage provider (avatars, logos, campaign art), loaded
/// once, shared, and kept on disk with the other cached files. SwiftUI's AsyncImage keeps no cache and starts over each
/// time its view is rebuilt, so on a slow link a photo that every poll redraws
/// may never finish; here one request per picture is in flight at a time, the
/// decoded picture stays in memory, and the bytes stay on disk (FileCache).
/// Keyed by the link the server sent, less any signature a signed link
/// carries (which changes on every read of the same file): when the provider
/// or its CDN changes, the new links simply load as new pictures; when only
/// the signature changes, the picture is not downloaded again.
@MainActor
final class ImageStore {
    static let shared = ImageStore()

    private let memory = NSCache<NSString, NSImage>()
    private var inFlight: [String: Task<NSImage?, Never>] = [:]
    /// A picture that just failed is not asked again for a little while.
    private var failedAt: [String: Date] = [:]
    private let session: URLSession

    private init() {
        memory.countLimit = CachePolicy.remoteImageMemoryCount
        let config = URLSessionConfiguration.default
        config.urlCache = URLCache(memoryCapacity: 8 * 1024 * 1024, diskCapacity: 80 * 1024 * 1024)
        config.requestCachePolicy = .useProtocolCachePolicy
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = true
        session = URLSession(configuration: config)
    }

    /// Pictures whose disk copy has already been checked against the server this session.
    private var checked = Set<String>()

    /// What a picture is known by: its link without the signature.
    nonisolated static func cacheKey(_ url: URL) -> String {
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false), let items = c.queryItems, !items.isEmpty else {
            return url.absoluteString
        }
        let kept = items.filter { !signatureParams.contains($0.name.lowercased()) }
        guard kept.count != items.count else { return url.absoluteString }
        c.queryItems = kept.isEmpty ? nil : kept
        return c.string ?? url.absoluteString
    }

    func cached(_ url: URL) -> NSImage? { memory.object(forKey: Self.cacheKey(url) as NSString) }

    /// Signing out, a cleared cache, or macOS short of memory: decoded pictures go (the disk keeps the bytes).
    func clearMemory() {
        memory.removeAllObjects()
        checked = []
        failedAt = [:]
    }

    /// Memory, then the disk (instantly, and checked once a session in the background in case the
    /// picture behind the same link changed), then the network — whose answer is kept on disk.
    func image(_ url: URL) async -> NSImage? {
        let key = Self.cacheKey(url)
        if let hit = memory.object(forKey: key as NSString) { return hit }
        if let task = inFlight[key] { return await task.value }
        if let data = await Task.detached(priority: .userInitiated, operation: { FileCache.read(key: key) }).value {
            if let image = NSImage(data: data) {
                memory.setObject(image, forKey: key as NSString)
                if !checked.contains(key) {
                    checked.insert(key)
                    Task { await self.refresh(url, key: key, known: data) }
                }
                return image
            }
            // A damaged copy: dropped, and the picture is fetched again below.
            await Task.detached(priority: .utility) { FileCache.remove(key: key) }.value
        }
        if let hit = memory.object(forKey: key as NSString) { return hit }
        if let task = inFlight[key] { return await task.value }
        if let at = failedAt[key], Date().timeIntervalSince(at) < 30 { return nil }
        let task = Task<NSImage?, Never> { [session] in
            guard let data = await Self.download(url, session), let image = NSImage(data: data) else { return nil }
            Task.detached(priority: .utility) { FileCache.write(key: key, data) }
            return image
        }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil
        checked.insert(key)
        if let image {
            memory.setObject(image, forKey: key as NSString)
            failedAt[key] = nil
        } else {
            failedAt[key] = Date()
        }
        return image
    }

    /// The server's copy, if it differs from the disk's: shown wherever the picture is drawn next.
    private func refresh(_ url: URL, key: String, known: Data) async {
        guard let data = await Self.download(url, session), data != known, let image = NSImage(data: data) else { return }
        Task.detached(priority: .utility) { FileCache.write(key: key, data) }
        memory.setObject(image, forKey: key as NSString)
    }

    nonisolated private static func download(_ url: URL, _ session: URLSession) async -> Data? {
        do {
            let (data, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { return nil }
            return data
        } catch {
            return nil
        }
    }
}

/// A picture from a link, filling its frame, over `placeholder` until (and unless) it arrives.
struct RemoteImage<Placeholder: View>: View {
    let url: URL?
    @ViewBuilder var placeholder: Placeholder
    @State private var image: NSImage?
    @State private var shownURL: URL?

    var body: some View {
        ZStack {
            placeholder
            if let image, shownURL == url {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .task(id: url) {
            guard let url else {
                image = nil
                return
            }
            if let hit = ImageStore.shared.cached(url) {
                image = hit
                shownURL = url
                return
            }
            let loaded = await ImageStore.shared.image(url)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.15)) {
                image = loaded
                shownURL = url
            }
        }
    }
}
