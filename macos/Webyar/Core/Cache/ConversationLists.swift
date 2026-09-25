import Foundation

/// The workspace's conversation lists, read once for everyone who wants them.
/// The inbox and the background notifier both read the open queue; asked
/// within a moment of each other they share one request (and one in flight
/// is joined, never doubled). Each read sends the ETag of the copy already
/// held, so an unchanged list comes back as a bodiless 304; the copy is also
/// saved in the LocalStore, to show at once next time — even offline.
@MainActor
final class ConversationLists {
    typealias Fetch = (_ filter: InboxFilter, _ etag: String?) async throws -> (conversations: [Conversation]?, etag: String?)

    let workspaceId: String
    private let fetchPage: Fetch
    private let store: () -> LocalStore?
    private var inFlight: [InboxFilter: (task: Task<[Conversation], Error>, startedAt: Date)] = [:]
    private var latest: [InboxFilter: (list: [Conversation], etag: String?, at: Date)] = [:]
    /// Something changed on the server (a realtime event): nothing read before this is shared any more.
    private var invalidatedAt = Date.distantPast
    /// Requests actually sent, for tests and the log.
    private(set) var requests = 0

    init(workspaceId: String, store: @escaping () -> LocalStore?, fetch: @escaping Fetch) {
        self.workspaceId = workspaceId
        self.store = store
        fetchPage = fetch
    }

    static func key(_ filter: InboxFilter) -> String { "list:" + filter.rawValue }

    /// The last list known — this session's, else the one saved on this Mac — without asking the server.
    func cached(_ filter: InboxFilter) async -> [Conversation]? {
        if let l = latest[filter] { return l.list }
        return await store()?.list(Self.key(filter))?.conversations
    }

    /// The list from the server, shared with any other reader asking at about the same time.
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

    /// A realtime event: the next reader asks the server rather than share an older answer.
    func invalidate() {
        invalidatedAt = Date()
    }

    private func read(_ filter: InboxFilter, startedAt: Date) async throws -> [Conversation] {
        // Revalidate only a copy actually held: a 304 must have something to stand for.
        var known = latest[filter].map { (list: $0.list, etag: $0.etag) }
        if known == nil, let saved = await store()?.list(Self.key(filter)) { known = (saved.conversations, saved.etag) }
        requests += 1
        var answer = try await fetchPage(filter, known?.etag)
        if answer.conversations == nil, known == nil {
            // A 304 with no copy to stand for: ask again for the body.
            requests += 1
            answer = try await fetchPage(filter, nil)
        }
        let list = answer.conversations ?? known?.list ?? []
        // Stamped with when it was asked, and never over a newer answer that overtook it.
        if let newer = latest[filter], newer.at > startedAt { return list }
        latest[filter] = (list, answer.etag, startedAt)
        if answer.conversations != nil { await store()?.saveList(Self.key(filter), list, etag: answer.etag) }
        return list
    }

    /// Forgets this session's copies (the cache was cleared): the next read fetches in full.
    func forget() {
        latest = [:]
        invalidate()
    }
}
