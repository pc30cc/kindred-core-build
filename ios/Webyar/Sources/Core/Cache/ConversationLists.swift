import Foundation

/// One read of a conversation list: the rows, or nil when the server said
/// the copy already held is still current (304).
struct ListPage: Sendable {
    var conversations: [Conversation]?
    var etag: String?
}

/// A workspace's conversation lists, read once for everyone who wants them.
///
/// Each read sends the ETag of the copy already held, so an unchanged list
/// comes back as a bodiless 304 instead of the whole queue again. Readers
/// asking within a moment of each other share one request (and one already
/// in flight is joined, never doubled). Every answer is saved in the
/// `LocalStore`, so the next launch shows it at once — even offline.
///
/// One instance per workspace: a new workspace gets a new one, so no list of
/// the last workspace can be handed to the next.
@MainActor
final class ConversationLists {
    typealias Fetch = @MainActor (_ filter: InboxFilter, _ etag: String?) async throws -> ListPage

    let workspaceID: String
    private let fetchPage: Fetch
    private let store: @MainActor () -> LocalStore?
    private var inFlight: [InboxFilter: (task: Task<[Conversation], Error>, startedAt: Date)] = [:]
    private var latest: [InboxFilter: (list: [Conversation], etag: String?, at: Date)] = [:]
    /// Something changed on the server (a realtime event, a push, an action
    /// here): nothing read before this is shared any more.
    private var invalidatedAt = Date.distantPast
    /// Requests actually sent, for tests.
    private(set) var requests = 0

    init(workspaceID: String, store: @escaping @MainActor () -> LocalStore?, fetch: @escaping Fetch) {
        self.workspaceID = workspaceID
        self.store = store
        fetchPage = fetch
    }

    static func key(_ filter: InboxFilter) -> String { "list:" + filter.rawValue }

    /// The last list known — this session's, else the one saved on this
    /// phone — without asking the server.
    func cached(_ filter: InboxFilter) async -> [Conversation]? {
        if let l = latest[filter] { return l.list }
        guard let saved = await store()?.list(Self.key(filter)) else { return nil }
        // Too old to be worth showing, even offline.
        guard Date().timeIntervalSince(saved.savedAt) < CachePolicy.listRetention else { return nil }
        return saved.conversations.filter { $0.workspaceId == workspaceID }
    }

    /// The same, synchronously, from this session only.
    func cachedInMemory(_ filter: InboxFilter) -> [Conversation]? {
        latest[filter]?.list
    }

    /// One conversation from any list read this session.
    func conversation(id: String) -> Conversation? {
        for entry in latest.values {
            if let hit = entry.list.first(where: { $0.id == id }) { return hit }
        }
        return nil
    }

    /// The list from the server, shared with any other reader asking at
    /// about the same time.
    func fetch(_ filter: InboxFilter, sharedWithin window: TimeInterval = CachePolicy.listShareWindow) async throws -> [Conversation] {
        if let l = latest[filter], l.at > invalidatedAt, Date().timeIntervalSince(l.at) < window { return l.list }
        if let running = inFlight[filter], running.startedAt >= invalidatedAt { return try await running.task.value }
        let startedAt = Date()
        let task = Task<[Conversation], Error> { [weak self] in
            guard let self else { throw CancellationError() }
            return try await self.read(filter, startedAt: startedAt)
        }
        inFlight[filter] = (task, startedAt)
        defer { if inFlight[filter]?.startedAt == startedAt { inFlight[filter] = nil } }
        return try await task.value
    }

    /// The next reader asks the server rather than share an older answer.
    func invalidate() {
        invalidatedAt = Date()
    }

    /// Takes a row out of every list held, after this phone moved it
    /// (resolved, reopened): the next read confirms it either way.
    func remove(_ conversationID: String) {
        for (filter, entry) in latest {
            latest[filter] = (entry.list.filter { $0.id != conversationID }, nil, entry.at)
        }
        invalidate()
    }

    /// Forgets this session's copies (the cache was cleared).
    func forget() {
        latest = [:]
        invalidate()
    }

    private func read(_ filter: InboxFilter, startedAt: Date) async throws -> [Conversation] {
        // Revalidate only a copy actually held: a 304 must have something to stand for.
        var known = latest[filter].map { (list: $0.list, etag: $0.etag) }
        if known == nil, let saved = await store()?.list(Self.key(filter)) {
            known = (saved.conversations, saved.etag)
        }
        requests += 1
        var answer = try await fetchPage(filter, known?.etag)
        if answer.conversations == nil, known == nil {
            // A 304 with no copy to stand for: ask again for the body.
            requests += 1
            answer = try await fetchPage(filter, nil)
        }
        // A foreign row could only be a bug somewhere else; it is never shown here.
        let list = (answer.conversations ?? known?.list ?? []).filter { $0.workspaceId == workspaceID }
        // Stamped with when it was asked, and never laid over a newer answer that overtook it.
        if let newer = latest[filter], newer.at > startedAt { return list }
        latest[filter] = (list, answer.etag, startedAt)
        if answer.conversations != nil { await store()?.saveList(Self.key(filter), list, etag: answer.etag) }
        return list
    }
}
