import AppKit
import SwiftUI

/// Pictures from the storage provider (avatars, logos, campaign art), loaded
/// once and shared. SwiftUI's AsyncImage keeps no cache and starts over each
/// time its view is rebuilt, so on a slow link a photo that every poll redraws
/// may never finish; here one request per link is in flight at a time, the
/// decoded picture stays in memory, and the bytes stay in an on-disk HTTP
/// cache. Everything is keyed by the full link the server sent, so when the
/// provider or its CDN changes, the new links simply load as new pictures.
@MainActor
final class ImageStore {
    static let shared = ImageStore()

    private let memory = NSCache<NSURL, NSImage>()
    private var inFlight: [URL: Task<NSImage?, Never>] = [:]
    /// A link that just failed is not asked again for a little while.
    private var failedAt: [URL: Date] = [:]
    private let session: URLSession

    private init() {
        memory.countLimit = 400
        let config = URLSessionConfiguration.default
        config.urlCache = URLCache(memoryCapacity: 8 * 1024 * 1024, diskCapacity: 80 * 1024 * 1024)
        config.requestCachePolicy = .useProtocolCachePolicy
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = true
        session = URLSession(configuration: config)
    }

    func cached(_ url: URL) -> NSImage? { memory.object(forKey: url as NSURL) }

    func image(_ url: URL) async -> NSImage? {
        if let hit = cached(url) { return hit }
        if let task = inFlight[url] { return await task.value }
        if let at = failedAt[url], Date().timeIntervalSince(at) < 30 { return nil }
        let session = session
        let task = Task<NSImage?, Never> {
            do {
                let (data, response) = try await session.data(from: url)
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { return nil }
                return NSImage(data: data)
            } catch {
                return nil
            }
        }
        inFlight[url] = task
        let image = await task.value
        inFlight[url] = nil
        if let image {
            memory.setObject(image, forKey: url as NSURL)
            failedAt[url] = nil
        } else {
            failedAt[url] = Date()
        }
        return image
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
