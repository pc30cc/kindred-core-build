import CryptoKit
import Foundation
import SQLite3

/// A thread as last read from the server, kept on this Mac.
struct CachedThread: Sendable {
    var messages: [Message]
    /// The server's sync cursor for the next delta; nil means "read it whole next time".
    var cursor: String?
    /// When the thread was last read whole.
    var fullAt: Date?
    /// False when the thread had more messages than the store keeps: the newest are
    /// shown, and the next read is a whole one.
    var complete: Bool
}

/// A conversation list as last read from the server.
struct CachedList: Sendable {
    var conversations: [Conversation]
    var etag: String?
    var savedAt: Date
}

/// The messages and conversation lists of one operator in one workspace, in a
/// SQLite file of their own under Caches/LocalStore/<user>/<workspace>.sqlite,
/// so nothing of one account or workspace can ever be read for another.
///
/// Only a cache: the server stays the truth. Every read is shown and then
/// replaced by what the server says; a file that is damaged, from another
/// schema version, or unreadable is deleted and rebuilt empty, and the app
/// carries on from the server. No token, password or session is ever written
/// here, and no file content — attachments stay in FileCache, by id.
///
/// An actor: all disk work happens off the main thread, one statement at a time.
actor LocalStore {
    struct Scope: Hashable, Sendable {
        let userId: String
        let workspaceId: String
    }

    nonisolated let scope: Scope
    nonisolated let url: URL
    private var db: OpaquePointer?
    private var closed = false
    /// Set when SQLite reports a damaged file: the handle is closed and the file rebuilt on the next call.
    private var damaged = false

    init(scope: Scope, root: URL? = nil) {
        self.scope = scope
        url = Self.file(for: scope, root: root)
    }

    // MARK: Where

    /// Caches/LocalStore: the system may empty it when the disk runs low, which only costs a re-read.
    static var root: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("LocalStore", isDirectory: true)
    }

    /// Names are hashes: the folder does not say which account it belongs to.
    private static func name(_ id: String) -> String {
        SHA256.hash(data: Data(id.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    static func folder(forUser userId: String, root: URL? = nil) -> URL {
        (root ?? Self.root).appendingPathComponent("u-" + name(userId), isDirectory: true)
    }

    static func file(for scope: Scope, root: URL? = nil) -> URL {
        folder(forUser: scope.userId, root: root).appendingPathComponent("w-" + name(scope.workspaceId) + ".sqlite")
    }

    // MARK: Threads

    func thread(_ conversationId: String) -> CachedThread? {
        guard let db = connection() else { return nil }
        var cursor: String?
        var fullAt: Date?
        var complete = true
        var found = false
        query(db, "SELECT cursor, full_at, complete FROM threads WHERE conversation_id = ?", [.text(conversationId)]) { row in
            found = true
            cursor = row.text(0)
            fullAt = row.double(1).map(Date.init(timeIntervalSince1970:))
            complete = row.int(2) != 0
        }
        guard found else { return nil }
        var messages: [Message] = []
        var unreadable = 0
        let decoder = JSON.decoder()
        query(db, "SELECT json FROM messages WHERE conversation_id = ? ORDER BY created_at, id", [.text(conversationId)]) { row in
            if let data = row.blob(0), let m = try? decoder.decode(Message.self, from: data) { messages.append(m) } else { unreadable += 1 }
        }
        // Damaged under the read: nothing of it is shown.
        if damaged { return nil }
        // A row this build cannot read is not half-trusted: the thread is dropped and read again.
        if unreadable > 0 {
            Log.write("[store] thread unreadable rows=\(unreadable), dropped")
            deleteThread(db, conversationId)
            return nil
        }
        run(db, "UPDATE threads SET opened_at = ? WHERE conversation_id = ?", [.double(Date().timeIntervalSince1970), .text(conversationId)])
        return CachedThread(messages: messages, cursor: cursor, fullAt: fullAt, complete: complete)
    }

    /// Replaces the stored thread with the one the app now shows (server rows only — never
    /// the outbox of messages still being sent).
    func saveThread(_ conversationId: String, messages: [Message], cursor: String?, fullAt: Date?) {
        guard let db = connection() else { return }
        let encoder = Self.encoder
        let kept = messages.count > CachePolicy.maxMessagesPerThread ? Array(messages.suffix(CachePolicy.maxMessagesPerThread)) : messages
        let complete = kept.count == messages.count
        transaction(db) {
            deleteThread(db, conversationId)
            run(db, "INSERT INTO threads (conversation_id, cursor, full_at, complete, opened_at) VALUES (?, ?, ?, ?, ?)",
                [.text(conversationId), cursor.map { Bind.text($0) } ?? Bind.null, fullAt.map { Bind.double($0.timeIntervalSince1970) } ?? Bind.null,
                 .int(complete ? 1 : 0), .double(Date().timeIntervalSince1970)])
            for m in kept {
                guard let data = try? encoder.encode(m) else { continue }
                run(db, "INSERT OR REPLACE INTO messages (id, conversation_id, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?)",
                    [.text(m.id), .text(conversationId), .double(m.createdAt?.timeIntervalSince1970 ?? 0),
                     .double(m.updatedAt?.timeIntervalSince1970 ?? 0), .blob(data)])
            }
        }
    }

    func forgetThread(_ conversationId: String) {
        guard let db = connection() else { return }
        deleteThread(db, conversationId)
    }

    private func deleteThread(_ db: OpaquePointer, _ conversationId: String) {
        run(db, "DELETE FROM messages WHERE conversation_id = ?", [.text(conversationId)])
        run(db, "DELETE FROM threads WHERE conversation_id = ?", [.text(conversationId)])
    }

    // MARK: Lists

    func list(_ key: String) -> CachedList? {
        guard let db = connection() else { return nil }
        var out: CachedList?
        var unreadable = false
        query(db, "SELECT json, etag, saved_at FROM lists WHERE key = ?", [.text(key)]) { row in
            guard let data = row.blob(0), let list = try? JSON.decoder().decode([Conversation].self, from: data) else {
                unreadable = true
                return
            }
            out = CachedList(conversations: list, etag: row.text(1), savedAt: Date(timeIntervalSince1970: row.double(2) ?? 0))
        }
        if damaged { return nil }
        if unreadable {
            Log.write("[store] list unreadable, dropped")
            run(db, "DELETE FROM lists WHERE key = ?", [.text(key)])
        }
        return out
    }

    func saveList(_ key: String, _ conversations: [Conversation], etag: String?) {
        guard let db = connection(), let data = try? Self.encoder.encode(conversations) else { return }
        run(db, "INSERT OR REPLACE INTO lists (key, json, etag, saved_at) VALUES (?, ?, ?, ?)",
            [.text(key), .blob(data), etag.map { Bind.text($0) } ?? Bind.null, .double(Date().timeIntervalSince1970)])
    }

    // MARK: Upkeep

    /// Old and surplus threads out; the file compacted when much of it is free.
    func prune(now: Date = Date()) {
        guard let db = connection() else { return }
        let cutoff = now.addingTimeInterval(-CachePolicy.threadRetention).timeIntervalSince1970
        transaction(db) {
            run(db, "DELETE FROM messages WHERE conversation_id IN (SELECT conversation_id FROM threads WHERE opened_at < ?)", [.double(cutoff)])
            run(db, "DELETE FROM threads WHERE opened_at < ?", [.double(cutoff)])
            run(db, """
                DELETE FROM messages WHERE conversation_id IN (
                  SELECT conversation_id FROM threads ORDER BY opened_at DESC LIMIT -1 OFFSET ?)
                """, [.int(CachePolicy.maxThreads)])
            run(db, "DELETE FROM threads WHERE conversation_id NOT IN (SELECT conversation_id FROM threads ORDER BY opened_at DESC LIMIT ?)",
                [.int(CachePolicy.maxThreads)])
            run(db, "DELETE FROM lists WHERE saved_at < ?", [.double(now.addingTimeInterval(-CachePolicy.listRetention).timeIntervalSince1970)])
        }
        var free = 0
        query(db, "PRAGMA freelist_count", []) { free = $0.int(0) }
        if free > CachePolicy.vacuumFreePages {
            run(db, "VACUUM")
            Log.write("[store] vacuumed freePages=\(free)")
        }
    }

    /// Counts for the log: never content.
    func stats() -> (threads: Int, messages: Int, lists: Int) {
        guard let db = connection() else { return (0, 0, 0) }
        var t = 0, m = 0, l = 0
        query(db, "SELECT (SELECT COUNT(*) FROM threads), (SELECT COUNT(*) FROM messages), (SELECT COUNT(*) FROM lists)", []) {
            t = $0.int(0); m = $0.int(1); l = $0.int(2)
        }
        return (t, m, l)
    }

    /// Empties the store and keeps it open (Clear cache while signed in).
    func reset() {
        guard let db = connection() else { return }
        transaction(db) {
            run(db, "DELETE FROM messages")
            run(db, "DELETE FROM threads")
            run(db, "DELETE FROM lists")
        }
        run(db, "VACUUM")
    }

    /// Closes the file; later calls do nothing (the operator signed out or moved on).
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

    // MARK: Whole cache

    /// Bytes on disk for every account and workspace.
    static func measure(root: URL? = nil) -> Int64 {
        let dir = root ?? Self.root
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let f as URL in e { total += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        return total
    }

    /// Deletes every store file but `keep` (the one open now, which is emptied with `reset()` instead).
    static func removeAll(except keep: URL?, root: URL? = nil) {
        let dir = root ?? Self.root
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else { return }
        let keepPaths = keep.map { k in Set(["", "-wal", "-shm", "-journal"].map { k.path + $0 }) } ?? []
        for case let f as URL in e where f.pathExtension.hasPrefix("sqlite") || f.lastPathComponent.contains(".sqlite-") {
            if !keepPaths.contains(f.path) { try? FileManager.default.removeItem(at: f) }
        }
    }

    /// Every workspace of one account (an explicit sign-out).
    static func removeUser(_ userId: String, root: URL? = nil) {
        try? FileManager.default.removeItem(at: folder(forUser: userId, root: root))
    }

    private static func removeFiles(_ url: URL) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            try? FileManager.default.removeItem(atPath: url.path + suffix)
        }
    }

    /// Dates with their milliseconds, so what is read back merges exactly like what was written.
    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        e.dateEncodingStrategy = .custom { date, enc in
            var c = enc.singleValueContainer()
            try c.encode(f.string(from: date))
        }
        return e
    }()

    // MARK: Opening

    /// The open database, opened (and checked, and if need be rebuilt) on first use.
    private func connection() -> OpaquePointer? {
        if closed { return nil }
        if damaged, let old = db {
            sqlite3_close_v2(old)
            db = nil
            damaged = false
            Self.removeFiles(url)
        }
        if let db { return db }
        if let fresh = openChecked() { db = fresh; return fresh }
        // Unreadable, damaged or from another schema: start over, empty.
        Log.write("[store] rebuilding local store")
        Self.removeFiles(url)
        db = openChecked()
        if db == nil { Log.write("[store] local store unavailable; running from the server only") }
        return db
    }

    private func openChecked() -> OpaquePointer? {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        } catch {
            return nil
        }
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(url.path, &handle, flags, nil) == SQLITE_OK, let h = handle else {
            if let handle { sqlite3_close_v2(handle) }
            return nil
        }
        sqlite3_busy_timeout(h, 2_000)
        var ok = "fail"
        query(h, "PRAGMA quick_check", []) { ok = $0.text(0) ?? "fail" }
        var version: Int32 = -1
        query(h, "PRAGMA user_version", []) { version = Int32($0.int(0)) }
        guard ok == "ok", !damaged else {
            damaged = false
            Log.write("[store] integrity check failed")
            sqlite3_close_v2(h)
            return nil
        }
        if version != CachePolicy.schemaVersion {
            // A new file (0) is created here; any other version is another build's cache: rebuilt.
            if version != 0 {
                Log.write("[store] schema \(version) → \(CachePolicy.schemaVersion), rebuilt")
                sqlite3_close_v2(h)
                return nil
            }
            guard create(h) else {
                sqlite3_close_v2(h)
                return nil
            }
        }
        return h
    }

    private func create(_ db: OpaquePointer) -> Bool {
        let schema = """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS lists (key TEXT PRIMARY KEY, json BLOB NOT NULL, etag TEXT, saved_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS threads (conversation_id TEXT PRIMARY KEY, cursor TEXT, full_at REAL,
                                                complete INTEGER NOT NULL DEFAULT 1, opened_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
                                                 created_at REAL NOT NULL, updated_at REAL NOT NULL, json BLOB NOT NULL);
            CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (conversation_id, created_at);
            PRAGMA user_version = \(CachePolicy.schemaVersion);
            """
        return sqlite3_exec(db, schema, nil, nil, nil) == SQLITE_OK
    }

    // MARK: Statements

    enum Bind {
        case text(String), double(Double), int(Int), blob(Data), null
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
        for (i, b) in binds.enumerated() {
            let at = Int32(i + 1)
            switch b {
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

    private func transaction(_ db: OpaquePointer, _ body: () -> Void) {
        guard run(db, "BEGIN IMMEDIATE") else { return }
        body()
        if !run(db, "COMMIT") { run(db, "ROLLBACK") }
    }

    /// A damaged file found while in use: dropped, and the next call starts from an empty one.
    /// A full disk only loses this write: the cache is a convenience.
    private func noteFailure(_ db: OpaquePointer) {
        let code = sqlite3_errcode(db) & 0xff
        switch code {
        case SQLITE_CORRUPT, SQLITE_NOTADB:
            Log.write("[store] damaged (code \(code)), rebuilding")
            damaged = true
        case SQLITE_FULL:
            Log.write("[store] disk full, write skipped")
        default:
            Log.write("[store] sqlite code \(code)")
        }
    }
}
