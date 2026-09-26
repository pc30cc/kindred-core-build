import Foundation

/// Every limit of the local-first cache, in one place.
///
/// The cache is never the truth — the server is — so each number here trades
/// a little disk, memory or staleness for fewer requests and a screen that
/// opens at once. None of them trades correctness: a limit reached means
/// something is read from the server again, never that something wrong is
/// shown.
///
/// These are a phone's numbers, not the desktop's. The Mac keeps a gigabyte
/// of files because a Mac has a disk to spare; an iPhone's storage is shared
/// with the operator's photos, and iOS itself empties `Caches` when it runs
/// low — so the phone keeps a fraction of that and gives it back sooner.
enum CachePolicy {

    // MARK: - Where

    /// `Library/Caches/Webyar`: never backed up (iCloud or a computer), and
    /// the system may empty it when the disk runs low, which only ever costs
    /// a read from the server. Not `Documents` (backed up, shown in Files)
    /// and not `Application Support` (backed up, never purged): everything
    /// here can be rebuilt.
    static var root: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Webyar", isDirectory: true)
    }

    // MARK: - Local store (messages and conversation lists)

    /// Bumped whenever the store's tables change shape. A store written by
    /// any other version is dropped and rebuilt from the server: it only ever
    /// held a cache, and a migration for a cache is a way to carry a bug
    /// forward. Credentials and preferences are never in it.
    static let schemaVersion: Int32 = 1

    /// Messages kept per conversation. A longer thread keeps its newest and is
    /// marked incomplete, so its next open reads it whole.
    static let maxMessagesPerThread = 800
    /// Conversations whose messages are kept; the least recently opened go.
    static let maxThreads = 200
    /// A conversation not opened for this long is dropped from the store.
    static let threadRetention: TimeInterval = 30 * 24 * 3600
    /// A saved list older than this is not worth showing, even offline.
    static let listRetention: TimeInterval = 14 * 24 * 3600
    /// Past this size the store is pruned harder (fewer threads kept).
    static let storeSoftLimitBytes: Int64 = 64 * 1024 * 1024
    /// Free pages (4 KB each) past which upkeep also compacts the file —
    /// and only when the phone is not in Low Power Mode.
    static let vacuumFreePages = 2_048

    // MARK: - Thread sync

    /// Even with deltas, a thread is read whole this often while it is open:
    /// a delta cannot say that a message was deleted, a whole read can.
    static let fullReconcileInterval: TimeInterval = 10 * 60
    /// A realtime message shows at once; the delta that fills in its sender
    /// and files follows this soon after — one read for a burst of messages.
    static let realtimeDeltaDelay: TimeInterval = 0.4

    // MARK: - Freshness while the app is open

    /// With realtime connected, events drive every read and this is only the
    /// safety net for one that was lost.
    static let listSafetyInterval: TimeInterval = 120
    static let threadSafetyInterval: TimeInterval = 120
    /// Without realtime (the platform runs without it, or the socket is
    /// down), the open screen asks this often — the same pace the console's
    /// own polling keeps. Only in the foreground, and only for the screen on
    /// show.
    static let listPollInterval: TimeInterval = 15
    static let threadPollInterval: TimeInterval = 10
    /// Realtime events arriving close together are answered by one list read.
    static let listEventDebounce: TimeInterval = 0.6
    /// Two readers of the same list within this window share one request.
    static let listShareWindow: TimeInterval = 2

    // MARK: - Attachment files on disk

    /// Bytes of attachment files kept on this phone: 5% of the space free
    /// when the app starts, never less than the floor and never more than the
    /// ceiling. A phone that is nearly full keeps less; none keeps a gigabyte.
    static let attachmentDiskFloor: Int64 = 100 * 1024 * 1024
    static let attachmentDiskCeiling: Int64 = 400 * 1024 * 1024
    static let attachmentDiskShareOfFreeSpace = 0.05
    /// A trim brings the cache down to this share of its limit, so it is not
    /// trimmed again on the very next write.
    static let attachmentDiskTrimRatio = 0.8

    static func attachmentDiskLimit(freeBytes: Int64?) -> Int64 {
        guard let freeBytes, freeBytes > 0 else { return attachmentDiskFloor }
        let share = Int64(Double(freeBytes) * attachmentDiskShareOfFreeSpace)
        return min(attachmentDiskCeiling, max(attachmentDiskFloor, share))
    }

    // MARK: - Memory

    /// Attachment bytes held in memory — `NSCache`, so the system takes them
    /// back under pressure on its own.
    static let attachmentMemoryBytes = 48 * 1024 * 1024
    /// Decoded attachment previews (downsampled, so each is small).
    static let attachmentPreviewCount = 120
    /// The longest side of a photo drawn in a bubble, in pixels: 260 points
    /// at 3×, rounded up. The full photo is decoded only for the viewer.
    static let attachmentPreviewPixels = 800
    /// The longest side of a photo in the full-screen viewer.
    static let attachmentViewerPixels = 2_048

    // MARK: - Remote pictures (avatars, logos)

    static let remoteImageMemoryCount = 300
    static let remoteImageURLCacheMemory = 8 * 1024 * 1024
    static let remoteImageURLCacheDisk = 64 * 1024 * 1024
    /// A picture that failed is not asked for again before this — and is
    /// asked again after it, so a link that recovers is not dead for the
    /// rest of the session.
    static let remoteImageFailureTTL: TimeInterval = 60

    // MARK: - Visitor details

    /// Device and location behind a conversation: kept in memory this long,
    /// never on disk. It changes rarely, and it is decoration.
    static let visitorIntelTTL: TimeInterval = 10 * 60
}
