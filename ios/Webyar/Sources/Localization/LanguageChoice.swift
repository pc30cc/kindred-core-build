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
    /// The App Store record's privacy policy and terms (Super Admin → Mobile
    /// App → App Store record).
    let legal: LegalLinks

    init(defaultLanguage: Language?, legal: LegalLinks = LegalLinks()) {
        self.defaultLanguage = defaultLanguage
        self.legal = legal
    }

    private enum CodingKeys: String, CodingKey { case defaultLanguage, privacyPolicyUrl, termsUrl }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try? c.decodeIfPresent(String.self, forKey: .defaultLanguage)
        defaultLanguage = raw.flatMap(Language.init(rawValue:))
        legal = LegalLinks(
            privacyPolicy: LegalLinks.https(try? c.decodeIfPresent(String.self, forKey: .privacyPolicyUrl)),
            terms: LegalLinks.https(try? c.decodeIfPresent(String.self, forKey: .termsUrl))
        )
    }
}

/// The privacy policy and terms of use, linked from the sign-in screen and
/// the foot of Settings. Only https addresses are kept.
struct LegalLinks: Equatable, Sendable {
    var privacyPolicy: URL?
    var terms: URL?

    init(privacyPolicy: URL? = nil, terms: URL? = nil) {
        self.privacyPolicy = privacyPolicy
        self.terms = terms
    }

    var isEmpty: Bool { privacyPolicy == nil && terms == nil }

    static func https(_ raw: String?) -> URL? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: raw), url.scheme?.lowercased() == "https", url.host() != nil
        else { return nil }
        return url
    }
}
