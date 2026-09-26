import Foundation

/// The workspaces an operator belongs to and the one they were last in,
/// kept beside their saved messages.
///
/// So a launch with no connection opens on the inbox they were looking at —
/// from the copy on this phone — rather than on an empty screen with no
/// workspace to show anything for. Names and logo links only: nothing about
/// a customer, and nothing that authenticates anybody. It lives in the
/// account's own cache folder, so it leaves the phone with the rest of it.
struct AccountSnapshot: Codable, Sendable, Equatable {
    var workspaces: [Workspace]
    var selectedWorkspaceID: String?

    private static func file(for userID: String, root: URL?) -> URL {
        LocalStore.folder(forUser: userID, root: root).appendingPathComponent("account.json")
    }

    static func read(userID: String, root: URL? = nil) -> AccountSnapshot? {
        guard let data = try? Data(contentsOf: file(for: userID, root: root)) else { return nil }
        return try? JSONDecoder().decode(AccountSnapshot.self, from: data)
    }

    static func write(_ snapshot: AccountSnapshot, userID: String, root: URL? = nil) {
        let url = file(for: userID, root: root)
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        do {
            try LocalStore.prepareFolder(url.deletingLastPathComponent(), root: root ?? LocalStore.defaultRoot)
            try data.write(to: url, options: FileProtection.writingOptions)
        } catch {
            StoreLog.write("account snapshot not kept")
        }
    }
}

/// Device and location behind conversations, kept in memory for a while.
///
/// Decoration, and it changes rarely, so it is never written to disk: it is
/// asked for once per page of conversations and reused by the thread that
/// opens from that page, instead of the thread asking again.
@MainActor
final class VisitorIntelCache {
    static let shared = VisitorIntelCache()

    private var entries: [String: (profile: VisitorProfile, at: Date)] = [:]
    private var workspaceID: String?

    /// A new workspace (or account) starts empty.
    func use(workspaceID: String?) {
        guard workspaceID != self.workspaceID else { return }
        self.workspaceID = workspaceID
        entries = [:]
    }

    func profile(for conversationID: String, now: Date = Date()) -> VisitorProfile? {
        guard let entry = entries[conversationID], now.timeIntervalSince(entry.at) < CachePolicy.visitorIntelTTL else { return nil }
        return entry.profile
    }

    /// Which of these still need asking for.
    func missing(_ ids: [String], now: Date = Date()) -> [String] {
        ids.filter { profile(for: $0, now: now) == nil }
    }

    func store(_ profiles: [String: VisitorProfile], workspaceID: String, now: Date = Date()) {
        guard workspaceID == self.workspaceID else { return }
        for (id, profile) in profiles { entries[id] = (profile, now) }
    }

    func clear() {
        entries = [:]
    }
}
