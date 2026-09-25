import Foundation

/// Every limit of the local-first cache in one place. The cache is never the
/// truth — the server is — so each number here trades a little disk or a
/// little staleness for fewer requests, never correctness.
enum CachePolicy {
    // MARK: Local store (messages and lists)

    /// Bumped whenever the store's tables change shape. A store written by any
    /// other version is dropped and rebuilt from the server: it only ever held a cache.
    static let schemaVersion: Int32 = 1

    /// Messages kept per conversation; a longer thread keeps its newest ones and
    /// is marked incomplete, so its next open reads it whole from the server.
    static let maxMessagesPerThread = 1_000
    /// Conversations whose messages are kept; the least recently opened go first.
    static let maxThreads = 300
    /// A conversation not opened for this long is dropped from the store.
    static let threadRetention: TimeInterval = 30 * 24 * 3600
    /// A saved list older than this is not shown while offline at launch: too old to be useful.
    static let listRetention: TimeInterval = 14 * 24 * 3600
    /// Free pages (of 4 KB) past which a prune also compacts the file.
    static let vacuumFreePages = 2_048

    // MARK: Thread sync

    /// Even with deltas, a thread is read whole this often: deletions and anything a
    /// delta cannot express come back into line.
    static let fullReconcileInterval: TimeInterval = 10 * 60
    /// A realtime message is shown at once; the delta that fills in its sender and files
    /// follows this soon after, one read for a burst of messages.
    static let realtimeDeltaDelay: TimeInterval = 0.4

    // MARK: Conversation lists

    /// Two readers of the same list within this window (the inbox and the notifier) share one request.
    static let listShareWindow: TimeInterval = 2

    // MARK: Files on disk (FileCache)

    static let fileCacheMaxBytes: Int64 = 1024 * 1024 * 1024
    static let fileCacheTrimTo: Int64 = 800 * 1024 * 1024
    /// While the app runs, the file cache is trimmed at most this often (and at launch).
    static let fileCacheTrimInterval: TimeInterval = 15 * 60

    // MARK: Memory

    static let attachmentMemoryBytes = 150 * 1024 * 1024
    static let attachmentMemoryImages = 300
    static let remoteImageMemoryCount = 400
}
