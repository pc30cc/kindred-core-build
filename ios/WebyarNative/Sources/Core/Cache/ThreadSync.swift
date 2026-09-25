import Foundation

/// What `GET /api/conversations/:id/messages` answered.
struct ThreadPage: Sendable, Equatable {
    var messages: [Message]
    /// Only the rows created or changed since the cursor sent; otherwise the
    /// whole thread.
    var delta: Bool
    var cursor: String?
}

/// One thread's server messages, and how the next read of them is asked for.
///
/// The saved copy first, realtime rows as they arrive, then deltas from the
/// server's cursor, with a whole read now and then. Pure state — no network,
/// no disk, no clock of its own — so every ordering the app can meet is a
/// unit test.
///
/// The server is the truth:
/// - a whole read replaces everything (a message missing from it was deleted
///   or hidden), except realtime rows newer than the snapshot it was taken on;
/// - a delta or a realtime row is merged in by id, so the same message from a
///   read, a push-triggered read and realtime is one row, never three;
/// - a row never goes back to an older version of itself (`updatedAt`), so a
///   late answer cannot undo a newer one.
///
/// Messages still being sent from this phone are not here: the chat keeps
/// its outbox apart and drops each one once its `client_message_id` comes
/// back on a server row.
struct ThreadSync {
    private(set) var messages: [Message] = []
    private(set) var cursor: String?
    private(set) var fullAt: Date?
    /// A server read has landed: what is on show is no longer only the saved copy.
    private(set) var hasServerData = false
    /// What is on show came from this phone's saved copy and the server has
    /// not answered since.
    private(set) var fromCache = false

    private var wholeReadDue = true
    private var fetching = false
    /// Realtime rows that arrived while a read was out: a whole read taken
    /// before them must not drop them.
    private var arrivedDuringFetch: [String: Message] = [:]

    struct Request: Equatable, Sendable {
        /// Nil: read the whole thread.
        var since: String?
    }

    /// The result of applying a read: whether the screen changes, and what to
    /// write to the store for next time.
    struct Applied {
        var changed: Bool
        var write: ThreadWrite?
    }

    // MARK: - Saved copy

    /// The copy saved on this phone, shown before the server answers.
    /// Ignored once the server has answered — it can only be older.
    @discardableResult
    mutating func applyCached(_ saved: CachedThread) -> Bool {
        guard !hasServerData else { return false }
        // Anything realtime already brought stays on top of the saved copy.
        messages = Self.merge(saved.messages, messages, fillMissing: true)
        fromCache = !saved.messages.isEmpty
        // A thread saved only in part cannot be completed by a delta.
        if saved.complete, let savedCursor = saved.cursor {
            cursor = savedCursor
            wholeReadDue = false
        }
        fullAt = saved.fullAt
        return !saved.messages.isEmpty
    }

    // MARK: - Server reads

    /// The next read: a delta from the cursor when there is one and the last
    /// whole read is recent; otherwise the whole thread.
    mutating func beginFetch(now: Date = Date()) -> Request {
        fetching = true
        arrivedDuringFetch = [:]
        let stale = fullAt.map { now.timeIntervalSince($0) >= CachePolicy.fullReconcileInterval } ?? true
        if wholeReadDue || stale || cursor == nil { return Request(since: nil) }
        return Request(since: cursor)
    }

    /// The server's answer.
    @discardableResult
    mutating func applyResponse(_ page: ThreadPage, now: Date = Date()) -> Applied {
        let before = messages
        let write: ThreadWrite
        if page.delta {
            messages = Self.merge(messages, page.messages, fillMissing: false)
            if let next = page.cursor, Self.isAhead(next, of: cursor) { cursor = next }
            // What the store keeps is what is now shown for those ids.
            let ids = Set(page.messages.map(\.id))
            write = .upsert(messages.filter { ids.contains($0.id) })
        } else {
            // A whole read is the truth: anything missing from it is gone —
            // except realtime rows newer than the snapshot the server took.
            let snapshot = Self.merge([], page.messages, fillMissing: false)
            let ids = Set(snapshot.map(\.id))
            let late = arrivedDuringFetch.values.filter { !ids.contains($0.id) }
            messages = Self.merge(snapshot, Array(late), fillMissing: true)
            cursor = page.cursor
            fullAt = now
            wholeReadDue = false
            write = .replace(snapshot)
        }
        fetching = false
        arrivedDuringFetch = [:]
        let first = !hasServerData
        hasServerData = true
        fromCache = false
        let changed = messages != before
        // An unchanged delta has nothing worth a disk write.
        if page.delta, page.messages.isEmpty, !first { return Applied(changed: changed, write: nil) }
        return Applied(changed: changed, write: write)
    }

    /// The read failed. A server error (not a lost connection) also makes the
    /// next read a whole one: whatever went wrong, a delta will not mend it.
    mutating func fetchFailed(transport: Bool) {
        fetching = false
        arrivedDuringFetch = [:]
        if !transport { wholeReadDue = true }
    }

    // MARK: - Realtime

    /// A message row pushed by realtime. Returns whether it changed what is shown.
    @discardableResult
    mutating func applyRealtime(_ message: Message) -> Bool {
        if fetching { arrivedDuringFetch[message.id] = message }
        let next = Self.merge(messages, [message], fillMissing: true)
        guard next != messages else { return false }
        messages = next
        return true
    }

    /// Reconnected after missing events, or the saved copy was cleared: the
    /// next read is a whole one.
    mutating func requireWholeRead() {
        wholeReadDue = true
    }

    func contains(messageID: String) -> Bool {
        messages.contains { $0.id == messageID }
    }

    // MARK: - Merging

    /// `base` with `incoming` merged in by id, in thread order.
    ///
    /// A row replaces the one with its id unless it is older (`updatedAt`).
    /// With `fillMissing` (a realtime row, which carries no sender name, photo
    /// or files) what it lacks is kept from the row it replaces — or, for a
    /// new message, taken from another message by the same sender — and it
    /// never replaces a server copy that is already complete.
    static func merge(_ base: [Message], _ incoming: [Message], fillMissing: Bool) -> [Message] {
        var byID: [String: Message] = [:]
        byID.reserveCapacity(base.count + incoming.count)
        for message in base { byID[message.id] = message }
        for message in incoming {
            var next = message
            if let old = byID[message.id] {
                if let a = old.updatedAt, let b = message.updatedAt, b < a { continue }
                if fillMissing, old.updatedAt != nil, message.updatedAt == nil { continue }
                if fillMissing { next = message.filling(from: old) }
            } else if fillMissing, message.senderName == nil, let senderID = message.senderId,
                      let known = byID.values.first(where: { $0.senderId == senderID && $0.senderName != nil }) {
                next = Message(
                    id: message.id, conversationId: message.conversationId, senderType: message.senderType,
                    senderId: message.senderId, body: message.body, createdAt: message.createdAt,
                    updatedAt: message.updatedAt, senderName: known.senderName,
                    senderAvatar: message.senderAvatar ?? known.senderAvatar,
                    metadata: message.metadata, attachments: message.attachments
                )
            }
            byID[message.id] = next
        }
        return byID.values.sorted(by: inThreadOrder)
    }

    static func inThreadOrder(_ a: Message, _ b: Message) -> Bool {
        let ta = a.createdAt ?? .distantPast, tb = b.createdAt ?? .distantPast
        return ta != tb ? ta < tb : a.id < b.id
    }

    /// Whether `candidate` is a cursor at or after `current`. The server never
    /// moves a cursor backwards; neither does this, whatever order answers
    /// arrive in.
    static func isAhead(_ candidate: String, of current: String?) -> Bool {
        guard let current else { return true }
        guard let a = DateParsing.parse(candidate), let b = DateParsing.parse(current) else { return true }
        return a >= b
    }
}
