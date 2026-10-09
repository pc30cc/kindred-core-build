import Foundation

/// The brand this build wears, fixed at compile time: the `Webyar` target is
/// WebYar exactly as before, the `Respok` target (project.yml) defines
/// BRAND_RESPOK and is RESPOK. One source makes two apps that live side by
/// side on one Mac, each with its own bundle id, name, icon, server, Keychain
/// item, logs and update feed (Super Admin → macOS app on each platform names
/// its own appcast).
enum AppBrand {
    #if BRAND_RESPOK
    static let id = "respok"
    /// The product's name wherever the app names itself (the copy itself is strings.respok.json).
    static let name = "RESPOK"
    /// The API a fresh install signs in to; the platform can move it later (/api/platform/origins).
    static let apiOrigin = URL(string: "https://api.respok.app")!
    /// The Keychain service that holds the session.
    static let keychainService = "app.respok.mac"
    /// ~/Library/Logs/<folder>, temporary folders.
    static let folder = "RESPOK"
    /// The User-Agent product token and the realtime client name.
    static let agentToken = "RespokMac"
    static let realtimeName = "respok-macos"
    /// The language when the Mac's own is none of the app's (fa, en, tr). RESPOK is the
    /// International edition, where Persian is a language to pick, never the default.
    static let fallbackLanguage: Language = .en
    /// Persian dates in the Persian (Jalali) calendar. Not for RESPOK: in the International
    /// edition Persian is only right-to-left text, so its dates are Gregorian in Persian digits.
    static let jalaliDates = false
    #else
    static let id = "webyar"
    static let name = "Webyar"
    static let apiOrigin = URL(string: "https://api.webyar.ai")!
    static let keychainService = "ai.webyar.mac"
    static let folder = "Webyar"
    static let agentToken = "WebyarMac"
    static let realtimeName = "webyar-macos"
    static let fallbackLanguage: Language = .fa
    static let jalaliDates = true
    #endif
}
