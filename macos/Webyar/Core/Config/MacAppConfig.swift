import Foundation

/// Super Admin → macOS app, as served by `GET /api/platform/macos-app`
/// (server/services/desktopApp/macosSettings.ts): where Sparkle looks for
/// updates and which builds may still run, realtime and polling, what the
/// app may do on the Mac, the defaults of a first launch, a maintenance
/// notice and the help links. What the app offers is not here: the
/// workspace's plan decides that (WorkspacePlan). Read on launch and
/// hourly — every minute while maintenance is on — so a change reaches every
/// installed copy without a release.
struct MacAppConfig: Sendable, Equatable {
    var update: UpdateSettings
    var realtimeEnabled: Bool
    var pollIntervalSeconds: Int
    var pollWithRealtimeSeconds: Int
    var system: SystemIntegration
    var firstLaunch: FirstLaunch
    var maintenance: Maintenance
    var links: Links

    /// What the app may do on the Mac itself.
    struct SystemIntegration: Sendable, Equatable {
        var menuBarExtra = true
        var launchAtLogin = true
        var dockBadge = true
        var notifications = true
    }

    /// Applied once, on a Mac that has no saved settings yet.
    struct FirstLaunch: Sendable, Equatable {
        /// nil follows the Mac's own language.
        var language: Language?
        var appearance: Appearance = .system
        var closeToMenuBar = true
        var launchAtLogin = false
    }

    struct Maintenance: Sendable, Equatable {
        var enabled = false
        /// By language code: fa, en, tr.
        var message: [String: String] = [:]
        var until: Date?

        /// The notice in the UI's language, else Persian, English, Turkish; nil when there is none.
        func message(in language: Language) -> String? {
            for code in [language.code, "fa", "en", "tr"] {
                if let m = message[code] { return m }
            }
            return nil
        }
    }

    /// Help menu and Settings → Help & legal; each https or absent.
    struct Links: Sendable, Equatable {
        var support: String?
        var status: String?
        var privacy: String?
        var terms: String?

        var isEmpty: Bool { [support, status, privacy, terms].allSatisfy { $0 == nil } }
    }

    /// The server's own defaults: what the app did before the platform had a say.
    static let defaults = MacAppConfig(
        update: UpdateSettings(appcastUrl: nil, channel: "stable", latestVersion: nil, minimumSupportedVersion: nil, blockedVersions: [],
                               downloadUrl: nil, releaseNotes: nil, autoCheck: true, autoDownload: true, checkIntervalMinutes: 240),
        realtimeEnabled: true,
        pollIntervalSeconds: 15,
        pollWithRealtimeSeconds: 120,
        system: SystemIntegration(),
        firstLaunch: FirstLaunch(),
        maintenance: Maintenance(),
        links: Links())

    /// Reads whatever the server sent defensively: a missing or unusable
    /// field falls back on its own, never the whole answer.
    static func parse(_ root: JSONValue, now: Date = Date()) -> MacAppConfig {
        let d = defaults
        let update = root["update"], realtime = root["realtime"], polling = root["polling"]
        let system = root["system"], first = root["defaults"], maintenance = root["maintenance"], links = root["links"]
        func clamp(_ v: Int?, _ lo: Int, _ hi: Int, _ fallback: Int) -> Int { v.map { min(hi, max(lo, $0)) } ?? fallback }
        func https(_ v: String?) -> String? {
            guard let v, let u = URL(string: v), u.scheme?.lowercased() == "https", u.host?.isEmpty == false else { return nil }
            return v
        }
        func flag(_ group: JSONValue?, _ key: String, _ fallback: Bool) -> Bool { group?[key]?.bool ?? fallback }

        let s = d.system
        let parsedSystem = SystemIntegration(
            menuBarExtra: flag(system, "menuBarExtra", s.menuBarExtra),
            launchAtLogin: flag(system, "launchAtLogin", s.launchAtLogin),
            dockBadge: flag(system, "dockBadge", s.dockBadge),
            notifications: flag(system, "notifications", s.notifications))

        let fl = d.firstLaunch
        let parsedFirst = FirstLaunch(
            language: Language.parse(first?["language"]?.text),
            appearance: first?["appearance"]?.text.flatMap(Appearance.init(rawValue:)) ?? fl.appearance,
            // Closing to the menu bar needs the menu bar item; opening at login needs permission to.
            closeToMenuBar: parsedSystem.menuBarExtra && flag(first, "closeToMenuBar", fl.closeToMenuBar),
            launchAtLogin: parsedSystem.launchAtLogin && flag(first, "launchAtLogin", fl.launchAtLogin))

        var message: [String: String] = [:]
        for code in ["fa", "en", "tr"] {
            if let m = maintenance?["message"]?[code]?.text { message[code] = m }
        }
        let until = maintenance?["until"]?.text.flatMap(JSON.parseDate)
        // A notice whose end time has passed is over, even if nobody switched it off.
        let down = flag(maintenance, "enabled", false) && !(until.map { $0 <= now } ?? false)

        let blocked = (update?["blockedVersions"]?.array ?? []).compactMap(\.text)
        var seen = Set<String>()
        return MacAppConfig(
            update: UpdateSettings(
                appcastUrl: https(update?["appcastUrl"]?.text),
                channel: update?["channel"]?.text == "beta" ? "beta" : "stable",
                latestVersion: update?["latestVersion"]?.text,
                minimumSupportedVersion: update?["minimumSupportedVersion"]?.text,
                blockedVersions: Array(blocked.filter { seen.insert($0).inserted }.prefix(50)),
                downloadUrl: https(update?["downloadUrl"]?.text),
                releaseNotes: update?["releaseNotes"]?.text,
                autoCheck: flag(update, "autoCheck", d.update.autoCheck),
                autoDownload: flag(update, "autoDownload", d.update.autoDownload),
                checkIntervalMinutes: clamp(update?["checkIntervalMinutes"]?.int, 15, 1440, d.update.checkIntervalMinutes)),
            realtimeEnabled: flag(realtime, "enabled", d.realtimeEnabled),
            pollIntervalSeconds: clamp(polling?["intervalSeconds"]?.int, 5, 300, d.pollIntervalSeconds),
            pollWithRealtimeSeconds: clamp(polling?["withRealtimeSeconds"]?.int, 15, 900, d.pollWithRealtimeSeconds),
            system: parsedSystem,
            firstLaunch: parsedFirst,
            maintenance: Maintenance(enabled: down, message: message, until: until),
            links: Links(support: https(links?["support"]?.text), status: https(links?["status"]?.text),
                         privacy: https(links?["privacy"]?.text), terms: https(links?["terms"]?.text)))
    }

    /// The platform's answer, or nil when it could not be asked (offline, or a
    /// server that predates the endpoint). The raw JSON comes too, to keep.
    @MainActor
    static func fetch(_ client: ApiClient) async -> (config: MacAppConfig, raw: JSONValue)? {
        guard let root: JSONValue = try? await client.get("/api/platform/macos-app"), root.object != nil else { return nil }
        return (parse(root), root)
    }

    // MARK: Last answer

    private static let cacheKey = "platform.macos-app.v1"

    /// The last answer this Mac got, so the platform's switches hold from the
    /// first frame of a launch rather than a moment after it.
    static func cached() -> MacAppConfig? {
        guard let data = UserDefaults.standard.data(forKey: cacheKey),
              let root = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        return parse(root)
    }

    static func remember(_ raw: JSONValue) {
        if let data = try? JSONEncoder().encode(raw) { UserDefaults.standard.set(data, forKey: cacheKey) }
    }
}

struct UpdateSettings: Sendable, Equatable {
    /// Why this build may not keep running.
    enum Requirement: Sendable, Equatable { case none, belowMinimum, blocked }

    /// The Sparkle appcast, from Super Admin. The updater takes it only from a live answer.
    var appcastUrl: String?
    /// "stable" or "beta".
    var channel: String
    var latestVersion: String?
    var minimumSupportedVersion: String?
    /// Builds withdrawn outright, whatever the minimum says.
    var blockedVersions: [String]
    var downloadUrl: String?
    var releaseNotes: String?
    var autoCheck: Bool
    var autoDownload: Bool
    var checkIntervalMinutes: Int

    /// True when `current` is older than the minimum the platform still supports.
    func isBelowMinimum(_ current: String) -> Bool {
        guard let min = SemVer(minimumSupportedVersion), let cur = SemVer(current) else { return false }
        return cur < min
    }

    /// A blocked build must update even when it is above the minimum.
    func requirement(for current: String) -> Requirement {
        let bare = Self.bare(current)
        if blockedVersions.contains(where: { Self.bare($0) == bare }) { return .blocked }
        return isBelowMinimum(current) ? .belowMinimum : .none
    }

    private static func bare(_ v: String) -> String {
        var t = v.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("v") || t.hasPrefix("V") { t.removeFirst() }
        return t
    }
}

/// Just enough semver for "is this build too old": major.minor.patch, pre-release ignored.
struct SemVer: Comparable, Sendable {
    let major: Int, minor: Int, patch: Int

    init?(_ text: String?) {
        guard var t = text?.trimmingCharacters(in: .whitespaces), !t.isEmpty else { return nil }
        if t.hasPrefix("v") || t.hasPrefix("V") { t.removeFirst() }
        let core = t.split(whereSeparator: { $0 == "-" || $0 == "+" }).first.map(String.init) ?? t
        let parts = core.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count) else { return nil }
        var nums = [0, 0, 0]
        for (i, p) in parts.enumerated() {
            guard !p.isEmpty, p.allSatisfy(\.isNumber), let n = Int(p) else { return nil }
            nums[i] = n
        }
        major = nums[0]; minor = nums[1]; patch = nums[2]
    }

    static func < (a: SemVer, b: SemVer) -> Bool {
        (a.major, a.minor, a.patch) < (b.major, b.minor, b.patch)
    }
}
