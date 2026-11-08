import Foundation

/// Where the page before a run of a thread starts: the server's `older`,
/// both strings exactly as it sent them (its microseconds kept: this phone's
/// dates keep milliseconds only).
struct OlderCursor: Codable, Sendable, Equatable {
    let before: String
    let beforeID: String

    enum CodingKeys: String, CodingKey {
        case before
        case beforeID = "before_id"
    }
}

/// What `GET /api/conversations/:id/messages` answered.
struct ThreadPage: Sendable, Equatable {
    var messages: [Message]
    /// Only the rows created or changed since the cursor sent; otherwise a
    /// page of the thread (its newest, or the one before `before`).
    var delta: Bool
    var cursor: String?
    /// The page before this one; nil at the thread's start, on a delta, and
    /// from a server older than paging (whose answer is then the whole thread).
    var older: OlderCursor? = nil
}

/// One thread's server messages, and how the next read of them is asked for.
///
/// The saved copy first, realtime rows as they arrive, then deltas from the
/// server's cursor, with a whole read now and then. Pure state — no network,
/// no disk, no clock of its own — so every ordering the app can meet is a
/// unit test.
///
/// The thread is read in pages (docs/operations/THREAD_PAGING_APPS.md): what
/// is held is ONE contiguous run of it, ending at its newest message, and
/// `older` says where the page before the run starts.
///
/// The server is the truth:
/// - a newest-page read is the truth from its first row on (a message missing
///   from that range was deleted or hidden); what the run held before it is
///   kept while it still touches the page, and the run starts again from the
///   page when it does not (more than a page arrived meanwhile), so it never
///   has a hole. Realtime rows newer than the snapshot it was taken on stay;
/// - an older page goes before the run, and never moves the cursor;
/// - a delta or realtime row older than the run is dropped (it lies above
///   the run's start; loading earlier brings it);
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
    /// Where the page before the run starts; nil once the run reaches the
    /// thread's start. Meaningful only when `olderKnown`.
    private(set) var older: OlderCursor?
    /// False until a newest-page read (or a saved copy that knew it) said
    /// where the run starts: a copy saved before paging, or cut by the
    /// store's limit, does not know.
    private(set) var olderKnown = false

    /// Messages per page asked for.
    static let pageSize = CachePolicy.threadPageSize

    /// Earlier messages exist and can be asked for.
    var canLoadEarlier: Bool { olderKnown && older != nil }

    private var wholeReadDue = true
    private var fetching = false
    /// Realtime rows that arrived while a read was out: a whole read taken
    /// before them must not drop them.
    private var arrivedDuringFetch: [String: Message] = [:]

    struct Request: Equatable, Sendable {
        /// Nil: read a page (the newest, or the one before `before`).
        var since: String?
        /// Messages per page; nil asks for the server's default (its newest
        /// 1000), never sent with `since`.
        var limit: Int? = nil
        /// The page before this cursor (an older page).
        var before: OlderCursor? = nil
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
        // Only a whole saved run says where it starts; a copy from before
        // paging does not, and is read again from its newest page.
        if saved.complete, saved.olderKnown {
            older = saved.older
            olderKnown = true
        }
        fullAt = saved.fullAt
        return !saved.messages.isEmpty
    }

    // MARK: - Server reads

    /// The next read: a delta from the cursor when there is one, the last
    /// newest-page read is recent and the run's start is known; otherwise
    /// the newest page.
    mutating func beginFetch(now: Date = Date()) -> Request {
        fetching = true
        arrivedDuringFetch = [:]
        let stale = fullAt.map { now.timeIntervalSince($0) >= CachePolicy.fullReconcileInterval } ?? true
        if wholeReadDue || stale || cursor == nil || !olderKnown { return Request(since: nil, limit: Self.pageSize) }
        return Request(since: cursor)
    }

    /// The server's answer.
    @discardableResult
    mutating func applyResponse(_ page: ThreadPage, now: Date = Date()) -> Applied {
        let before = messages
        let write: ThreadWrite
        if page.delta {
            // A changed row older than the run (a reaction, a seen mark or a
            // file on an old message) is not added above the run's start.
            let rows = page.messages.filter { belongsToRun($0) }
            messages = Self.merge(messages, rows, fillMissing: false)
            if let next = page.cursor, Self.isAhead(next, of: cursor) { cursor = next }
            // What the store keeps is what is now shown for those ids.
            let ids = Set(rows.map(\.id))
            write = .upsert(messages.filter { ids.contains($0.id) })
        } else {
            // The newest page is the truth from its first row on; what the
            // run held before that row stays while the run touches the page.
            let late = arrivedDuringFetch
            let snapshot = Self.merge([], page.messages, fillMissing: false)
            let held = messages.filter { late[$0.id] == nil }
            let run = Self.runAfterNewestPage(
                held: held, heldOlder: olderKnown ? .some(older) : nil, page: snapshot, pageOlder: page.older
            )
            let ids = Set(run.rows.map(\.id))
            let lateRows = late.values.filter { !ids.contains($0.id) }
            messages = Self.merge(run.rows, Array(lateRows), fillMissing: true)
            older = run.older
            olderKnown = true
            cursor = page.cursor
            fullAt = now
            wholeReadDue = false
            write = .replace(run.rows)
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

    // MARK: - Older pages

    /// The page before the run, when there is one to ask for.
    func olderRequest() -> Request? {
        guard canLoadEarlier, let older else { return nil }
        return Request(since: nil, limit: Self.pageSize, before: older)
    }

    /// The page before the run, as asked for with `asked`. Nil when the run
    /// moved meanwhile (a newest-page read restarted it): that page is not
    /// next to it any more, and is dropped. The cursor and `fullAt` are not
    /// touched: the page's own cursor is only its newest `updated_at`.
    mutating func applyOlder(_ page: ThreadPage, asked: OlderCursor) -> Applied? {
        guard olderKnown, older == asked, !page.delta else { return nil }
        let before = messages
        messages = Self.merge(messages, page.messages, fillMissing: false)
        older = page.older
        let ids = Set(page.messages.map(\.id))
        return Applied(changed: messages != before, write: .upsert(messages.filter { ids.contains($0.id) }))
    }

    /// Whether a delta or realtime row goes into the run: a row already held
    /// does, and a new one does only when it is not older than the run's
    /// start (`older.before`, compared in milliseconds: a row inside that
    /// millisecond is taken, it is at the start itself).
    private func belongsToRun(_ message: Message) -> Bool {
        guard olderKnown, let older else { return true }
        if messages.contains(where: { $0.id == message.id }) { return true }
        guard let start = DateParsing.parse(older.before), let created = message.createdAt else { return true }
        return created >= start
    }

    /// The run after a newest-page read (the web's `mergeNewestPage`,
    /// src/lib/threadPages.ts). `heldOlder` is nil when the held run's start
    /// is unknown (a copy saved before paging): the page is then the run.
    static func runAfterNewestPage(
        held: [Message], heldOlder: OlderCursor??, page: [Message], pageOlder: OlderCursor?
    ) -> (rows: [Message], older: OlderCursor?) {
        // The page reaches the thread's start: it is the whole thread.
        guard let pageOlder else { return (page, nil) }
        guard let heldOlder, !held.isEmpty, let boundary = DateParsing.parse(pageOlder.before) else {
            return (page, pageOlder)
        }
        let pageIDs = Set(page.map(\.id))
        // Rows held strictly after the page's start that it does not carry
        // were deleted or hidden; the ones before it are the older pages.
        let before = held.filter { !pageIDs.contains($0.id) && ($0.createdAt ?? .distantPast) <= boundary }
        guard !before.isEmpty else { return (page, pageOlder) }
        // The run touches the page only when it reaches the page's start:
        // its newest row READ from the server is at or after it (a realtime
        // copy, which has no `updatedAt`, says nothing about the rows before
        // it). Otherwise more than a page arrived meanwhile, and the run
        // starts again from the page.
        let newest = held.filter { $0.updatedAt != nil }.max(by: inThreadOrder)
        guard let newestAt = newest?.createdAt, newestAt >= boundary else { return (page, pageOlder) }
        return (merge(before, page, fillMissing: false), heldOlder)
    }

    // MARK: - Realtime

    /// A message row pushed by realtime. Returns whether it changed what is shown.
    @discardableResult
    mutating func applyRealtime(_ message: Message) -> Bool {
        guard belongsToRun(message) else { return false }
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
