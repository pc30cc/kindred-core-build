import Foundation
import Observation

/// The website analytics' reports, in the order the screen lists them.
enum AnalyticsSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case overview, sources, pages, geography, technology, events
    var id: String { rawValue }

    var icon: String {
        switch self {
        case .overview: "chart.xyaxis.line"
        case .sources: "arrow.triangle.branch"
        case .pages: "doc.text"
        case .geography: "globe.europe.africa"
        case .technology: "laptopcomputer.and.iphone"
        case .events: "cursorarrow.click.2"
        }
    }
}

/// The date range every report shares: the last 7, 28 or 90 days, today
/// included, counted in UTC as the server counts them.
enum AnalyticsRange: Int, CaseIterable, Identifiable, Hashable, Sendable {
    case week = 7, month = 28, quarter = 90
    var id: Int { rawValue }

    func bounds(now: Date) -> AnalyticsDateRange { bounds(endingDaysAgo: 0, now: now) }

    /// The same number of days just before, for "compared with the period before".
    func previousBounds(now: Date) -> AnalyticsDateRange { bounds(endingDaysAgo: rawValue, now: now) }

    private func bounds(endingDaysAgo offset: Int, now: Date) -> AnalyticsDateRange {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? TimeZone(secondsFromGMT: 0) ?? .current
        let end = calendar.date(byAdding: .day, value: -offset, to: now) ?? now
        let start = calendar.date(byAdding: .day, value: -(rawValue - 1), to: end) ?? end
        return AnalyticsDateRange(start: Self.day(start, calendar), end: Self.day(end, calendar))
    }

    private static func day(_ date: Date, _ calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }
}

/// Website analytics, as the web console's SEO → Web Analytics reads it: the
/// visits the chat widget's snippet already records, over a shared range.
///
/// Reports load lazily — only the section on screen is asked for — and are
/// kept per range, so going back to a report already read is instant. A
/// generation number is bumped by anything that makes the reports in hand
/// wrong (another range, another workspace, a refresh); an answer that comes
/// back for an older generation is dropped rather than shown under the new
/// range's title.
@MainActor
@Observable
final class AnalyticsViewModel {

    var section: AnalyticsSection = .overview
    private(set) var range: AnalyticsRange = .month

    /// The dimension on each report that has more than one.
    var sourceDimension = "channel"
    var pagesKind = "top"
    var geoDimension = "country"

    private(set) var overview: WebAnalyticsOverview?
    /// The same report for the days just before the range, for the headline
    /// numbers' change. Optional in every sense: without it the numbers show
    /// without their arrows.
    private(set) var previous: WebAnalyticsOverview?
    /// Report rows by `report.dimension`, for the range on screen.
    private(set) var breakdowns: [String: WebAnalyticsRows<WebAnalyticsRow>] = [:]
    private(set) var pageLists: [String: WebAnalyticsRows<WebAnalyticsPage>] = [:]
    private(set) var events: WebAnalyticsRows<WebAnalyticsEvent>?
    /// Visitors on the site right now.
    private(set) var live: Int?

    private(set) var loading: Set<String> = []
    /// The last report asked for failed; the screen offers to try again.
    private(set) var failed = false
    /// The server says the plan does not include web analytics — it may have
    /// changed since the tab was drawn.
    private(set) var locked = false

    @ObservationIgnored private let api: any WebyarAPI
    @ObservationIgnored private let clock: @Sendable () -> Date
    @ObservationIgnored private var workspaceID: String?
    /// Observed, because the loading `.task` is keyed on it.
    private(set) var generation = 0

    static let liveInterval: Duration = .seconds(30)
    static let technologyDimensions = ["device", "os", "browser"]

    init(api: any WebyarAPI = Backend.current, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.api = api
        self.clock = clock
    }

    // MARK: - What invalidates

    /// Another workspace: nothing read for the last one is kept.
    func use(workspaceID: String?) {
        guard workspaceID != self.workspaceID else { return }
        self.workspaceID = workspaceID
        live = nil
        locked = false
        discard()
    }

    func setRange(_ next: AnalyticsRange) {
        guard next != range else { return }
        range = next
        discard()
    }

    /// Asks again for everything, from nothing.
    func refresh() {
        locked = false
        discard()
    }

    private func discard() {
        generation += 1
        // Answers still out belong to the old generation and will be dropped,
        // so they must not keep the new ones from being asked for.
        loading = []
        failed = false
        overview = nil
        previous = nil
        breakdowns = [:]
        pageLists = [:]
        events = nil
    }

    // MARK: - Loading

    /// Whatever the section on screen needs that is not already here. The
    /// screen calls it from a `.task` keyed on the section, the dimensions,
    /// the range and the generation, so it runs again whenever any of them
    /// changes and is cancelled when the operator moves on.
    func load(workspaceID: String?, appState: AppState) async {
        use(workspaceID: workspaceID)
        guard let workspaceID, !locked else { return }
        // Everything below belongs to this generation; once it is replaced,
        // a load still working through its list stops asking.
        let generation = generation
        let current = self.range
        let range = current.bounds(now: clock())
        switch section {
        case .overview:
            if overview == nil {
                await fetch("overview", workspaceID: workspaceID, appState: appState) { api in
                    try await api.analyticsOverview(workspaceID: workspaceID, range: range)
                } apply: { self.overview = $0 }
            }
            if previous == nil, generation == self.generation {
                let before = current.previousBounds(now: clock())
                await fetch("overview.previous", quiet: true, workspaceID: workspaceID, appState: appState) { api in
                    try await api.analyticsOverview(workspaceID: workspaceID, range: before)
                } apply: { self.previous = $0 }
            }
        case .sources:
            await breakdown(.trafficSources, "sources", sourceDimension, range, workspaceID, appState)
        case .geography:
            await breakdown(.geography, "geo", geoDimension, range, workspaceID, appState)
        case .technology:
            for dimension in Self.technologyDimensions where generation == self.generation {
                await breakdown(.technology, "tech", dimension, range, workspaceID, appState)
            }
        case .pages:
            let key = Self.key("pages", pagesKind), kind = pagesKind
            if pageLists[key] == nil {
                await fetch(key, workspaceID: workspaceID, appState: appState) { api in
                    try await api.analyticsPages(workspaceID: workspaceID, kind: kind, range: range)
                } apply: { self.pageLists[key] = $0 }
            }
        case .events:
            if events == nil {
                await fetch("events", workspaceID: workspaceID, appState: appState) { api in
                    try await api.analyticsEvents(workspaceID: workspaceID, range: range)
                } apply: { self.events = $0 }
            }
        }
    }

    private func breakdown(
        _ report: WebAnalyticsBreakdown, _ prefix: String, _ dimension: String,
        _ range: AnalyticsDateRange, _ workspaceID: String, _ appState: AppState
    ) async {
        let key = Self.key(prefix, dimension)
        guard breakdowns[key] == nil else { return }
        await fetch(key, workspaceID: workspaceID, appState: appState) { api in
            try await api.analyticsBreakdown(workspaceID: workspaceID, report: report, dimension: dimension, range: range)
        } apply: { self.breakdowns[key] = $0 }
    }

    static func key(_ report: String, _ dimension: String) -> String { "\(report).\(dimension)" }

    func isLoading(_ key: String) -> Bool { loading.contains(key) }

    /// One report for the range on screen. Its answer is kept only if nothing
    /// has been invalidated since it was asked for. A `quiet` report is an
    /// extra: when it fails the page simply shows without it.
    private func fetch<Value: Sendable>(
        _ key: String,
        quiet: Bool = false,
        workspaceID: String,
        appState: AppState,
        _ request: (any WebyarAPI) async throws -> Value,
        apply: (Value) -> Void
    ) async {
        guard !loading.contains(key) else { return }
        let generation = generation
        loading.insert(key)
        if !quiet { failed = false }
        defer { if generation == self.generation { loading.remove(key) } }
        do {
            let value = try await request(api)
            guard generation == self.generation, !Task.isCancelled else { return }
            apply(value)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch APIError.server(let status, _) where status == 403 {
            guard generation == self.generation, !quiet else { return }
            // The plan no longer carries it. Say so here, and have the gates
            // look again so the tab itself goes the way of the plan.
            locked = true
            await appState.loadPlan()
        } catch {
            // A report abandoned because the operator moved on is not a
            // failure worth a banner.
            guard generation == self.generation, !quiet, !Task.isCancelled else { return }
            failed = true
        }
    }

    // MARK: - Live count

    /// Reads "on the site now" every thirty seconds until cancelled.
    func pollLive(workspaceID: String, appState: AppState) async {
        use(workspaceID: workspaceID)
        while !Task.isCancelled {
            do {
                let count = try await api.analyticsLiveVisitors(workspaceID: workspaceID)
                if self.workspaceID == workspaceID, !Task.isCancelled { live = count }
            } catch APIError.unauthorized {
                await appState.handleUnauthorized()
                return
            } catch {
                // Keep the last count; it is an ornament, not a report.
            }
            try? await Task.sleep(for: Self.liveInterval)
        }
    }

    // MARK: - Reading the answers

    /// The relative change from the period before — 0.12 is 12% more — when
    /// both are known and the earlier one is not zero.
    static func change(_ now: Double?, _ before: Double?) -> Double? {
        guard let now, let before, before > 0 else { return nil }
        return (now - before) / before
    }

    /// Whether what is on screen came from a sample of a very busy range.
    var truncated: Bool {
        switch section {
        case .overview: overview?.truncated == true
        case .sources: breakdowns[Self.key("sources", sourceDimension)]?.truncated == true
        case .pages: pageLists[Self.key("pages", pagesKind)]?.truncated == true
        case .geography: breakdowns[Self.key("geo", geoDimension)]?.truncated == true
        case .technology: Self.technologyDimensions.contains { breakdowns[Self.key("tech", $0)]?.truncated == true }
        case .events: events?.truncated == true
        }
    }

    /// What the loading `.task` is keyed on.
    var loadKey: String {
        "\(section.rawValue)|\(range.rawValue)|\(sourceDimension)|\(pagesKind)|\(geoDimension)|\(generation)"
    }
}
