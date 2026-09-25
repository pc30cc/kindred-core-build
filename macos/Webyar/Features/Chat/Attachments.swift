import AppKit
import Foundation

/// A file on a message, as the thread draws it.
struct AttachmentInfo: Identifiable, Hashable, Sendable {
    var id: String
    var mimeType: String
    var kind: String
    var fileName: String
    var sizeText: String

    var isImage: Bool { kind == "image" }
    var isAudio: Bool { kind == "audio" }

    var systemImage: String {
        switch kind {
        case "audio": return "waveform"
        case "video": return "film"
        case "image": return "photo"
        default: return "doc.text"
        }
    }

    init(_ a: MessageAttachment, _ s: Strings) {
        id = a.id
        mimeType = a.mimeType ?? ""
        if let k = a.kind, ["image", "audio", "video", "file"].contains(k) { kind = k }
        else if mimeType.hasPrefix("image/") { kind = "image" }
        else if mimeType.hasPrefix("audio/") { kind = "audio" }
        else if mimeType.hasPrefix("video/") { kind = "video" }
        else { kind = "file" }
        // Some channels send a bare extension as the name; that tells nobody anything.
        let name = (a.fileName ?? "").trimmingCharacters(in: .whitespaces)
        if name.contains("."), name.count > 4 { fileName = name }
        else {
            switch kind {
            case "image": fileName = s["photo"]
            case "audio": fileName = s["voiceNote"]
            case "video": fileName = s["videoFile"]
            default: fileName = s["file"]
            }
        }
        sizeText = a.sizeBytes.map { Display.fileSize($0, s) } ?? ""
    }

    /// A file the operator picked and is sending now.
    @MainActor static func local(name: String, mime: String, data: Data, _ s: Strings) -> AttachmentInfo {
        let id = "local:" + UUID().uuidString
        AttachmentStore.shared.remember(id, data)
        return AttachmentInfo(MessageAttachment(id: id, fileName: name, mimeType: mime, sizeBytes: Int64(data.count)), s)
    }
}

/// Attachment bytes: memory first, then the disk cache, then the server.
/// Photos keep their decoded preview so a poll never flashes them empty.
@MainActor
final class AttachmentStore {
    static let shared = AttachmentStore()

    // Bounded: the disk cache keeps everything; memory only what is being looked at.
    private let byteCache: NSCache<NSString, NSData> = {
        let c = NSCache<NSString, NSData>()
        c.totalCostLimit = 150 * 1024 * 1024
        return c
    }()
    private let imageCache: NSCache<NSString, NSImage> = {
        let c = NSCache<NSString, NSImage>()
        c.countLimit = 300
        return c
    }()
    private var inflight: [String: Task<Data, Error>] = [:]
    weak var api: WebyarAPI?

    // Files not sent yet ("local:…") are nowhere else — not on disk, not on the server — so they are
    // held outright, never evicted.
    private var localBytes: [String: Data] = [:]
    private var localImages: [String: NSImage] = [:]

    private func getBytes(_ id: String) -> Data? { localBytes[id] ?? byteCache.object(forKey: id as NSString) as Data? }
    private func setBytes(_ id: String, _ d: Data) {
        if id.hasPrefix("local:") { localBytes[id] = d } else { byteCache.setObject(d as NSData, forKey: id as NSString, cost: d.count) }
    }
    private func getImage(_ id: String) -> NSImage? { localImages[id] ?? imageCache.object(forKey: id as NSString) }
    private func setImage(_ id: String, _ i: NSImage) {
        if id.hasPrefix("local:") { localImages[id] = i } else { imageCache.setObject(i, forKey: id as NSString) }
    }

    func remember(_ id: String, _ data: Data) { setBytes(id, data) }

    func cachedImage(_ id: String) -> NSImage? { getImage(id) }

    func data(_ id: String) async throws -> Data {
        if let d = getBytes(id) { return d }
        if let t = inflight[id] { return try await t.value }
        let task = Task<Data, Error> { [weak self] in
            if let d = FileCache.read(id) { return d }
            guard let api = self?.api else { throw ApiError(failure: .transport) }
            let d = try await api.attachmentData(id)
            FileCache.write(id, d)
            return d
        }
        inflight[id] = task
        defer { inflight[id] = nil }
        let d = try await task.value
        setBytes(id, d)
        return d
    }

    func image(_ id: String) async -> NSImage? {
        if let i = getImage(id) { return i }
        guard let d = try? await data(id), let i = NSImage(data: d) else { return nil }
        setImage(id, i)
        return i
    }

    /// A file the operator just sent now has its server id: the bytes and the
    /// decoded photo carry over, so the confirmed message does not reload it.
    func alias(_ local: String, _ server: String) {
        if let d = getBytes(local) {
            setBytes(server, d)
            FileCache.write(server, d)
        }
        if let i = getImage(local) { setImage(server, i) }
    }

    /// Forgets the in-memory copies too, after the disk cache is cleared.
    func clearMemory() {
        byteCache.removeAllObjects()
        imageCache.removeAllObjects()
    }

    /// Opens a file with whatever the Mac opens that kind of file with.
    func open(_ a: AttachmentInfo) async throws {
        let data = try await data(a.id)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Webyar/" + a.id.replacingOccurrences(of: ":", with: "_"), isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var name = a.fileName.components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "_")
        if (name as NSString).pathExtension.isEmpty { name += Mime.ext(a.mimeType) }
        let url = dir.appendingPathComponent(name)
        try data.write(to: url)
        NSWorkspace.shared.open(url)
    }

    /// Saves a copy where the operator chooses.
    func save(_ a: AttachmentInfo) async {
        guard let data = try? await data(a.id) else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = a.fileName
        if panel.runModal() == .OK, let url = panel.url { try? data.write(to: url) }
    }
}
