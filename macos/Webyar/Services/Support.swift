import AppKit
import AVFoundation
import CryptoKit
import Foundation
import Security

/// A line per event in ~/Library/Logs/Webyar/webyar.log, trimmed when it grows.
enum Log {
    private static let queue = DispatchQueue(label: "webyar.log")

    static var folder: URL {
        let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        let dir = base.appendingPathComponent("Logs/Webyar", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var file: URL { folder.appendingPathComponent("webyar.log") }

    static func write(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let text = "\(stamp) \(line)\n"
        #if DEBUG
        print(text, terminator: "")
        #endif
        queue.async {
            let url = file
            if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
               let size = attrs[.size] as? Int, size > 2_000_000 {
                try? FileManager.default.removeItem(at: url)
            }
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(Data(text.utf8))
                try? handle.close()
            } else {
                try? Data(text.utf8).write(to: url)
            }
        }
    }

    static func error(_ what: String, _ error: Error) {
        write("[error] \(what): \(error)")
    }
}

/// A generic-password item in the login Keychain.
enum Keychain {
    private static let service = "ai.webyar.mac"

    static func read(_ account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func write(_ account: String, _ data: Data?) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard let data else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess { Log.write("[keychain] write \(account) failed \(status)") }
    }
}

/// The Bearer session token, in the Keychain for this Mac user.
final class KeychainSessionStore: SessionStore {
    private var cached: String??

    func read() -> String? {
        if let cached { return cached }
        let value = Keychain.read("session").flatMap { String(data: $0, encoding: .utf8) }
        cached = .some(value)
        return value
    }

    func write(_ token: String?) {
        cached = .some(token)
        Keychain.write("session", token.map { Data($0.utf8) })
    }
}

/// "Remember me" on the sign-in page: the email and password in the Keychain,
/// so they fill in by themselves after a sign-out. Nothing leaves the Mac.
enum SavedLogin {
    struct Credentials: Codable { var email: String; var password: String }

    static func read() -> Credentials? {
        Keychain.read("login").flatMap { try? JSONDecoder().decode(Credentials.self, from: $0) }
    }

    static func write(email: String, password: String) {
        Keychain.write("login", try? JSONEncoder().encode(Credentials(email: email, password: password)))
    }

    static func forget() { Keychain.write("login", nil) }
}

/// Runs a piece of work now and then again after an interval, on the main
/// actor. `kick()` runs it at once, e.g. when a realtime event says something
/// changed; a kick that lands mid-run makes it run once more straight after,
/// so no change is missed. Transport failures are quiet: the next tick retries.
@MainActor
final class Poller {
    private let name: String
    private let interval: () -> TimeInterval
    private let work: () async throws -> Void
    private var task: Task<Void, Never>?
    private var sleeper: Task<Void, Error>?
    private var kicked = false

    init(_ name: String, interval: @escaping () -> TimeInterval, work: @escaping () async throws -> Void) {
        self.name = name
        self.interval = interval
        self.work = work
    }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.loop() }
    }

    func kick() {
        kicked = true
        sleeper?.cancel()
    }

    func stop() {
        task?.cancel()
        sleeper?.cancel()
        task = nil
    }

    private func loop() async {
        while !Task.isCancelled {
            kicked = false
            do {
                try await work()
            } catch is CancellationError {
                if Task.isCancelled { return }
            } catch let e as ApiError where e.failure == .transport {
                // Offline: the next tick tries again; nothing to log every few seconds.
            } catch {
                Log.error("poll \(name)", error)
            }
            if Task.isCancelled { return }
            if !kicked {
                let seconds = max(0.5, interval())
                let s = Task { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
                sleeper = s
                _ = try? await s.value
                sleeper = nil
            }
        }
    }
}

/// A list of subscribers to one kind of event; each subscription ends when its token is released.
@MainActor
final class Signal<Value> {
    final class Token {
        fileprivate var cancel: (() -> Void)?
        deinit { let c = cancel; Task { @MainActor in c?() } }
        func cancelNow() { cancel?(); cancel = nil }
    }

    private var handlers: [UUID: (Value) -> Void] = [:]

    func subscribe(_ handler: @escaping (Value) -> Void) -> Token {
        let id = UUID()
        handlers[id] = handler
        let token = Token()
        token.cancel = { [weak self] in self?.handlers[id] = nil }
        return token
    }

    func send(_ value: Value) {
        for h in handlers.values { h(value) }
    }
}

/// The web desk's new-call chime, rebuilt sample for sample: two sine tones,
/// 880 Hz then 1175 Hz 0.18 s later, each ~0.32 s, peaking at 0.15 gain.
@MainActor
enum Chime {
    private static var player: AVAudioPlayerBox?

    static func play() {
        player = AVAudioPlayerBox(data: wav)
        player?.play()
    }

    private static let wav: Data = {
        let rate = 44100
        let total = Int(Double(rate) * 0.55)
        var samples = [Double](repeating: 0, count: total)
        func tone(_ hz: Double, _ start: Double, _ length: Double) {
            let from = Int(start * Double(rate)), n = Int(length * Double(rate))
            for i in 0..<n where from + i < total {
                let t = Double(i) / Double(rate)
                samples[from + i] += sin(2 * .pi * hz * t) * 0.15 * min(1, t / 0.02) * exp(-t * 9)
            }
        }
        tone(880, 0, 0.32)
        tone(1175, 0.18, 0.32)
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + total * 2)); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(UInt32(total * 2))
        for s in samples { u16(UInt16(bitPattern: Int16(max(-32768, min(32767, s * 32767))))) }
        return d
    }()
}

final class AVAudioPlayerBox {
    private let player: AVAudioPlayer?
    init(data: Data) { player = try? AVAudioPlayer(data: data) }
    func play() { player?.play() }
}

enum Mime {
    private static let types: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
        "heic": "image/heic", "pdf": "application/pdf", "txt": "text/plain", "csv": "text/csv", "zip": "application/zip",
        "doc": "application/msword", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls": "application/vnd.ms-excel", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt": "application/vnd.ms-powerpoint", "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp3": "audio/mpeg", "m4a": "audio/mp4", "ogg": "audio/ogg", "wav": "audio/wav", "webm": "video/webm",
        "mp4": "video/mp4", "mov": "video/quicktime",
    ]

    static func of(_ fileName: String) -> String {
        types[(fileName as NSString).pathExtension.lowercased()] ?? "application/octet-stream"
    }

    static func ext(_ mime: String) -> String {
        types.first(where: { $0.value.caseInsensitiveCompare(mime) == .orderedSame }).map { "." + $0.key } ?? ""
    }
}

/// Message files on disk, keyed by attachment id, so a photo, voice note or
/// document is downloaded once and opened from the Mac after that — across
/// conversations and restarts. The least recently used go first past
/// CachePolicy.fileCacheMaxBytes, at launch and every so often while the app runs.
/// Safe from any thread: every write is atomic, so a crash never leaves half a file.
enum FileCache {
    /// Tests point the cache at a folder of their own.
    nonisolated(unsafe) static var folderOverride: URL?

    static var folder: URL {
        let dir = folderOverride ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Files", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static let upkeep = DispatchQueue(label: "webyar.filecache", qos: .utility)

    // Ids are server UUIDs; anything else (a local "local:…" id) stays in memory only.
    private static func valid(_ id: String) -> Bool { UUID(uuidString: id) != nil }
    private static func path(_ id: String) -> URL { folder.appendingPathComponent(id.lowercased() + ".bin") }

    static func read(_ id: String) -> Data? {
        guard valid(id) else { return nil }
        return read(at: path(id))
    }

    static func write(_ id: String, _ data: Data) {
        guard valid(id), !data.isEmpty else { return }
        write(data, to: path(id))
    }

    static func remove(_ id: String) {
        guard valid(id) else { return }
        try? FileManager.default.removeItem(at: path(id))
    }

    // Files known by a link rather than an id (avatars, logos, campaign art): kept under a hash
    // of the whole link, so the provider's new links after a change are simply new entries.
    private static func path(key: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return folder.appendingPathComponent("k-" + digest + ".bin")
    }

    static func read(key: String) -> Data? { read(at: path(key: key)) }

    static func write(key: String, _ data: Data) {
        guard !data.isEmpty else { return }
        write(data, to: path(key: key))
    }

    static func remove(key: String) {
        try? FileManager.default.removeItem(at: path(key: key))
    }

    private static func read(at url: URL) -> Data? {
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return data
    }

    private static func write(_ data: Data, to url: URL) {
        do {
            try data.write(to: url, options: .atomic)
        } catch let e as CocoaError where e.code == .fileWriteOutOfSpace {
            // The Mac is full: keep what is in memory and make room for next time.
            Log.write("[files] disk full, not cached")
            trimInBackground()
        } catch {
            Log.write("[files] write failed")
        }
    }

    /// Total size and file count, for the settings page.
    static func measure() -> (bytes: Int64, count: Int) {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        let bytes = files.reduce(Int64(0)) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        return (bytes, files.count)
    }

    static func clear() {
        upkeep.sync {
            for f in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] {
                try? FileManager.default.removeItem(at: f)
            }
        }
    }

    /// `trim()` on a background queue, one at a time.
    static func trimInBackground() {
        upkeep.async { trim() }
    }

    /// Drops the least recently used files once the cache is over its limit.
    static func trim(maxBytes: Int64 = CachePolicy.fileCacheMaxBytes, trimTo: Int64 = CachePolicy.fileCacheTrimTo) {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
        var entries = files.map { url -> (URL, Int64, Date) in
            let v = try? url.resourceValues(forKeys: Set(keys))
            return (url, Int64(v?.fileSize ?? 0), v?.contentModificationDate ?? .distantPast)
        }
        var total = entries.reduce(Int64(0)) { $0 + $1.1 }
        guard total > maxBytes else { return }
        entries.sort { $0.2 < $1.2 }
        var removed = 0
        for (url, size, _) in entries {
            if total <= trimTo { break }
            try? FileManager.default.removeItem(at: url)
            total -= size
            removed += 1
        }
        Log.write("[files] trimmed \(removed) files")
    }
}

extension NSWorkspace {
    /// Opens an https link in the browser; anything else is ignored.
    @discardableResult
    func openHttps(_ string: String?) -> Bool {
        guard let string, let url = URL(string: string), url.scheme == "https" else { return false }
        return open(url)
    }
}
