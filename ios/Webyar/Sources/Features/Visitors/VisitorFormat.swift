import Foundation

/// How the Visitors screens word a visitor, in the operator's language.
enum VisitorFormat {

    /// What to call a visitor: their contact's name or email when they gave
    /// one, otherwise "Visitor" and the short code the web shows for them —
    /// so an anonymous visitor reads the same here as in the console, and two
    /// of them are never both just "Visitor".
    static func name(_ visitor: LiveVisitor, language: Language) -> String {
        Format.contactName(
            name: visitor.contact?.name,
            email: visitor.contact?.email,
            visitorCode: VisitorText.code(visitor),
            language: language
        )
    }

    /// "just now", "4m ago", "2h ago", in the reader's digits.
    static func ago(_ date: Date, now: Date, language: Language) -> String {
        let elapsed = VisitorText.elapsed(since: date, now: now)
        if elapsed.minutes < 1 { return Str.visitorsJustNow(language) }
        if elapsed.hours < 1 {
            return Str.visitorsMinutesAgo(language)
                .filling("n", with: Format.number(elapsed.minutes, language: language))
        }
        return Str.visitorsHoursAgo(language)
            .filling("n", with: Format.number(elapsed.hours, language: language))
    }

    static func presence(_ presence: VisitorPresence, language: Language) -> String {
        switch presence {
        case .online: Str.visitorStatusOnline(language)
        case .idle: Str.visitorStatusIdle(language)
        case .offline: Str.visitorStatusOffline(language)
        }
    }

    /// Where they are, or the words for not knowing. Persian and Arabic list
    /// with their own comma.
    static func location(_ geo: VisitorGeo?, language: Language) -> String {
        VisitorText.location(geo, separator: language.listSeparator)
            ?? Str.visitorsUnknownLocation(language)
    }

    /// The place and how long ago, for a row's second line.
    static func whereAndWhen(_ visitor: LiveVisitor, now: Date, language: Language) -> String {
        let place = location(visitor.geo, language: language)
        guard let at = visitor.lastActivityAt else { return place }
        return "\(place) · \(ago(at, now: now, language: language))"
    }

    /// The device class in the reader's language, or the server's own word
    /// for one this app has no name for.
    static func device(_ key: String, language: Language) -> String {
        switch key.lowercased() {
        case "mobile", "phone": Str.analyticsDeviceMobile(language)
        case "desktop": Str.analyticsDeviceDesktop(language)
        case "tablet": Str.analyticsDeviceTablet(language)
        default: key
        }
    }

    /// An SF Symbol for a device class.
    static func deviceIcon(_ key: String?) -> String {
        let key = (key ?? "").lowercased()
        if key.contains("mobile") || key.contains("phone") { return "iphone" }
        if key.contains("tablet") || key.contains("ipad") { return "ipad" }
        return "desktopcomputer"
    }

    /// The template's count, in the reader's digits.
    static func count(_ template: String, _ n: Int, language: Language) -> String {
        template.filling("n", with: Format.number(n, language: language))
    }
}
