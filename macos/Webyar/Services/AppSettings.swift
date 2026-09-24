import Foundation

enum Appearance: String, Codable, CaseIterable, Sendable {
    case system, light, dark
}

/// This Mac's preferences, kept in UserDefaults. The operator's account
/// settings live on the server.
struct AppSettings: Codable, Equatable {
    var language: String?
    var appearance: Appearance = .system
    var notifications = true
    var notificationSound = true
    /// Closing the window keeps the app running in the menu bar, so notifications still arrive.
    var closeToMenuBar = true
    /// Show the Webyar item in the menu bar (unread count, quick actions).
    var menuBarItem = true
    var apiOrigin: String?
    var workspaceId: String?
    /// Ads and announcements the operator closed with ✕.
    var dismissedCampaigns: [String] = []
    /// The last Super Admin broadcast shown, so a restart does not replay it.
    var lastBroadcastSeq: Int64?
    /// The details inspector beside a conversation.
    var detailsOpen = true
    /// Super Admin's first-launch defaults have been applied, or were never
    /// needed: false only on a Mac that had no saved settings when the app
    /// first ran, until the platform's answer arrives.
    var platformDefaultsApplied = false

    var resolvedLanguage: Language { Language.parse(language) ?? Language.system }

    private static let key = "settings.v1"

    static func load() -> AppSettings {
        guard let data = UserDefaults.standard.data(forKey: key) else { return AppSettings() }
        do {
            return try JSONDecoder().decode(AppSettings.self, from: data)
        } catch {
            Log.error("load settings", error)
            // Something was saved, so this is not a first launch.
            var settings = AppSettings()
            settings.platformDefaultsApplied = true
            return settings
        }
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppSettings()
        language = try? c.decodeIfPresent(String.self, forKey: .language)
        appearance = (try? c.decodeIfPresent(Appearance.self, forKey: .appearance)) ?? d.appearance
        notifications = (try? c.decodeIfPresent(Bool.self, forKey: .notifications)) ?? d.notifications
        notificationSound = (try? c.decodeIfPresent(Bool.self, forKey: .notificationSound)) ?? d.notificationSound
        closeToMenuBar = (try? c.decodeIfPresent(Bool.self, forKey: .closeToMenuBar)) ?? d.closeToMenuBar
        menuBarItem = (try? c.decodeIfPresent(Bool.self, forKey: .menuBarItem)) ?? d.menuBarItem
        apiOrigin = try? c.decodeIfPresent(String.self, forKey: .apiOrigin)
        workspaceId = try? c.decodeIfPresent(String.self, forKey: .workspaceId)
        dismissedCampaigns = (try? c.decodeIfPresent([String].self, forKey: .dismissedCampaigns)) ?? []
        lastBroadcastSeq = try? c.decodeIfPresent(Int64.self, forKey: .lastBroadcastSeq)
        detailsOpen = (try? c.decodeIfPresent(Bool.self, forKey: .detailsOpen)) ?? true
        // Settings saved before the flag existed are an operator's own choices: never overwritten.
        platformDefaultsApplied = (try? c.decodeIfPresent(Bool.self, forKey: .platformDefaultsApplied)) ?? true
    }
}
