import Foundation

/// Which language the app is in: the operator's, once they have picked one
/// in Settings — a decision, never overridden — and until then the one Super
/// Admin chose for the iOS app (Mobile App → iOS → In-app settings, read
/// before sign-in), remembered from the last time the platform said, and
/// only on a phone that has never heard from the platform the language
/// compiled into the build.
enum LanguageChoice {
    /// The language to start in, before anything is asked of the server.
    static func starting(stored: String?, platformDefault: String?, compiled: Language) -> Language {
        stored.flatMap(Language.init(rawValue:))
            ?? platformDefault.flatMap(Language.init(rawValue:))
            ?? compiled
    }

    /// What the platform's default changes, now that it has answered: the
    /// language to switch to, or nil to stay — the operator chose one, or it
    /// is already the one on screen.
    static func adopt(platformDefault: Language, hasChosen: Bool, current: Language) -> Language? {
        guard !hasChosen, platformDefault != current else { return nil }
        return platformDefault
    }
}

/// What `GET /api/mobile-app/public-config?platform=ios` answers, before sign-in.
struct MobilePublicConfig: Decodable, Sendable, Equatable {
    /// The language the app opens in until the operator picks one; nil for a
    /// value this app does not speak.
    let defaultLanguage: Language?

    init(defaultLanguage: Language?) {
        self.defaultLanguage = defaultLanguage
    }

    private enum CodingKeys: String, CodingKey { case defaultLanguage }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try? c.decodeIfPresent(String.self, forKey: .defaultLanguage)
        defaultLanguage = raw.flatMap(Language.init(rawValue:))
    }
}
