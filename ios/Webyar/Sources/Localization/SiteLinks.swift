import Foundation

/// WebYar's own site, in the app's language (owner, 2026-11-01).
///
/// The site keeps Persian at its root and every other language under its
/// code: `https://webyar.ai`, `/privacy`, `/terms` in Persian;
/// `https://webyar.ai/en`, `/en/privacy`, `/en/terms` in English; `/tr/…`
/// and `/ar/…` likewise. The links at the foot of Settings and of the sign-in
/// screen open those pages, in the language the app is showing.
///
/// The site's address is still Super Admin's: the root is taken from the
/// website link set for the app (Mobile App → iOS → In-app settings), so
/// moving the site moves the links. Until that link is known the configured
/// pages are used as they are.
///
/// RESPOK keeps the links it is given: its site's main language is English
/// and its pages are laid out its own way.
enum SiteLinks {
    /// Whether this brand's links follow the language. WebYar only.
    static var followsLanguage: Bool { AppBrand.id == "webyar" }

    enum Page: String {
        case home = ""
        case privacy = "privacy"
        case terms = "terms"
    }

    /// The path segment a language lives under: none for Persian, its code otherwise.
    static func languageSegment(_ language: Language) -> String? {
        language == .fa ? nil : language.rawValue
    }

    /// `https://host` of the website link, nothing else of it.
    static func root(of website: URL?) -> URL? {
        guard let website,
              let scheme = website.scheme?.lowercased(), scheme == "https",
              let host = website.host(), !host.isEmpty
        else { return nil }
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = host
        parts.port = website.port
        return parts.url
    }

    /// A page of the site in `language`, or nil when the site's address is unknown.
    static func page(_ page: Page, website: URL?, language: Language) -> URL? {
        guard let root = root(of: website) else { return nil }
        let segments = [languageSegment(language), page.rawValue.isEmpty ? nil : page.rawValue].compactMap { $0 }
        guard !segments.isEmpty else { return root }
        var parts = URLComponents(url: root, resolvingAgainstBaseURL: false)
        parts?.path = "/" + segments.joined(separator: "/")
        return parts?.url
    }

    /// The website row's link.
    static func website(_ website: URL?, language: Language, followsLanguage: Bool = SiteLinks.followsLanguage) -> URL? {
        guard followsLanguage else { return website }
        return page(.home, website: website, language: language) ?? website
    }

    /// The privacy policy and the terms.
    static func legal(
        _ configured: LegalLinks,
        website: URL?,
        language: Language,
        followsLanguage: Bool = SiteLinks.followsLanguage
    ) -> LegalLinks {
        guard followsLanguage, root(of: website) != nil else { return configured }
        return LegalLinks(
            privacyPolicy: page(.privacy, website: website, language: language),
            terms: page(.terms, website: website, language: language)
        )
    }
}
