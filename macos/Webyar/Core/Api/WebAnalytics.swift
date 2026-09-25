import Foundation

// MARK: - Website analytics (`/api/web-analytics/:workspaceId/…`), as the web's SEO → Web Analytics reads it

/// The headline numbers for a date range, and the day-by-day trend.
struct WebAnalyticsOverview: Codable, Hashable, Sendable {
    @Lenient var sessions: Int? = nil
    @Lenient var pageviews: Int? = nil
    @Lenient var avgPagesPerSession: Double? = nil
    @Lenient var uniqueVisitors: Int? = nil
    /// Percentage, 0–100, of sessions with a single page view.
    @Lenient var bounceRate: Double? = nil
    @Lenient var avgVisitDurationSeconds: Double? = nil
    var trend: [WebAnalyticsDay]?
    var topChannels: [WebAnalyticsRow]?
    var topPages: [WebAnalyticsPage]?
    var truncated: Bool?
}

struct WebAnalyticsDay: Codable, Hashable, Sendable {
    /// YYYY-MM-DD.
    var date: String
    @Lenient var sessions: Int? = nil
    @Lenient var pageviews: Int? = nil
}

/// One line of a "group by X, count sessions" report.
struct WebAnalyticsRow: Codable, Hashable, Sendable, Identifiable {
    var key: String
    var label: String?
    @Lenient var sessions: Int? = nil
    @Lenient var pageviews: Int? = nil
    var id: String { key }
}

struct WebAnalyticsPage: Codable, Hashable, Sendable, Identifiable {
    var path: String
    @Lenient var views: Int? = nil
    var id: String { path }
}

struct WebAnalyticsEvent: Codable, Hashable, Sendable, Identifiable {
    var eventName: String
    @Lenient var count: Int? = nil
    @Lenient var uniqueSessions: Int? = nil
    /// 0–1: the share of the range's sessions that fired it.
    @Lenient var conversionRate: Double? = nil
    var id: String { eventName }
}

/// A report's rows, and whether the server stopped short of the whole range.
struct WebAnalyticsRows<Row: Codable & Hashable & Sendable>: Codable, Hashable, Sendable {
    var rows: [Row]?
    var truncated: Bool?
}

private struct LiveVisitorsResponse: Decodable { @Lenient var count: Int? = nil }

extension WebyarAPI {
    private func analyticsPath(_ workspaceId: String, _ tail: String) -> String {
        "/api/web-analytics/\(ApiClient.escape(workspaceId))/\(tail)"
    }

    private func range(_ start: String, _ end: String) -> [(String, String?)] {
        [("startDate", start), ("endDate", end)]
    }

    func analyticsOverview(workspaceId: String, start: String, end: String) async throws -> WebAnalyticsOverview {
        try await client.get(analyticsPath(workspaceId, "overview"), query: range(start, end))
    }

    func analyticsLiveVisitors(workspaceId: String) async throws -> Int {
        let r: LiveVisitorsResponse = try await client.get(analyticsPath(workspaceId, "live-visitors"))
        return r.count ?? 0
    }

    /// channel | source | campaign.
    func analyticsTrafficSources(workspaceId: String, dimension: String, start: String, end: String) async throws -> WebAnalyticsRows<WebAnalyticsRow> {
        try await client.get(analyticsPath(workspaceId, "traffic-sources"), query: [("dimension", dimension)] + range(start, end))
    }

    /// continent | country | city | language.
    func analyticsGeography(workspaceId: String, dimension: String, start: String, end: String) async throws -> WebAnalyticsRows<WebAnalyticsRow> {
        try await client.get(analyticsPath(workspaceId, "geography"), query: [("dimension", dimension)] + range(start, end))
    }

    /// browser | os | device.
    func analyticsTechnology(workspaceId: String, dimension: String, start: String, end: String) async throws -> WebAnalyticsRows<WebAnalyticsRow> {
        try await client.get(analyticsPath(workspaceId, "browsers-systems"), query: [("dimension", dimension)] + range(start, end))
    }

    /// top | entry | exit | new.
    func analyticsPages(workspaceId: String, kind: String, start: String, end: String) async throws -> WebAnalyticsRows<WebAnalyticsPage> {
        try await client.get(analyticsPath(workspaceId, "pages"), query: [("kind", kind)] + range(start, end))
    }

    func analyticsEvents(workspaceId: String, start: String, end: String) async throws -> WebAnalyticsRows<WebAnalyticsEvent> {
        try await client.get(analyticsPath(workspaceId, "events"), query: range(start, end))
    }
}
