import Foundation

/// Super Admin → Desktop app, as served by `GET /api/platform/desktop-app`:
/// how hard to poll, whether realtime and calls are on, and which build is
/// the oldest still supported. Read on launch and hourly, so a change reaches
/// every installed copy without a release — the same row the Windows app reads.
struct DesktopConfig: Sendable, Equatable {
    var update: UpdateSettings
    var realtimeEnabled: Bool
    var pollIntervalSeconds: Int
    var pollWithRealtimeSeconds: Int
    var callsEnabled: Bool

    static let defaults = DesktopConfig(
        update: UpdateSettings(feedUrl: nil, channel: "stable", latestVersion: nil, minimumSupportedVersion: nil,
                               downloadUrl: nil, releaseNotes: nil, autoUpdate: true, checkIntervalMinutes: 240),
        realtimeEnabled: true,
        pollIntervalSeconds: 15,
        pollWithRealtimeSeconds: 120,
        callsEnabled: true)

    /// Reads whatever the server sent defensively: a missing or out-of-range
    /// field falls back on its own, never the whole answer.
    static func parse(_ root: JSONValue) -> DesktopConfig {
        let d = defaults
        let update = root["update"], realtime = root["realtime"], polling = root["polling"], features = root["features"]
        func clamp(_ v: Int?, _ lo: Int, _ hi: Int, _ fallback: Int) -> Int { v.map { min(hi, max(lo, $0)) } ?? fallback }
        func https(_ v: String?) -> String? {
            guard let v, let u = URL(string: v), u.scheme == "https" else { return nil }
            return v.hasSuffix("/") ? String(v.dropLast()) : v
        }
        return DesktopConfig(
            update: UpdateSettings(
                feedUrl: https(update?["feedUrl"]?.text),
                channel: update?["channel"]?.text == "beta" ? "beta" : "stable",
                latestVersion: update?["latestVersion"]?.text,
                minimumSupportedVersion: update?["minimumSupportedVersion"]?.text,
                downloadUrl: https(update?["downloadUrl"]?.text),
                releaseNotes: update?["releaseNotes"]?.text,
                autoUpdate: update?["autoUpdate"]?.bool ?? d.update.autoUpdate,
                checkIntervalMinutes: clamp(update?["checkIntervalMinutes"]?.int, 15, 1440, d.update.checkIntervalMinutes)),
            realtimeEnabled: realtime?["enabled"]?.bool ?? d.realtimeEnabled,
            pollIntervalSeconds: clamp(polling?["intervalSeconds"]?.int, 5, 300, d.pollIntervalSeconds),
            pollWithRealtimeSeconds: clamp(polling?["withRealtimeSeconds"]?.int, 15, 900, d.pollWithRealtimeSeconds),
            callsEnabled: features?["calls"]?.bool ?? d.callsEnabled)
    }

    /// The platform's settings, or nil when it could not be asked.
    @MainActor
    static func fetch(_ client: ApiClient) async -> DesktopConfig? {
        guard let root: JSONValue = try? await client.get("/api/platform/desktop-app"), root.object != nil else { return nil }
        return parse(root)
    }
}

struct UpdateSettings: Sendable, Equatable {
    var feedUrl: String?
    var channel: String
    var latestVersion: String?
    var minimumSupportedVersion: String?
    var downloadUrl: String?
    var releaseNotes: String?
    var autoUpdate: Bool
    var checkIntervalMinutes: Int

    /// True when `current` is older than the minimum the platform still supports.
    func isBelowMinimum(_ current: String) -> Bool {
        guard let min = SemVer(minimumSupportedVersion), let cur = SemVer(current) else { return false }
        return cur < min
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
