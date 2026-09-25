import Foundation

/// Attachment bytes: memory, then this phone's disk, then the server.
///
/// Media cannot be loaded by `AsyncImage` or handed straight to `AVPlayer`:
/// the stream endpoint authorizes on the operator's bearer token and neither
/// of those can carry a header. So every file is fetched by hand, and it is
/// fetched once — kept in memory while it is being looked at, and on disk
/// (`AttachmentDiskCache`) for next time, relaunches included.
///
/// - Memory is an `NSCache` with a byte budget, because it gives the bytes
///   back when the system is short of memory, which is not a moment this app
///   could pick better itself.
/// - One request per file, however many views ask at once.
/// - Nothing is fetched until a view asks: a photo when its bubble is drawn,
///   a voice note when Play is tapped, a video or a document when it is
///   opened.
/// - Everything is scoped to the signed-in account and workspace. Changing
///   either forgets the memory copies; a download that finishes after the
///   scope moved on is handed to whoever asked and kept nowhere.
actor AttachmentStore {
    static let shared = AttachmentStore()

    private let cache = NSCache<NSString, NSData>()
    private var inFlight: [String: Task<Data, Error>] = [:]
    private var fileInFlight: [String: Task<URL, Error>] = [:]
    private var scope: LocalStore.Scope?
    private let disk: AttachmentDiskCache
    /// Reads that actually went to the server, for tests.
    private(set) var networkFetches = 0

    init(disk: AttachmentDiskCache = .shared, memoryLimit: Int = CachePolicy.attachmentMemoryBytes) {
        self.disk = disk
        cache.totalCostLimit = memoryLimit
    }

    // MARK: - Scope

    /// The account and workspace whose files are being shown. Called by
    /// `SyncCoordinator` on sign-in, sign-out and every workspace switch.
    func setScope(_ new: LocalStore.Scope?) {
        guard new != scope else { return }
        scope = new
        clearMemory()
    }

    func clearMemory() {
        cache.removeAllObjects()
        inFlight = [:]
        fileInFlight = [:]
    }

    private func key(_ id: String, in scope: LocalStore.Scope?) -> String {
        "\(scope?.userID ?? "-")|\(scope?.workspaceID ?? "-")|\(id)"
    }

    // MARK: - Bytes (photos, small files)

    /// The whole file in memory — for a photo, which has to be decoded anyway.
    func data(for attachment: MessageAttachment, api: any WebyarAPI) async throws -> Data {
        let scope = self.scope
        let key = key(attachment.id, in: scope)
        if let hit = cache.object(forKey: key as NSString) { return hit as Data }
        if let running = inFlight[key] { return try await running.value }

        let ext = AttachmentFormat.fileExtension(for: attachment)
        let task = Task<Data, Error> { [disk] in
            if let scope, let saved = await disk.data(id: attachment.id, fileExtension: ext, scope: scope) {
                return saved
            }
            try Task.checkCancellation()
            self.countNetworkFetch()
            let data = try await api.attachmentData(id: attachment.id)
            // Kept only if the account and workspace are still the ones it was fetched for.
            if let scope, self.scope == scope {
                await disk.store(data, id: attachment.id, fileExtension: ext, scope: scope)
            }
            return data
        }
        inFlight[key] = task
        defer { if inFlight[key] == task { inFlight[key] = nil } }

        let data = try await task.value
        if self.scope == scope {
            cache.setObject(data as NSData, forKey: key as NSString, cost: data.count)
        }
        return data
    }

    // MARK: - Files (voice notes, video, documents)

    /// The file on this phone's disk, downloading it first if it is not
    /// there. Large files go straight to disk and never into memory.
    func fileURL(for attachment: MessageAttachment, api: any WebyarAPI) async throws -> URL {
        let scope = self.scope
        let ext = AttachmentFormat.fileExtension(for: attachment)
        guard let scope else {
            // No account to keep it under (not expected while signed in): a
            // temporary copy for this one use.
            return try await api.attachmentFile(id: attachment.id)
        }
        if let hit = await disk.existing(id: attachment.id, fileExtension: ext, scope: scope) { return hit }
        let key = key(attachment.id, in: scope)
        if let running = fileInFlight[key] { return try await running.value }

        let task = Task<URL, Error> { [disk] in
            self.countNetworkFetch()
            // Bytes already in memory (a photo opened full screen) are not fetched twice.
            let temporary: URL
            if let inMemory = self.memoryHit(key) {
                temporary = FileManager.default.temporaryDirectory.appendingPathComponent("webyar-\(UUID().uuidString)")
                try inMemory.write(to: temporary, options: .atomic)
            } else {
                temporary = try await api.attachmentFile(id: attachment.id)
            }
            if self.scope == scope,
               let kept = await disk.adopt(temporary, id: attachment.id, fileExtension: ext, scope: scope) {
                return kept
            }
            // Not kept (the disk is full, or the scope moved on): a file of
            // its own in the temporary directory, for this one use.
            let loose = FileManager.default.temporaryDirectory
                .appendingPathComponent("webyar-\(UUID().uuidString)")
                .appendingPathExtension(AttachmentDiskCache.sanitizedExtension(ext))
            if FileManager.default.fileExists(atPath: temporary.path) {
                try FileManager.default.moveItem(at: temporary, to: loose)
                return loose
            }
            return try await api.attachmentFile(id: attachment.id)
        }
        fileInFlight[key] = task
        defer { if fileInFlight[key] == task { fileInFlight[key] = nil } }
        return try await task.value
    }

    /// The file if it is already on this phone — never the network. A voice
    /// note uses this to show its length before anyone taps Play.
    func cachedFileURL(for attachment: MessageAttachment) async -> URL? {
        guard let scope else { return nil }
        return await disk.existing(id: attachment.id, fileExtension: AttachmentFormat.fileExtension(for: attachment), scope: scope)
    }

    /// A copy that turned out not to decode: dropped from memory and disk,
    /// so the next ask fetches it again.
    func discard(_ attachment: MessageAttachment) async {
        cache.removeObject(forKey: key(attachment.id, in: scope) as NSString)
        guard let scope else { return }
        await disk.remove(id: attachment.id, fileExtension: AttachmentFormat.fileExtension(for: attachment), scope: scope)
    }

    private func memoryHit(_ key: String) -> Data? {
        cache.object(forKey: key as NSString) as Data?
    }

    private func countNetworkFetch() {
        networkFetches += 1
    }
}

/// Maps a MIME type onto a file extension, which is the only thing `AVPlayer`
/// and Quick Look use to decide how to open a file on disk.
enum AttachmentFormat {
    static func fileExtension(for attachment: MessageAttachment) -> String? {
        // The name is checked before the MIME type because it is the more
        // specific of the two — but only when it really carries an extension.
        // A widget voice note arrives named `m4a`, with no dot in it at all.
        // Whatever it is, `AttachmentDiskCache` reduces it to letters and
        // digits before it touches a path.
        if let name = attachment.fileName,
           let dot = name.lastIndex(of: "."),
           dot < name.index(before: name.endIndex) {
            let ext = String(name[name.index(after: dot)...])
            if !ext.isEmpty, ext.count <= 8 { return ext }
        }
        switch attachment.mimeType {
        case "video/mp4", "video/quicktime": return "mp4"
        case "video/webm": return "webm"
        case "audio/mp4", "audio/m4a", "audio/x-m4a": return "m4a"
        case "audio/mpeg": return "mp3"
        case "audio/ogg": return "ogg"
        case "image/jpeg": return "jpg"
        case "image/png": return "png"
        case "image/heic": return "heic"
        case "image/webp": return "webp"
        case "image/gif": return "gif"
        case "application/pdf": return "pdf"
        default: return nil
        }
    }
}
