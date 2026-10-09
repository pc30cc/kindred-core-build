import Foundation

/// The brand this build wears, fixed at compile time: the `Webyar` target is
/// WebYar exactly as before, the `Respok` target (project.yml) defines
/// BRAND_RESPOK and is RESPOK. One source makes two apps that live side by
/// side on one phone, each with its own bundle id, name, icon, server,
/// Keychain item, caches and logs — the same split as the Mac app
/// (macos/Webyar/Core/Config/AppBrand.swift).
///
/// The copy that names the product is `BrandStr`; the brand's art (icon, mark,
/// launch loader) is its asset catalog and `BrandPalette`.
///
/// Every WebYar value here is the one the app shipped with before RESPOK
/// existed, byte for byte: the Keychain service, the cache folders and the
/// realtime name are already stored on phones, and changing one would sign
/// every WebYar operator out or throw their caches away.
enum AppBrand {
    #if BRAND_RESPOK
    static let id = "respok"
    /// The product's name in identifiers and logs. The sentences that name it are `BrandStr`.
    static let name = "RESPOK"
    /// The mark at the foot of the launch, sign-in and reset screens (`BrandFooter`), and
    /// what follows it: RESPOK's is the name alone. WebYar's is `Str.brandWordmark`'s
    /// "WEBYAR" (src/test/ios/iosBrands.test.ts keeps the two equal).
    static let wordmark = "RESPOK"
    static let wordmarkSuffix: String? = nil
    /// The Keychain service that holds the session.
    static let keychainService = "com.respok.app.session"
    /// The `Logger` subsystem.
    static let logSubsystem = "com.respok.app"
    /// `Library/Caches/<folder>`: the local store and the attachments.
    static let cacheFolder = "Respok"
    /// The remote images' `URLCache` folder.
    static let imageCacheFolder = "respok-images"
    /// The start of a temporary file's name, which Quick Look and the share sheet can show.
    static let tempPrefix = "respok"
    /// The realtime (Centrifugo) client name.
    static let realtimeName = "respok-ios"
    /// Persian dates in the Persian (Jalali) calendar. Not for RESPOK: in the International
    /// edition Persian is only right-to-left text, so its dates are Gregorian in Persian digits
    /// (`fa_IR@calendar=gregorian`), as in RESPOK's desktop apps.
    static let jalaliDates = false
    #else
    static let id = "webyar"
    static let name = "Webyar"
    static let wordmark = "WEBYAR"
    static let wordmarkSuffix: String? = "AI"
    static let keychainService = "com.webyar.ai.session"
    static let logSubsystem = "com.webyar.ai"
    static let cacheFolder = "Webyar"
    static let imageCacheFolder = "webyar-images"
    static let tempPrefix = "webyar"
    static let realtimeName = "webyar-ios"
    static let jalaliDates = true
    #endif

    /// The API a fresh install makes its first request to: this brand's own bootstrap,
    /// generated from its own config file (config/mobile-runtime.json for WebYar,
    /// config/mobile-runtime.respok.json for RESPOK) by scripts/ios/write-ios-config.mjs.
    /// The platform moves it later (`PlatformOrigin`).
    static var apiOrigin: URL { GeneratedConfig.apiBaseURL }

    /// The language a first launch starts in, before the platform or the operator names one.
    /// English for both today: each brand's config file says so (`defaultLocale`).
    static var defaultLanguage: Language { GeneratedConfig.defaultLanguage }

    /// Whether this build may make `url` its API origin: what the platform answers
    /// (`/api/platform/origins`) and what a phone remembered of it.
    ///
    /// WebYar takes any https origin, as before. RESPOK only its own hosts —
    /// `respok.app` and its subdomains — and nothing else, ever: a RESPOK
    /// database cloned from WebYar's that still names a WebYar host, under any of
    /// the names WebYar has had, would otherwise move the phone onto WebYar's
    /// servers without a word. A stored origin that fails this is ignored and the
    /// bootstrap (`apiOrigin`) is used instead. (scripts/ios/write-ios-config.mjs
    /// holds the bootstrap itself to the same rule.)
    static func ownsOrigin(_ url: URL) -> Bool {
        #if BRAND_RESPOK
        guard let host = url.host()?.lowercased() else { return false }
        return host == "respok.app" || host.hasSuffix(".respok.app")
        #else
        return true
        #endif
    }

    /// Whether this build may use a link or a server the platform names besides its
    /// API: the website and support links, the legal pages, the realtime socket and
    /// a call's signalling server.
    ///
    /// WebYar takes any (https is checked where each is read, as before). RESPOK
    /// takes none on a WebYar host. These are not held to `respok.app` alone the way
    /// the API origin is: a help centre or a call server can legitimately live on a
    /// service's own domain.
    static func accepts(host: String?) -> Bool {
        #if BRAND_RESPOK
        guard let host = host?.lowercased(), !host.isEmpty else { return false }
        return !host.contains("webyar")
        #else
        return true
        #endif
    }

    static func accepts(_ url: URL) -> Bool {
        accepts(host: url.host())
    }

    static func accepts(_ raw: String) -> Bool {
        accepts(host: URL(string: raw)?.host())
    }
}
