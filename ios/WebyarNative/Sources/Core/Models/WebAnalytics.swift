import Foundation

// MARK: - Website analytics (`/api/web-analytics/:workspaceId/…`)
//
// The reports the web console's SEO → Web Analytics page reads, as
// `server/services/webAnalytics/reportService.ts` builds them. These answer
// in camelCase — unlike the rest of the API — so the keys below are the
// property names and there is nothing to map.
//
// Lenient for the same reason the visitors are: a number that does not read
// is shown as nothing rather than failing the whole report.

/// The first and last day of a report, as the server counts days: in UTC,
/// written `YYYY-MM-DD`, both included.
struct AnalyticsDateRange: Hashable, Sendable {
    var start: String
    var end: String
}

/// The headline numbers for a range, and the day-by-day trend.
struct WebAnalyticsOverview: Hashable, Sendable {
    var sessions: Int?
    var pageviews: Int?
    var avgPagesPerSession: Double?
    var uniqueVisitors: Int?
    /// A percentage, 0–100, of visits that saw a single page.
    var bounceRate: Double?
    var avgVisitDurationSeconds: Double?
    var trend: [WebAnalyticsDay]
    var topChannels: [WebAnalyticsRow]
    var topPages: [WebAnalyticsPage]
    /// The range was too busy to read whole and the numbers come from a
    /// sample — said on screen, never hidden.
    var truncated: Bool

    init(
        sessions: Int? = nil, pageviews: Int? = nil, avgPagesPerSession: Double? = nil,
        uniqueVisitors: Int? = nil, bounceRate: Double? = nil, avgVisitDurationSeconds: Double? = nil,
        trend: [WebAnalyticsDay] = [], topChannels: [WebAnalyticsRow] = [], topPages: [WebAnalyticsPage] = [],
        truncated: Bool = false
    ) {
        self.sessions = sessions
        self.pageviews = pageviews
        self.avgPagesPerSession = avgPagesPerSession
        self.uniqueVisitors = uniqueVisitors
        self.bounceRate = bounceRate
        self.avgVisitDurationSeconds = avgVisitDurationSeconds
        self.trend = trend
        self.topChannels = topChannels
        self.topPages = topPages
        self.truncated = truncated
    }
}

extension WebAnalyticsOverview: Decodable {
    enum CodingKeys: String, CodingKey {
        case sessions, pageviews, avgPagesPerSession, uniqueVisitors, bounceRate
        case avgVisitDurationSeconds, trend, topChannels, topPages, truncated
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessions = c.lenientInt(.sessions)
        pageviews = c.lenientInt(.pageviews)
        avgPagesPerSession = c.lenientDouble(.avgPagesPerSession)
        uniqueVisitors = c.lenientInt(.uniqueVisitors)
        bounceRate = c.lenientDouble(.bounceRate)
        avgVisitDurationSeconds = c.lenientDouble(.avgVisitDurationSeconds)
        trend = c.lenientRows(.trend)
        topChannels = c.lenientRows(.topChannels)
        topPages = c.lenientRows(.topPages)
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
    }
}

/// One day of the trend.
struct WebAnalyticsDay: Hashable, Sendable {
    /// `YYYY-MM-DD`, in UTC.
    var date: String
    var sessions: Int
    var pageviews: Int

    init(date: String, sessions: Int, pageviews: Int) {
        self.date = date
        self.sessions = sessions
        self.pageviews = pageviews
    }
}

extension WebAnalyticsDay: Decodable {
    enum CodingKeys: String, CodingKey { case date, sessions, pageviews }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decode(String.self, forKey: .date)
        sessions = c.lenientInt(.sessions) ?? 0
        pageviews = c.lenientInt(.pageviews) ?? 0
    }
}

/// One line of a "group by X, count visits" report.
struct WebAnalyticsRow: Identifiable, Hashable, Sendable {
    /// What the server grouped by: a channel key, a country's English name, a
    /// browser — or `(unknown)` for the bucket of everything it could not tell.
    var key: String
    var label: String?
    var sessions: Int
    var pageviews: Int?

    var id: String { key }

    init(key: String, label: String? = nil, sessions: Int, pageviews: Int? = nil) {
        self.key = key
        self.label = label
        self.sessions = sessions
        self.pageviews = pageviews
    }
}

extension WebAnalyticsRow: Decodable {
    enum CodingKeys: String, CodingKey { case key, label, sessions, pageviews }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = c.lenientString(.label)
        sessions = c.lenientInt(.sessions) ?? 0
        pageviews = c.lenientInt(.pageviews)
    }
}

/// A page and how many times it was viewed.
struct WebAnalyticsPage: Identifiable, Hashable, Sendable {
    var path: String
    var views: Int

    var id: String { path }

    init(path: String, views: Int) {
        self.path = path
        self.views = views
    }
}

extension WebAnalyticsPage: Decodable {
    enum CodingKeys: String, CodingKey { case path, views }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        views = c.lenientInt(.views) ?? 0
    }
}

/// A custom event the site sends with `window.gsAnalytics.track(…)`.
struct WebAnalyticsEvent: Identifiable, Hashable, Sendable {
    var eventName: String
    var count: Int
    var uniqueSessions: Int
    /// 0–1: the share of the range's visits that fired it.
    var conversionRate: Double

    var id: String { eventName }

    init(eventName: String, count: Int, uniqueSessions: Int, conversionRate: Double) {
        self.eventName = eventName
        self.count = count
        self.uniqueSessions = uniqueSessions
        self.conversionRate = conversionRate
    }
}

extension WebAnalyticsEvent: Decodable {
    enum CodingKeys: String, CodingKey { case eventName, count, uniqueSessions, conversionRate }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        eventName = try c.decode(String.self, forKey: .eventName)
        count = c.lenientInt(.count) ?? 0
        uniqueSessions = c.lenientInt(.uniqueSessions) ?? 0
        conversionRate = c.lenientDouble(.conversionRate) ?? 0
    }
}

/// A report's rows, and whether the server stopped short of the whole range.
struct WebAnalyticsRows<Row: Decodable & Hashable & Sendable>: Hashable, Sendable {
    var rows: [Row]
    var truncated: Bool

    init(rows: [Row], truncated: Bool = false) {
        self.rows = rows
        self.truncated = truncated
    }
}

extension WebAnalyticsRows: Decodable {
    enum CodingKeys: String, CodingKey { case rows, truncated }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rows = c.lenientRows(.rows)
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
    }
}

/// `GET …/live-visitors` → `{ count }`.
struct WebAnalyticsLiveCount: Decodable, Sendable {
    let count: Int

    enum CodingKeys: String, CodingKey { case count }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = c.lenientInt(.count) ?? 0
    }
}

/// The breakdown reports that take a `dimension`, by the path they live at.
enum WebAnalyticsBreakdown: String, Sendable, CaseIterable {
    /// channel | source | campaign
    case trafficSources = "traffic-sources"
    /// continent | country | city | language
    case geography
    /// browser | os | device
    case technology = "browsers-systems"
}

extension KeyedDecodingContainer {
    /// An array whose rows are each kept only if they decode.
    func lenientRows<Row: Decodable>(_ key: Key) -> [Row] {
        let rows = try? decodeIfPresent([LenientRow<Row>].self, forKey: key)
        return (rows ?? []).compactMap(\.value)
    }
}

// MARK: - App configuration

/// `GET /api/mobile-app/config?platform=ios` — which sections Super Admin has
/// switched on for the iPhone app.
///
/// A switch is only a ceiling. A section still has to be in the workspace's
/// plan (and, for analytics, the operator an owner or admin) to show; this is
/// how the platform can take one away from the app without taking it away
/// from the web.
///
/// Everything defaults to on: that is how the app behaved before the switches
/// existed, and a server too old to know the endpoint — or one that cannot be
/// reached — must not quietly strip sections out of the app.
struct MobileAppConfig: Hashable, Sendable {
    var showContacts: Bool
    var showVisitors: Bool
    var showWebAnalytics: Bool
    /// The Inbox's AI tab, and the AI queue in its menu.
    var showAIQueue: Bool
    /// The Inbox's Colleagues tab, and team chat wherever it is reached from.
    var showColleagues: Bool
    /// Settings → Storage: what the app keeps on the phone and the button
    /// that clears it. Hiding it hides the row, not the cache.
    var showStorage: Bool
    /// Settings → Online support: the chat with the platform's own team.
    /// Only a ceiling — support still has to be on (Super Admin → Core
    /// settings → Support) and offered to this operator.
    var showSupport: Bool
    /// Where Settings → About → Support opens, when Super Admin named one:
    /// a page (https), an email (mailto:) or a phone number (tel:). `nil`
    /// leaves the platform's own help centre in charge (`PlatformOrigin`).
    var supportURL: URL?

    static let defaults = MobileAppConfig(showContacts: true, showVisitors: true, showWebAnalytics: true)

    init(
        showContacts: Bool, showVisitors: Bool, showWebAnalytics: Bool,
        showAIQueue: Bool = true, showColleagues: Bool = true, showStorage: Bool = true,
        showSupport: Bool = true, supportURL: URL? = nil
    ) {
        self.showContacts = showContacts
        self.showVisitors = showVisitors
        self.showWebAnalytics = showWebAnalytics
        self.showAIQueue = showAIQueue
        self.showColleagues = showColleagues
        self.showStorage = showStorage
        self.showSupport = showSupport
        self.supportURL = supportURL
    }

    /// A link fit to put behind a Support button: https, mailto: or tel:, and
    /// nothing else — a Super Admin typo is not a reason to open whatever
    /// scheme it happens to spell.
    static func supportLink(_ raw: String?) -> URL? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              ["https", "mailto", "tel"].contains(scheme)
        else { return nil }
        if scheme == "https", url.host?.isEmpty ?? true { return nil }
        return url
    }
}

extension MobileAppConfig: Decodable {
    enum CodingKeys: String, CodingKey {
        case showContacts, showVisitors, showWebAnalytics, showAIQueue, showColleagues, showStorage, showSupport
        case supportURL = "supportUrl"
    }

    /// Only an explicit `false` turns a section off; a missing or unreadable
    /// key keeps the default, so an older server that sends fewer keys never
    /// hides anything.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func flag(_ key: CodingKeys) -> Bool {
            (try? c.decodeIfPresent(Bool.self, forKey: key)) != false
        }
        showContacts = flag(.showContacts)
        showVisitors = flag(.showVisitors)
        showWebAnalytics = flag(.showWebAnalytics)
        showAIQueue = flag(.showAIQueue)
        showColleagues = flag(.showColleagues)
        showStorage = flag(.showStorage)
        showSupport = flag(.showSupport)
        supportURL = Self.supportLink(try? c.decodeIfPresent(String.self, forKey: .supportURL))
    }
}
