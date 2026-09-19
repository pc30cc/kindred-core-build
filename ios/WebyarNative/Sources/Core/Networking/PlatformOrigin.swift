import Foundation

/// Where this app talks to, and where its links point.
///
/// The platform names its own hosts once, in Super Admin → Branding
/// (`platform_domains`), and every server-side consumer already follows that
/// without a redeploy. The native app used to be the one exception: a host
/// compiled into the binary from `config/mobile-runtime.json`, which kept
/// pointing at the old domain for as long as the app was installed.
///
/// It reads from the platform now. The compiled value is a **bootstrap of last
/// resort** and nothing more — a signed binary has to contain some origin to
/// make its first request, because you cannot ask the API where the API is
/// without an API. Everything after that first answer comes from the platform
/// and is remembered, so an operator who moves the API does not need an App
/// Store release to bring the phones with them.
///
/// The stored value can always be abandoned. A domain typed wrong in Super
/// Admin would otherwise brick every installed copy, so a stored origin that
/// stops answering is forgotten and the compiled one takes over again.
enum PlatformOrigin {
    private static let originKey = "platform.apiOrigin"
    private static let supportKey = "platform.supportURL"

    /// The origin to use right now.
    static var current: URL {
        guard let stored = UserDefaults.standard.string(forKey: originKey),
              let url = URL(string: stored),
              url.scheme?.lowercased() == "https"
        else { return GeneratedConfig.apiBaseURL }
        return url
    }

    /// True while we are running on something the platform told us, rather
    /// than on the value baked into the build.
    static var isStored: Bool {
        UserDefaults.standard.string(forKey: originKey) != nil
    }

    static func remember(_ url: URL) {
        UserDefaults.standard.set(url.absoluteString, forKey: originKey)
    }

    static func forget() {
        UserDefaults.standard.removeObject(forKey: originKey)
    }

    /// Opened from Settings → About. The platform's help centre when it names
    /// one, its public site otherwise, and only then the compiled fallback.
    static var supportURL: URL? {
        if let stored = UserDefaults.standard.string(forKey: supportKey),
           let url = URL(string: stored) {
            return url
        }
        return GeneratedConfig.supportURL
    }

    static func rememberSupport(_ url: URL?) {
        guard let url else { return }
        UserDefaults.standard.set(url.absoluteString, forKey: supportKey)
    }
}

/// What `GET /api/platform/origins` answers.
struct PlatformOrigins: Decodable, Sendable {
    let apiBaseUrl: String?
    let appBaseUrl: String?
    let publicBaseUrl: String?
    let helpCenterUrl: String?
    /// Already resolved server-side. Every client used to append its own path
    /// here and they disagreed — the build script said `/contact`, a route
    /// that does not exist, and the app opened the bare origin.
    let supportUrl: String?

    private static func https(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw), url.scheme?.lowercased() == "https"
        else { return nil }
        return url
    }

    var api: URL? { Self.https(apiBaseUrl) }
    /// Where "Contact support" goes. The server decides; the last two are only
    /// for a platform that has not deployed the resolved field yet.
    var support: URL? {
        Self.https(supportUrl) ?? Self.https(helpCenterUrl) ?? Self.https(publicBaseUrl)
    }
}
