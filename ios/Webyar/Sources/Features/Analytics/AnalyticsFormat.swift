import Foundation

/// Numbers, shares, durations, days and the server's keys, the way each of
/// the app's languages writes them.
enum AnalyticsFormat {

    static func count(_ n: Int, _ language: Language) -> String {
        Format.number(n, language: language)
    }

    /// One decimal place: "2.7" pages per visit, in the reader's digits.
    static func decimal(_ value: Double, _ language: Language) -> String {
        let formatter = NumberFormatter()
        formatter.locale = language.locale
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 1
        formatter.maximumFractionDigits = 1
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.1f", value)
    }

    /// `fraction` is 0–1. A small share keeps one decimal, so "0.4%" is not
    /// rounded down to a misleading "0%".
    static func percent(_ fraction: Double, _ language: Language) -> String {
        let formatter = NumberFormatter()
        formatter.locale = language.locale
        formatter.numberStyle = .percent
        formatter.maximumFractionDigits = fraction > 0 && fraction < 0.1 ? 1 : 0
        return formatter.string(from: NSNumber(value: fraction)) ?? "\(Int((fraction * 100).rounded()))%"
    }

    /// "2m 14s", or "48s" under a minute.
    static func duration(_ seconds: Double, _ language: Language) -> String {
        let total = max(0, Int(seconds.rounded()))
        let minutes = total / 60, rest = total % 60
        let s = "\(count(rest, language)) \(Str.analyticsSecondsShort(language))"
        guard minutes > 0 else { return s }
        return "\(count(minutes, language)) \(Str.analyticsMinutesShort(language)) \(s)"
    }

    /// A trend day, `YYYY-MM-DD` in UTC, as a date.
    ///
    /// Read by hand rather than with a `DateFormatter`: the trend redraws
    /// every day of the range, and three numbers need no formatter.
    static func day(_ text: String) -> Date? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? calendar.timeZone
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        guard components.isValidDate(in: calendar) else { return nil }
        return calendar.date(from: components)
    }

    /// "12 Mehr" / "4 Oct": a trend day on the chart's axis. Persian reads it
    /// in the Persian calendar, like every other date in the app. In UTC,
    /// because that is the day the server counted it in.
    static func dayLabel(_ date: Date, _ language: Language, long: Bool = false) -> String {
        let formatter = DateFormatter()
        formatter.locale = language.locale
        var calendar = Calendar(identifier: language == .fa ? .persian : .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? calendar.timeZone
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate(long ? "EEEE d MMMM" : "d MMM")
        return formatter.string(from: date)
    }

    /// A traffic channel's key (`organic_search`) in the reader's language.
    static func channel(_ key: String, _ language: Language) -> String {
        switch key {
        case "direct": Str.analyticsChannelDirect(language)
        case "organic_search": Str.analyticsChannelOrganicSearch(language)
        case "organic_social": Str.analyticsChannelOrganicSocial(language)
        case "referral": Str.analyticsChannelReferral(language)
        case "paid_search": Str.analyticsChannelPaidSearch(language)
        case "paid_social": Str.analyticsChannelPaidSocial(language)
        case "email": Str.analyticsChannelEmail(language)
        case "other": Str.analyticsChannelOther(language)
        default: unknown(key, language)
        }
    }

    /// The server's `(unknown)` bucket, in the reader's language.
    static func unknown(_ label: String, _ language: Language) -> String {
        label == "(unknown)" || label.isEmpty ? Str.analyticsUnknown(language) : label
    }

    /// A country's name in the reader's language, and its flag, from the
    /// English name the server's geo data keeps.
    static func country(_ name: String, _ language: Language) -> (flag: String?, name: String) {
        guard let code = countryCodes[name.lowercased()] else { return (nil, unknown(name, language)) }
        return (VisitorText.flag(code), language.locale.localizedString(forRegionCode: code) ?? name)
    }

    private static let countryCodes: [String: String] = {
        var map: [String: String] = [:]
        let english = Locale(identifier: "en_US")
        for region in Locale.Region.isoRegions where region.identifier.count == 2 {
            let code = region.identifier
            if let name = english.localizedString(forRegionCode: code) { map[name.lowercased()] = code }
        }
        // The names the geo databases use where they differ from Apple's.
        let aliases = [
            "iran": "IR", "russia": "RU", "south korea": "KR", "united states": "US", "united kingdom": "GB",
            "turkey": "TR", "türkiye": "TR", "czech republic": "CZ", "vietnam": "VN", "syria": "SY", "hong kong": "HK",
        ]
        for (name, code) in aliases { map[name] = code }
        return map
    }()

    /// `fa-IR` → "Persian (Iran)", in the reader's language.
    static func languageName(_ tag: String, _ language: Language) -> String {
        guard tag != "(unknown)" else { return Str.analyticsUnknown(language) }
        return language.locale.localizedString(forIdentifier: tag.replacingOccurrences(of: "-", with: "_")) ?? tag
    }

    static func sectionTitle(_ section: AnalyticsSection, _ language: Language) -> String {
        switch section {
        case .overview: Str.analyticsOverview(language)
        case .sources: Str.analyticsSources(language)
        case .pages: Str.analyticsPages(language)
        case .geography: Str.analyticsGeography(language)
        case .technology: Str.analyticsTechnology(language)
        case .events: Str.analyticsEvents(language)
        }
    }

    static func sectionHint(_ section: AnalyticsSection, _ language: Language) -> String {
        switch section {
        case .overview: Str.analyticsOverviewHint(language)
        case .sources: Str.analyticsSourcesHint(language)
        case .pages: Str.analyticsPagesHint(language)
        case .geography: Str.analyticsGeographyHint(language)
        case .technology: Str.analyticsTechnologyHint(language)
        case .events: Str.analyticsEventsHint(language)
        }
    }

    static func rangeTitle(_ range: AnalyticsRange, _ language: Language) -> String {
        switch range {
        case .week: Str.analyticsRange7(language)
        case .month: Str.analyticsRange28(language)
        case .quarter: Str.analyticsRange90(language)
        }
    }

    /// An SF Symbol for an operating system's name.
    static func osIcon(_ name: String) -> String {
        let key = name.lowercased()
        if key.contains("ios") || key.contains("mac") || key.contains("ipad") { return "apple.logo" }
        if key.contains("windows") { return "pc" }
        if key.contains("android") { return "candybarphone" }
        if key.contains("linux") || key.contains("ubuntu") { return "terminal" }
        return "questionmark.circle"
    }
}
