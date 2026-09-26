import CryptoKit
import Foundation
import SQLite3

/// A thread as last read from the server, kept on this phone.
struct CachedThread: Sendable {
    var messages: [Message]
    /// The server's sync cursor for the next delta; nil means "read it whole".
    var cursor: String?
    /// When the thread was last read whole.
    var fullAt: Date?
    /// False when the thread had more messages than the store keeps: the
    /// newest are shown, and the next read is a whole one.
    var complete: Bool
}

/// A conversation list as last read from the server.
struct CachedList: Sendable {
    var conversations: [Conversation]
    var etag: String?
    var savedAt: Date
}

/// What a write to a stored thread should do.
enum ThreadWrite: Sendable {
    /// A whole read: the stored thread becomes exactly these rows.
    case replace([Message])
    /// A delta: these rows are added or replace the stored copy of themselves.
    case upsert([Message])
}

/// The messages and conversation lists of one operator in one workspace.
///
/// A SQLite file of its own under `Caches/Webyar/LocalStore/u-<hash>/w-<hash>.sqlite`,
/// so nothing of one account or one workspace can ever be read for another:
/// the scope is the file, not a column a query could forget to filter on.
/// The folder names are hashes, so the disk does not say whose data it is.
///
/// Only a cache. Every read from it is shown and then replaced by what the
/// server says. A file that is damaged or from another schema version is
/// deleted and rebuilt empty, and the app carries on from the server. No
/// token, password or preference is ever written here, and no file content —
/// attachments live in `AttachmentDiskCache`, by id.
///
/// An actor: every statement runs off the main thread, one at a time, on the
/// one connection this process holds to the file (`SyncCoordinator` keeps one
/// store per scope, so two handles never race each other for a lock).
actor LocalStore {
    struct Scope: Hashable, Sendable {
        let userID: String
        let workspaceID: String
    }

    nonisolated let scope: Scope
    nonisolated let url: URL
    private let root: URL
    private var db: OpaquePointer?
    private var closed = false
    /// Set when SQLite reports a damaged file: closed and rebuilt on the next call.
    private var damaged = false
    /// The last SQLite result code seen, to tell damage from a file that is
    /// merely unavailable (locked, busy, full) — the second must never be deleted.
    private var lastCode: Int32 = SQLITE_OK
    private let encoder = StoreCoding.encoder()
    private let decoder = StoreCoding.decoder()

    init(scope: Scope, root: URL? = nil) {
        self.scope = scope
        self.root = root ?? Self.defaultRoot
        url = Self.file(for: scope, root: root)
    }

    // MARK: - Where

    static var defaultRoot: URL {
        CachePolicy.root.appendingPathComponent("LocalStore", isDirectory: true)
    }

    /// A short, stable hash: the folder does not spell out the account.
    static func hashedName(_ id: String) -> String {
        SHA256.hash(data: Data(id.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    static func folder(forUser userID: String, root: URL? = nil) -> URL {
        (root ?? defaultRoot).appendingPathComponent("u-" + hashedName(userID), isDirectory: true)
    }

    static func file(for scope: Scope, root: URL? = nil) -> URL {
        folder(forUser: scope.userID, root: root)
            .appendingPathComponent("w-" + hashedName(scope.workspaceID) + ".sqlite")
    }

    // MARK: - Threads

    func thread(_ conversationID: String) -> CachedThread? {
        guard let db = connection() else { return nil }
        var cursor: String?
        var fullAt: Date?
        var complete = true
        var found = false
        query(db, "SELECT cursor, full_at, complete FROM threads WHERE conversation_id = ?", [.text(conversationID)]) { row in
            found = true
            cursor = row.text(0)
            fullAt = row.double(1).map(Date.init(timeIntervalSince1970:))
            complete = row.int(2) != 0
        }
        guard found else { return nil }
        var messages: [Message] = []
        var unreadable = 0
        query(db, "SELECT json FROM messages WHERE conversation_id = ? ORDER BY created_at, id", [.text(conversationID)]) { row in
            if let data = row.blob(0), let message = try? decoder.decode(Message.self, from: data) {
                messages.append(message)
            } else {
                unreadable += 1
            }
        }
        // Damaged under the read: none of it is shown.
        if damaged { return nil }
        // A row this build cannot read is not half-trusted: the thread is
        // dropped and read again from the server.
        if unreadable > 0 {
            StoreLog.write("thread had \(unreadable) unreadable rows, dropped")
            deleteThread(db, conversationID)
            return nil
        }
        run(db, "UPDATE threads SET opened_at = ? WHERE conversation_id = ?",
            [.double(Date().timeIntervalSince1970), .text(conversationID)])
        return CachedThread(messages: messages, cursor: cursor, fullAt: fullAt, complete: complete)
    }

    /// Writes what the server said about a thread: its rows (never the ones
    /// still being sent from this phone) and the cursor for the next delta.
    func saveThread(_ conversationID: String, _ write: ThreadWrite, cursor: String?, fullAt: Date?) {
        guard let db = connection() else { return }
        let now = Date().timeIntervalSince1970
        transaction(db) { db in
            let rows: [Message]
            switch write {
            case .replace(let all):
                run(db, "DELETE FROM messages WHERE conversation_id = ?", [.text(conversationID)])
                rows = all.count > CachePolicy.maxMessagesPerThread
                    ? Array(all.suffix(CachePolicy.maxMessagesPerThread)) : all
            case .upsert(let changed):
                rows = changed
            }
            for message in rows where message.conversationId == conversationID {
                guard let data = try? encoder.encode(message) else { continue }
                run(db, """
                    INSERT OR REPLACE INTO messages
                      (id, conversation_id, client_message_id, sender_type, sender_id, created_at, updated_at, json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [.text(message.id), .text(conversationID), .optionalText(message.clientMessageID),
                     .text(message.senderType.rawValue), .optionalText(message.senderId),
                     .double(message.createdAt?.timeIntervalSince1970 ?? 0),
                     .double(message.updatedAt?.timeIntervalSince1970 ?? 0), .blob(data)])
            }
            // Past the per-thread limit the oldest go, and the thread is marked
            // incomplete: a delta cannot give back what was cut.
            var count = 0
            query(db, "SELECT COUNT(*) FROM messages WHERE conversation_id = ?", [.text(conversationID)]) { count = $0.int(0) }
            var complete = true
            if case .replace(let all) = write, all.count > CachePolicy.maxMessagesPerThread { complete = false }
            if count > CachePolicy.maxMessagesPerThread {
                run(db, """
                    DELETE FROM messages WHERE id IN (
                      SELECT id FROM messages WHERE conversation_id = ?
                      ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)
                    """, [.text(conversationID), .int(CachePolicy.maxMessagesPerThread)])
                complete = false
            }
            var wasComplete = true
            if case .upsert = write {
                query(db, "SELECT complete FROM threads WHERE conversation_id = ?", [.text(conversationID)]) { wasComplete = $0.int(0) != 0 }
            }
            run(db, """
                INSERT INTO threads (conversation_id, cursor, full_at, complete, opened_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(conversation_id) DO UPDATE SET
                  cursor = excluded.cursor, full_at = excluded.full_at,
                  complete = excluded.complete, opened_at = excluded.opened_at
                """,
                [.text(conversationID), .optionalText(cursor),
                 fullAt.map { Bind.double($0.timeIntervalSince1970) } ?? .null,
                 .int(complete && wasComplete ? 1 : 0), .double(now)])
        }
    }

    func forgetThread(_ conversationID: String) {
        guard let db = connection() else { return }
        deleteThread(db, conversationID)
    }

    private func deleteThread(_ db: OpaquePointer, _ conversationID: String) {
        run(db, "DELETE FROM messages WHERE conversation_id = ?", [.text(conversationID)])
        run(db, "DELETE FROM threads WHERE conversation_id = ?", [.text(conversationID)])
    }

    // MARK: - Conversation lists

    func list(_ key: String) -> CachedList? {
        guard let db = connection() else { return nil }
        var etag: String?
        var savedAt: Double?
        query(db, "SELECT etag, saved_at FROM lists WHERE key = ?", [.text(key)]) { row in
            etag = row.text(0)
            savedAt = row.double(1)
        }
        guard let savedAt, !damaged else { return nil }
        var conversations: [Conversation] = []
        var unreadable = false
        query(db, """
            SELECT c.json FROM list_members m JOIN conversations c ON c.id = m.conversation_id
            WHERE m.list_key = ? ORDER BY m.position
            """, [.text(key)]) { row in
            if let data = row.blob(0), let conversation = try? decoder.decode(Conversation.self, from: data) {
                conversations.append(conversation)
            } else {
                unreadable = true
            }
        }
        if damaged { return nil }
        if unreadable {
            StoreLog.write("list had unreadable rows, dropped")
            run(db, "DELETE FROM list_members WHERE list_key = ?", [.text(key)])
            run(db, "DELETE FROM lists WHERE key = ?", [.text(key)])
            return nil
        }
        return CachedList(conversations: conversations, etag: etag, savedAt: Date(timeIntervalSince1970: savedAt))
    }

    func saveList(_ key: String, _ conversations: [Conversation], etag: String?) {
        guard let db = connection() else { return }
        let now = Date().timeIntervalSince1970
        transaction(db) { db in
            run(db, "DELETE FROM list_members WHERE list_key = ?", [.text(key)])
            for (position, conversation) in conversations.enumerated()
            where conversation.workspaceId == scope.workspaceID {
                guard upsert(db, conversation, savedAt: now) else { continue }
                run(db, "INSERT OR REPLACE INTO list_members (list_key, conversation_id, position) VALUES (?, ?, ?)",
                    [.text(key), .text(conversation.id), .int(position)])
            }
            run(db, "INSERT OR REPLACE INTO lists (key, etag, saved_at) VALUES (?, ?, ?)",
                [.text(key), .optionalText(etag), .double(now)])
        }
    }

    /// One conversation, from whichever list last carried it (or a direct read).
    func conversation(_ id: String) -> Conversation? {
        guard let db = connection() else { return nil }
        var found: Conversation?
        query(db, "SELECT json FROM conversations WHERE id = ?", [.text(id)]) { row in
            found = row.blob(0).flatMap { try? decoder.decode(Conversation.self, from: $0) }
        }
        return damaged ? nil : found
    }

    /// Keeps one conversation read on its own (a notification's), without
    /// putting it in any list.
    func saveConversation(_ conversation: Conversation) {
        guard conversation.workspaceId == scope.workspaceID, let db = connection() else { return }
        upsert(db, conversation, savedAt: Date().timeIntervalSince1970)
    }

    /// Forgets a conversation the server no longer shows this operator.
    func forgetConversation(_ id: String) {
        guard let db = connection() else { return }
        transaction(db) { db in
            run(db, "DELETE FROM list_members WHERE conversation_id = ?", [.text(id)])
            run(db, "DELETE FROM conversations WHERE id = ?", [.text(id)])
            deleteThread(db, id)
        }
    }

    @discardableResult
    private func upsert(_ db: OpaquePointer, _ c: Conversation, savedAt: Double) -> Bool {
        guard let data = try? encoder.encode(c) else { return false }
        return run(db, """
            INSERT OR REPLACE INTO conversations
              (id, status, assigned_to, unread_count, last_activity, updated_at, saved_at, json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [.text(c.id), .text(c.status.rawValue), .optionalText(c.assignedTo), .int(c.unreadCount ?? 0),
             .double(c.lastActivity?.timeIntervalSince1970 ?? 0), .double(c.updatedAt?.timeIntervalSince1970 ?? 0),
             .double(savedAt), .blob(data)])
    }

    // MARK: - Small values

    func counts() -> InboxCounts? {
        value("counts").flatMap { try? decoder.decode(InboxCounts.self, from: $0) }
    }

    func saveCounts(_ counts: InboxCounts) {
        guard let data = try? encoder.encode(counts) else { return }
        setValue("counts", data)
    }

    private func value(_ key: String) -> Data? {
        guard let db = connection() else { return nil }
        var out: Data?
        query(db, "SELECT value FROM meta WHERE key = ?", [.text(key)]) { out = $0.blob(0) }
        return damaged ? nil : out
    }

    private func setValue(_ key: String, _ data: Data) {
        guard let db = connection() else { return }
        run(db, "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [.text(key), .blob(data)])
    }

    // MARK: - Upkeep

    /// Old and surplus threads out, stale lists out; the file compacted when
    /// much of it is free and the phone is not saving power.
    func prune(now: Date = Date(), allowVacuum: Bool) {
        guard let db = connection() else { return }
        let bytes = Self.bytes(of: url)
        // Past the soft limit, keep half as many threads.
        let keepThreads = bytes > CachePolicy.storeSoftLimitBytes ? CachePolicy.maxThreads / 2 : CachePolicy.maxThreads
        let cutoff = now.addingTimeInterval(-CachePolicy.threadRetention).timeIntervalSince1970
        let listCutoff = now.addingTimeInterval(-CachePolicy.listRetention).timeIntervalSince1970
        transaction(db) { db in
            run(db, "DELETE FROM threads WHERE opened_at < ?", [.double(cutoff)])
            run(db, """
                DELETE FROM threads WHERE conversation_id NOT IN (
                  SELECT conversation_id FROM threads ORDER BY opened_at DESC LIMIT ?)
                """, [.int(keepThreads)])
            run(db, "DELETE FROM messages WHERE conversation_id NOT IN (SELECT conversation_id FROM threads)")
            run(db, "DELETE FROM list_members WHERE list_key IN (SELECT key FROM lists WHERE saved_at < ?)", [.double(listCutoff)])
            run(db, "DELETE FROM lists WHERE saved_at < ?", [.double(listCutoff)])
            // A conversation no list carries any more, and not opened lately, goes too.
            run(db, """
                DELETE FROM conversations WHERE saved_at < ?
                  AND id NOT IN (SELECT conversation_id FROM list_members)
                  AND id NOT IN (SELECT conversation_id FROM threads)
                """, [.double(listCutoff)])
        }
        guard allowVacuum else { return }
        var free = 0
        query(db, "PRAGMA freelist_count", []) { free = $0.int(0) }
        if free > CachePolicy.vacuumFreePages {
            run(db, "VACUUM")
            StoreLog.write("vacuumed \(free) free pages")
        }
    }

    /// Counts for Settings and the log: never content.
    func stats() -> (threads: Int, messages: Int, conversations: Int) {
        guard let db = connection() else { return (0, 0, 0) }
        var t = 0, m = 0, c = 0
        query(db, "SELECT (SELECT COUNT(*) FROM threads), (SELECT COUNT(*) FROM messages), (SELECT COUNT(*) FROM conversations)", []) {
            t = $0.int(0); m = $0.int(1); c = $0.int(2)
        }
        return (t, m, c)
    }

    /// Empties the store and keeps it open (Clear Cache while signed in).
    func reset() {
        guard let db = connection() else { return }
        transaction(db) { db in
            for table in ["messages", "threads", "list_members", "lists", "conversations", "meta"] {
                run(db, "DELETE FROM \(table)")
            }
        }
        run(db, "VACUUM")
    }

    /// Closes the file; later calls do nothing.
    func close() {
        closed = true
        if let db { sqlite3_close_v2(db) }
        db = nil
    }

    /// Closes and deletes the file.
    func destroy() {
        close()
        Self.removeFiles(url)
    }

    // MARK: - The whole cache, every account

    static func measure(root: URL? = nil) -> Int64 {
        FileSize.ofDirectory(root ?? defaultRoot)
    }

    /// Deletes every store file except `keep` (emptied with `reset()` instead).
    static func removeAll(except keep: URL?, root: URL? = nil) {
        let dir = root ?? defaultRoot
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else { return }
        let keepPaths = keep.map { k in Set(["", "-wal", "-shm", "-journal"].map { k.path + $0 }) } ?? []
        for case let file as URL in e where file.lastPathComponent.contains(".sqlite") {
            if !keepPaths.contains(file.path) { try? FileManager.default.removeItem(at: file) }
        }
    }

    /// Every workspace of one account: an explicit sign-out, or the account deleted.
    static func removeUser(_ userID: String, root: URL? = nil) {
        try? FileManager.default.removeItem(at: folder(forUser: userID, root: root))
    }

    private static func removeFiles(_ url: URL) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            try? FileManager.default.removeItem(atPath: url.path + suffix)
        }
    }

    private static func bytes(of url: URL) -> Int64 {
        ["", "-wal", "-shm"].reduce(Int64(0)) { total, suffix in
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path + suffix)
            return total + ((attributes?[.size] as? NSNumber)?.int64Value ?? 0)
        }
    }

    // MARK: - Opening

    /// The open database, opened (checked, and if need be rebuilt) on first use.
    private func connection() -> OpaquePointer? {
        if closed { return nil }
        if damaged {
            if let old = db { sqlite3_close_v2(old) }
            db = nil
            damaged = false
            StoreLog.write("damaged store removed; rebuilding from the server")
            Self.removeFiles(url)
        }
        if let db { return db }
        switch openChecked() {
        case .open(let fresh):
            db = fresh
            return fresh
        case .unavailable:
            // Locked by data protection, busy, or the disk is full: the file
            // may be perfectly healthy and must not be deleted. This one call
            // runs from the server only.
            StoreLog.write("store unavailable (code \(lastCode & 0xff)); skipped")
            return nil
        case .unusable:
            break
        }
        // Damaged, or written by another schema: start over, empty.
        StoreLog.write("rebuilding local store")
        Self.removeFiles(url)
        if case .open(let fresh) = openChecked() {
            db = fresh
        } else {
            StoreLog.write("local store unavailable; running from the server only")
        }
        return db
    }

    private enum Opening { case open(OpaquePointer), unavailable, unusable }

    /// Damage is a verdict only SQLite can give: CORRUPT, NOTADB, or an
    /// integrity check that reports problems. Anything else — a busy file, a
    /// file iOS will not open while the phone is locked, a full disk — is a
    /// file that is fine and cannot be used right now.
    private static func isDamage(_ code: Int32) -> Bool {
        let primary = code & 0xff
        return primary == SQLITE_CORRUPT || primary == SQLITE_NOTADB
    }

    private func openChecked() -> Opening {
        lastCode = SQLITE_OK
        do {
            try Self.prepareFolder(url.deletingLastPathComponent(), root: root)
        } catch {
            return .unavailable
        }
        var handle: OpaquePointer?
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
        #if os(iOS)
        // SQLITE_OPEN_FILEPROTECTION_COMPLETEUNTILFIRSTUSERAUTHENTICATION, the
        // flag Apple's SQLite adds so the database, its journal and its WAL
        // are all created in that protection class — spelled as its value so
        // the build does not depend on how the SDK header exposes the macro.
        // See `FileProtection` for why not the stricter class.
        flags |= 0x0030_0000
        #endif
        let rc = sqlite3_open_v2(url.path, &handle, flags, nil)
        guard rc == SQLITE_OK, let h = handle else {
            lastCode = handle.map { sqlite3_extended_errcode($0) } ?? rc
            if let handle { sqlite3_close_v2(handle) }
            return Self.isDamage(lastCode) ? .unusable : .unavailable
        }
        sqlite3_busy_timeout(h, 2_000)
        var check: String?
        query(h, "PRAGMA quick_check", []) { check = $0.text(0) }
        if damaged || Self.isDamage(lastCode) {
            damaged = false
            sqlite3_close_v2(h)
            StoreLog.write("integrity check failed")
            return .unusable
        }
        guard let check else {
            // The check could not run at all: not a verdict on the file.
            sqlite3_close_v2(h)
            return .unavailable
        }
        guard check == "ok" else {
            sqlite3_close_v2(h)
            StoreLog.write("integrity check reported damage")
            return .unusable
        }
        var version: Int32 = -1
        query(h, "PRAGMA user_version", []) { version = Int32($0.int(0)) }
        if version != CachePolicy.schemaVersion {
            // 0 is a new file, created here; any other version is another
            // build's cache, rebuilt rather than migrated.
            if version != 0 {
                StoreLog.write("schema \(version) → \(CachePolicy.schemaVersion), rebuilt")
                sqlite3_close_v2(h)
                return .unusable
            }
            guard create(h) else {
                sqlite3_close_v2(h)
                return Self.isDamage(lastCode) ? .unusable : .unavailable
            }
        }
        FileProtection.apply(to: url)
        return .open(h)
    }

    /// The store's folders, created protected and kept out of backups.
    static func prepareFolder(_ folder: URL, root: URL) throws {
        try FileProtection.createDirectory(root)
        try FileProtection.createDirectory(folder)
    }

    private func create(_ db: OpaquePointer) -> Bool {
        let schema = """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB);
            CREATE TABLE IF NOT EXISTS conversations (
              id TEXT PRIMARY KEY, status TEXT, assigned_to TEXT, unread_count INTEGER NOT NULL DEFAULT 0,
              last_activity REAL NOT NULL DEFAULT 0, updated_at REAL NOT NULL DEFAULT 0,
              saved_at REAL NOT NULL, json BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS lists (key TEXT PRIMARY KEY, etag TEXT, saved_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS list_members (
              list_key TEXT NOT NULL, conversation_id TEXT NOT NULL, position INTEGER NOT NULL,
              PRIMARY KEY (list_key, conversation_id));
            CREATE INDEX IF NOT EXISTS list_members_by_conversation ON list_members (conversation_id);
            CREATE TABLE IF NOT EXISTS threads (
              conversation_id TEXT PRIMARY KEY, cursor TEXT, full_at REAL,
              complete INTEGER NOT NULL DEFAULT 1, opened_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, client_message_id TEXT,
              sender_type TEXT, sender_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
              json BLOB NOT NULL);
            CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (conversation_id, created_at);
            PRAGMA user_version = \(CachePolicy.schemaVersion);
            """
        let rc = sqlite3_exec(db, schema, nil, nil, nil)
        if rc != SQLITE_OK { lastCode = sqlite3_extended_errcode(db) }
        return rc == SQLITE_OK
    }

    // MARK: - Statements

    enum Bind {
        case text(String), double(Double), int(Int), blob(Data), null

        static func optionalText(_ value: String?) -> Bind { value.map(Bind.text) ?? .null }
    }

    struct Row {
        let stmt: OpaquePointer
        func text(_ i: Int32) -> String? {
            guard sqlite3_column_type(stmt, i) != SQLITE_NULL, let c = sqlite3_column_text(stmt, i) else { return nil }
            return String(cString: c)
        }
        func double(_ i: Int32) -> Double? {
            sqlite3_column_type(stmt, i) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, i)
        }
        func int(_ i: Int32) -> Int { Int(sqlite3_column_int64(stmt, i)) }
        func blob(_ i: Int32) -> Data? {
            guard let p = sqlite3_column_blob(stmt, i) else { return nil }
            return Data(bytes: p, count: Int(sqlite3_column_bytes(stmt, i)))
        }
    }

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private func prepare(_ db: OpaquePointer, _ sql: String, _ binds: [Bind]) -> OpaquePointer? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let s = stmt else {
            noteFailure(db)
            return nil
        }
        for (i, bind) in binds.enumerated() {
            let at = Int32(i + 1)
            switch bind {
            case .text(let v): sqlite3_bind_text(s, at, v, -1, Self.transient)
            case .double(let v): sqlite3_bind_double(s, at, v)
            case .int(let v): sqlite3_bind_int64(s, at, Int64(v))
            case .blob(let v): _ = v.withUnsafeBytes { sqlite3_bind_blob(s, at, $0.baseAddress, Int32(v.count), Self.transient) }
            case .null: sqlite3_bind_null(s, at)
            }
        }
        return s
    }

    private func query(_ db: OpaquePointer, _ sql: String, _ binds: [Bind], _ each: (Row) -> Void) {
        guard let s = prepare(db, sql, binds) else { return }
        defer { sqlite3_finalize(s) }
        while true {
            let rc = sqlite3_step(s)
            if rc == SQLITE_ROW { each(Row(stmt: s)); continue }
            if rc != SQLITE_DONE { noteFailure(db) }
            return
        }
    }

    @discardableResult
    private func run(_ db: OpaquePointer, _ sql: String, _ binds: [Bind] = []) -> Bool {
        guard let s = prepare(db, sql, binds) else { return false }
        defer { sqlite3_finalize(s) }
        let rc = sqlite3_step(s)
        if rc != SQLITE_DONE && rc != SQLITE_ROW {
            noteFailure(db)
            return false
        }
        return true
    }

    /// The handle is passed in rather than captured, so the body never holds
    /// on to the connection outside the call.
    private func transaction(_ db: OpaquePointer, _ body: (OpaquePointer) -> Void) {
        guard run(db, "BEGIN IMMEDIATE") else { return }
        body(db)
        if !run(db, "COMMIT") { run(db, "ROLLBACK") }
    }

    /// A damaged file found in use is dropped, and the next call starts from
    /// an empty one. A full disk only loses this write: the cache is a
    /// convenience and the server still has everything.
    private func noteFailure(_ db: OpaquePointer) {
        lastCode = sqlite3_extended_errcode(db)
        let code = lastCode & 0xff
        switch code {
        case SQLITE_CORRUPT, SQLITE_NOTADB:
            StoreLog.write("damaged (code \(code)); rebuilding")
            damaged = true
        case SQLITE_FULL:
            StoreLog.write("disk full; write skipped")
        case SQLITE_BUSY, SQLITE_LOCKED:
            StoreLog.write("busy")
        default:
            StoreLog.write("sqlite code \(code)")
        }
    }
}

// MARK: - Coding

/// How rows are written to and read from the store: dates to the
/// millisecond, read back with the same parser the API uses, so a stored
/// copy merges exactly like the server's.
enum StoreCoding {
    static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(format(date))
        }
        return e
    }

    static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = DateParsing.parse(raw) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: raw))
            }
            return date
        }
        return d
    }

    /// ISO 8601 with milliseconds, UTC. Built by hand rather than with a
    /// shared formatter so nothing mutable is shared between threads.
    static func format(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second, .nanosecond], from: date)
        let millis = min(999, Int((Double(c.nanosecond ?? 0) / 1_000_000).rounded()))
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                      c.year ?? 1970, c.month ?? 1, c.day ?? 1, c.hour ?? 0, c.minute ?? 0, c.second ?? 0, millis)
    }
}

// MARK: - Files

/// How the cache's files are protected on disk.
///
/// `completeUntilFirstUserAuthentication`: encrypted with a key that exists
/// only after the phone has been unlocked once since it started. A phone that
/// is off, or restarted and never unlocked, gives nothing up.
///
/// Not `complete` (readable only while unlocked). The app keeps working with
/// the screen locked — a call in progress holds it in the background with the
/// audio mode — and a store that became unreadable ten seconds after the lock
/// would fail every write in the middle of that, which SQLite reports as an
/// I/O error. `LocalStore` never mistakes that for damage, but the call's
/// thread would still be written nowhere. This is the class Apple recommends
/// for data a running app needs while locked, and what Messages-style apps
/// use; the credential stays in the Keychain, apart from all of it.
enum FileProtection {
    static func createDirectory(_ url: URL) throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue {
            return
        }
        #if os(iOS)
        try FileManager.default.createDirectory(
            at: url, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        #else
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        #endif
        excludeFromBackup(url)
    }

    static func apply(to url: URL) {
        #if os(iOS)
        for suffix in ["", "-wal", "-shm"] {
            let path = url.path + suffix
            guard FileManager.default.fileExists(atPath: path) else { continue }
            try? FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path
            )
        }
        #endif
    }

    /// `Caches` is never backed up anyway; said again on the folder itself so
    /// a future move of the root cannot quietly put customer data in a backup.
    static func excludeFromBackup(_ url: URL) {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = url
        try? target.setResourceValues(values)
    }

    #if os(iOS)
    static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
    #else
    static let writingOptions: Data.WritingOptions = [.atomic]
    #endif
}

enum FileSize {
    static func ofDirectory(_ url: URL) -> Int64 {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in e {
            let values = try? file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values?.isRegularFile == true else { continue }
            total += Int64(values?.fileSize ?? 0)
        }
        return total
    }
}

/// Events of the cache worth a line in the console: never content, never ids.
enum StoreLog {
    static func write(_ line: String) {
        #if DEBUG
        print("[cache] \(line)")
        #endif
    }
}
