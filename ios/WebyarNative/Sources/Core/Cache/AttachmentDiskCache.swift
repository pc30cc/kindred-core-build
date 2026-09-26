import CryptoKit
import Foundation

/// Attachment files kept on this phone, so a photo, a voice note or a
/// document is downloaded once — not on every open, and not again after the
/// app is relaunched.
///
/// `Library/Caches/Webyar/Attachments/u-<hash>/w-<hash>/<hash>.<ext>`:
/// - one folder per account and workspace, so a file fetched for one is never
///   served to another;
/// - named by a hash of the attachment id, never by the name the sender gave
///   the file, whose extension is reduced to a few letters and digits — so no
///   name a visitor chooses can reach outside the folder or collide;
/// - written atomically (a crash leaves the old file or none, never half of
///   one) and protected until the phone is first unlocked after a restart;
/// - bounded, and trimmed least-recently-used first: every file read is
///   stamped as used, and a trim removes the ones read longest ago.
///
/// A file that is open right now — a voice note playing, a document in Quick
/// Look — is pinned, and neither a trim nor Clear Cache removes it under the
/// player. A full disk is not an error anyone sees: the file is used from
/// memory this once and simply not kept.
actor AttachmentDiskCache {
    static let shared = AttachmentDiskCache()

    private let root: URL
    private var limit: Int64
    private var pinned: [String: Int] = [:]
    /// The folder's size as last measured, kept up to date on every write so
    /// a write does not have to walk the whole folder.
    private var knownBytes: Int64?

    init(root: URL? = nil, limit: Int64? = nil) {
        let root = root ?? CachePolicy.root.appendingPathComponent("Attachments", isDirectory: true)
        self.root = root
        self.limit = limit ?? CachePolicy.attachmentDiskLimit(freeBytes: Self.freeBytes(near: root))
    }

    nonisolated var rootURL: URL { root }

    // MARK: - Paths

    func folder(for scope: LocalStore.Scope) -> URL {
        root.appendingPathComponent("u-" + LocalStore.hashedName(scope.userID), isDirectory: true)
            .appendingPathComponent("w-" + LocalStore.hashedName(scope.workspaceID), isDirectory: true)
    }

    func location(id: String, fileExtension: String?, scope: LocalStore.Scope) -> URL {
        folder(for: scope).appendingPathComponent(Self.fileName(id: id, fileExtension: fileExtension))
    }

    /// `<32 hex>.<ext>`: nothing the sender typed survives into the path
    /// except a short run of letters and digits.
    static func fileName(id: String, fileExtension: String?) -> String {
        let hash = SHA256.hash(data: Data(id.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        return hash + "." + sanitizedExtension(fileExtension)
    }

    static func sanitizedExtension(_ raw: String?) -> String {
        let lowered = (raw ?? "").lowercased()
        let kept = lowered.unicodeScalars.filter { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
        let ext = String(String.UnicodeScalarView(kept.prefix(8)))
        return ext.isEmpty ? "bin" : ext
    }

    // MARK: - Reading

    /// The file, if it is here and not empty. Stamped as used.
    func existing(id: String, fileExtension: String?, scope: LocalStore.Scope) -> URL? {
        let url = location(id: id, fileExtension: fileExtension, scope: scope)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        guard size > 0 else {
            // An empty file is a failed write from another life: not a hit.
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        stampAsUsed(url, lastStamp: attributes[.modificationDate] as? Date)
        return url
    }

    func data(id: String, fileExtension: String?, scope: LocalStore.Scope) -> Data? {
        guard let url = existing(id: id, fileExtension: fileExtension, scope: scope) else { return nil }
        return try? Data(contentsOf: url, options: .mappedIfSafe)
    }

    // MARK: - Writing

    /// Keeps bytes fetched into memory. Nil when they could not be kept (a
    /// full disk): the caller still has them.
    @discardableResult
    func store(_ data: Data, id: String, fileExtension: String?, scope: LocalStore.Scope) -> URL? {
        guard !data.isEmpty else { return nil }
        let url = location(id: id, fileExtension: fileExtension, scope: scope)
        do {
            try FileProtection.createDirectory(root)
            try FileProtection.createDirectory(url.deletingLastPathComponent())
            try data.write(to: url, options: FileProtection.writingOptions)
        } catch {
            StoreLog.write("attachment not kept: \(Self.reason(error))")
            return nil
        }
        knownBytes = knownBytes.map { $0 + Int64(data.count) }
        trimIfNeeded()
        return url
    }

    /// Takes over a file downloaded straight to disk. The temporary file is
    /// always consumed, kept or not.
    func adopt(_ temporary: URL, id: String, fileExtension: String?, scope: LocalStore.Scope) -> URL? {
        defer { try? FileManager.default.removeItem(at: temporary) }
        let url = location(id: id, fileExtension: fileExtension, scope: scope)
        do {
            try FileProtection.createDirectory(root)
            try FileProtection.createDirectory(url.deletingLastPathComponent())
            let size = (try FileManager.default.attributesOfItem(atPath: temporary.path)[.size] as? NSNumber)?.int64Value ?? 0
            guard size > 0 else { return nil }
            // Replaced in one step: a reader never sees a half-moved file.
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
            } else {
                try FileManager.default.moveItem(at: temporary, to: url)
            }
            FileProtection.apply(file: url)
            knownBytes = knownBytes.map { $0 + size }
        } catch {
            StoreLog.write("downloaded attachment not kept: \(Self.reason(error))")
            return nil
        }
        trimIfNeeded()
        return url
    }

    /// Drops one file — a copy that turned out not to decode.
    func remove(id: String, fileExtension: String?, scope: LocalStore.Scope) {
        let url = location(id: id, fileExtension: fileExtension, scope: scope)
        guard pinned[url.path] == nil else { return }
        try? FileManager.default.removeItem(at: url)
        knownBytes = nil
    }

    // MARK: - In use

    func pin(_ url: URL) {
        pinned[url.path, default: 0] += 1
    }

    func unpin(_ url: URL) {
        guard let count = pinned[url.path] else { return }
        pinned[url.path] = count > 1 ? count - 1 : nil
    }

    func isPinned(_ url: URL) -> Bool { pinned[url.path] != nil }

    // MARK: - Size

    func size() -> Int64 {
        let measured = FileSize.ofDirectory(root)
        knownBytes = measured
        return measured
    }

    var currentLimit: Int64 { limit }

    func setLimit(_ bytes: Int64) {
        limit = bytes
        trimIfNeeded()
    }

    private func trimIfNeeded() {
        let bytes = knownBytes ?? size()
        if bytes > limit { trim() }
    }

    /// Down to `attachmentDiskTrimRatio` of the limit, the files read longest
    /// ago first. Never a pinned file.
    func trim(toBytes target: Int64? = nil) {
        let goal = target ?? Int64(Double(limit) * CachePolicy.attachmentDiskTrimRatio)
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys) else { return }
        var files: [(url: URL, size: Int64, used: Date)] = []
        var total: Int64 = 0
        for case let file as URL in e {
            guard let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
            let size = Int64(values.fileSize ?? 0)
            total += size
            files.append((file, size, values.contentModificationDate ?? .distantPast))
        }
        knownBytes = total
        guard total > goal else { return }
        for file in files.sorted(by: { $0.used < $1.used }) {
            if total <= goal { break }
            if pinned[file.url.path] != nil { continue }
            if (try? FileManager.default.removeItem(at: file.url)) != nil {
                total -= file.size
            }
        }
        knownBytes = total
    }

    /// Clear Cache: every file of every account, except any open right now.
    func removeAll() {
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { return }
        for case let file as URL in e {
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            if pinned[file.path] != nil { continue }
            try? FileManager.default.removeItem(at: file)
        }
        knownBytes = nil
    }

    /// An account signed out on purpose: its files leave the phone.
    func removeUser(_ userID: String) {
        let folder = root.appendingPathComponent("u-" + LocalStore.hashedName(userID), isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
        knownBytes = nil
    }

    // MARK: - Helpers

    /// The file's date is its last use: what a trim sorts by. Written at
    /// most once an hour per file, so reading a thread is not a stream of
    /// metadata writes.
    private func stampAsUsed(_ url: URL, lastStamp: Date?) {
        if let lastStamp, Date().timeIntervalSince(lastStamp) < Self.stampGranularity { return }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
    }

    private static let stampGranularity: TimeInterval = 3600

    private static func reason(_ error: Error) -> String {
        let ns = error as NSError
        return "\(ns.domain) \(ns.code)"
    }

    static func freeBytes(near url: URL) -> Int64? {
        #if os(iOS)
        let probe = url.deletingLastPathComponent()
        let values = try? probe.resourceValues(forKeys: [.volumeAvailableCapacityForOpportunisticUsageKey])
        return values?.volumeAvailableCapacityForOpportunisticUsage
        #else
        return nil
        #endif
    }
}

extension FileProtection {
    /// A file moved into the cache from somewhere else keeps the protection
    /// it was created with; this puts it in the cache's class.
    static func apply(file url: URL) {
        #if os(iOS)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path
        )
        #endif
    }
}
