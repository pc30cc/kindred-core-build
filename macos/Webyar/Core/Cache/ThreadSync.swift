import Foundation

/// One thread's server messages and how the next read of them is asked for:
/// the saved copy first, realtime messages as they arrive, then deltas from
/// the server's cursor, with a whole read now and then. Pure state — no
/// network, no disk — so every ordering the app can meet is testable.
///
/// The server is the truth. A whole read replaces everything; a delta or a
/// realtime row is merged in by id, and a row never goes back to an older
/// version of itself (`updatedAt`). The outbox of messages being sent is not
/// here: ChatModel keeps it apart and drops each one once its client id
/// comes back on a server row.
struct ThreadSync {
    private(set) var messages: [Message] = []
    private(set) var cursor: String?
    private(set) var fullAt: Date?
    /// A server read has landed (the copy on show is no longer only the saved one).
    private(set) var hasServerData = false
    /// What is on show came from this Mac's saved copy and the server has not answered since.
    private(set) var fromCache = false

    private var wholeReadDue = true
    private var fetching = false
    /// Realtime rows that arrived while a read was out: a whole read taken before them must not drop them.
    private var arrivedDuringFetch: [String: Message] = [:]

    struct Request: Equatable {
        /// Nil: read the whole thread.
        var since: String?
    }

    // MARK: Saved copy

    /// The copy saved on this Mac, shown before the server answers. Ignored once the server has.
    @discardableResult
    mutating func applyCached(_ saved: CachedThread) -> Bool {
        guard !hasServerData else { return false }
        // Anything realtime already brought stays on top of the saved copy.
        messages = Self.merge(saved.messages, messages, fillMissing: true)
        fromCache = !saved.messages.isEmpty
        // A thread saved only in part cannot be completed by a delta: read it whole.
        if saved.complete, let c = saved.cursor {
            cursor = c
            fullAt = saved.fullAt
            wholeReadDue = false
        }
        return !saved.messages.isEmpty
    }

    // MARK: Server reads

    /// The next read: a delta from the cursor when there is one and the last whole read
    /// is recent; otherwise the whole thread.
    mutating func beginFetch(now: Date = Date()) -> Request {
        fetching = true
        arrivedDuringFetch = [:]
        let stale = fullAt.map { now.timeIntervalSince($0) >= CachePolicy.fullReconcileInterval } ?? true
        if wholeReadDue || stale || cursor == nil { return Request(since: nil) }
        return Request(since: cursor)
    }

    /// The server's answer. Returns whether the messages changed.
    @discardableResult
    mutating func applyResponse(_ page: ThreadPage, now: Date = Date()) -> Bool {
        let before = messages
        if page.delta {
            messages = Self.merge(messages, page.messages, fillMissing: false)
            if let c = page.cursor { cursor = c }
        } else {
            // A whole read is the truth: anything missing from it is gone (deleted, hidden) —
            // except realtime rows newer than the snapshot the server took.
            let snapshot = Self.merge([], page.messages, fillMissing: false)
            let late = arrivedDuringFetch.values.filter { m in !snapshot.contains { $0.id == m.id } }
            messages = Self.merge(snapshot, Array(late), fillMissing: true)
            cursor = page.cursor
            fullAt = now
            wholeReadDue = false
        }
        fetching = false
        arrivedDuringFetch = [:]
        hasServerData = true
        fromCache = false
        return messages != before
    }

    /// The read failed. A server error (not a lost connection) also makes the next read a whole one.
    mutating func fetchFailed(transport: Bool) {
        fetching = false
        arrivedDuringFetch = [:]
        if !transport { wholeReadDue = true }
    }

    // MARK: Realtime

    /// A message row pushed by realtime. Returns whether it changed what is shown.
    @discardableResult
    mutating func applyRealtime(_ m: Message) -> Bool {
        if fetching { arrivedDuringFetch[m.id] = m }
        let next = Self.merge(messages, [m], fillMissing: true)
        guard next != messages else { return false }
        messages = next
        return true
    }

    /// Reconnected after missing events, or the saved copy was cleared: the next read is a whole one.
    mutating func requireWholeRead() {
        wholeReadDue = true
    }

    // MARK: Merging

    /// `base` with `incoming` merged in by id, in thread order. A row replaces the one with its
    /// id unless it is older (`updatedAt`); with `fillMissing` (a realtime row, which carries no
    /// sender name, photo or files) what it lacks is kept from the row it replaces, or for a new
    /// operator message taken from another message of the same sender.
    static func merge(_ base: [Message], _ incoming: [Message], fillMissing: Bool) -> [Message] {
        var byId: [String: Message] = [:]
        byId.reserveCapacity(base.count + incoming.count)
        for m in base { byId[m.id] = m }
        for var m in incoming {
            if let old = byId[m.id] {
                if let a = old.updatedAt, let b = m.updatedAt, b < a { continue }
                if old.updatedAt != nil, m.updatedAt == nil, fillMissing { continue }
                if fillMissing {
                    if m.senderName == nil { m.senderName = old.senderName }
                    if m.senderAvatar == nil { m.senderAvatar = old.senderAvatar }
                    if m.attachments == nil { m.attachments = old.attachments }
                }
            } else if fillMissing, m.senderName == nil, let sid = m.senderId,
                      let known = byId.values.first(where: { $0.senderId == sid && $0.senderName != nil }) {
                m.senderName = known.senderName
                m.senderAvatar = m.senderAvatar ?? known.senderAvatar
            }
            byId[m.id] = m
        }
        return byId.values.sorted(by: inThreadOrder)
    }

    static func inThreadOrder(_ a: Message, _ b: Message) -> Bool {
        let ta = a.createdAt ?? .distantPast, tb = b.createdAt ?? .distantPast
        return ta != tb ? ta < tb : a.id < b.id
    }
}

/// What `GET /api/conversations/:id/messages` answered.
struct ThreadPage: Sendable, Equatable {
    var messages: [Message]
    /// Only the rows changed since the cursor sent (else the whole thread).
    var delta: Bool
    var cursor: String?
}
