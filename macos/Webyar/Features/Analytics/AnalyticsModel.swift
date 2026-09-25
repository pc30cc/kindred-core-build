import Foundation
import Observation

/// The website analytics' pages, in the order the list shows them.
enum AnalyticsSection: String, CaseIterable, Identifiable, Sendable {
    case overview, sources, pages, geography, technology, events
    var id: String { rawValue }

    var titleKey: String {
        switch self {
        case .overview: return "waOverview"
        case .sources: return "waSources"
        case .pages: return "waPages"
        case .geography: return "waGeography"
        case .technology: return "waTechnology"
        case .events: return "waEvents"
        }
    }

    var hintKey: String { titleKey + "Hint" }

    var icon: String {
        switch self {
        case .overview: return "chart.xyaxis.line"
        case .sources: return "arrow.triangle.branch"
        case .pages: return "doc.text"
        case .geography: return "globe.europe.africa"
        case .technology: return "laptopcomputer.and.iphone"
        case .events: return "cursorarrow.click.2"
        }
    }
}

/// The date range every report shares: the last 7, 28 or 90 days, today included.
enum AnalyticsRange: Int, CaseIterable, Identifiable, Sendable {
    case week = 7, month = 28, quarter = 90
    var id: Int { rawValue }

    /// YYYY-MM-DD bounds, in UTC as the server counts days.
    var bounds: (start: String, end: String) { bounds(endingDaysAgo: 0) }

    /// The same number of days just before, for "compared with the period before".
    var previousBounds: (start: String, end: String) { bounds(endingDaysAgo: rawValue) }

    private func bounds(endingDaysAgo offset: Int) -> (start: String, end: String) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let end = cal.date(byAdding: .day, value: -offset, to: Date()) ?? Date()
        let start = cal.date(byAdding: .day, value: -(rawValue - 1), to: end) ?? end
        let f = DateFormatter()
        f.calendar = cal
        f.timeZone = cal.timeZone
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return (f.string(from: start), f.string(from: end))
    }
}

/// Website analytics, as the web console's SEO → Web Analytics reads it: the
/// visits the chat widget's snippet already records, over a shared date range.
/// Owners and admins whose plan has the `web_analytics` module see it; the
/// server checks the same module on every report.
@MainActor
@Observable
final class AnalyticsModel {
    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var livePoller: Poller?
    @ObservationIgnored private var viewers = 0
    /// Bumped by every range change, so a slow answer for the old range is dropped.
    @ObservationIgnored private var generation = 0

    var section: AnalyticsSection = .overview { didSet { if section != oldValue { load() } } }
    private(set) var range: AnalyticsRange = .month

    /// The report's dimension on each page that has several.
    var sourceDimension = "channel" { didSet { if sourceDimension != oldValue { load() } } }
    var pagesKind = "top" { didSet { if pagesKind != oldValue { load() } } }
    var geoDimension = "country" { didSet { if geoDimension != oldValue { load() } } }

    private(set) var overview: WebAnalyticsOverview?
    /// The same report for the days just before the range, for the headline numbers' change.
    private(set) var previous: WebAnalyticsOverview?
    /// Report rows by "report.dimension", for the range on show.
    private(set) var breakdowns: [String: WebAnalyticsRows<WebAnalyticsRow>] = [:]
    private(set) var pageLists: [String: WebAnalyticsRows<WebAnalyticsPage>] = [:]
    private(set) var events: WebAnalyticsRows<WebAnalyticsEvent>?
    /// Visitors on the site right now.
    private(set) var live: Int?

    private(set) var loading: Set<String> = []
    private(set) var error: String?
    /// The server says the plan does not include web analytics (it may have changed since the sidebar last looked).
    private(set) var locked = false

    init(app: AppModel) {
        self.app = app
        #if DEBUG
        Self.debugCurrent = self
        #endif
    }

    #if DEBUG
    /// The analytics on show, for the debug command file.
    nonisolated(unsafe) static weak var debugCurrent: AnalyticsModel?
    #endif

    // MARK: Showing

    func appear() {
        viewers += 1
        guard viewers == 1 else { return }
        livePoller = Poller("live visitors", interval: { 30 }) { [weak self] in try await self?.loadLive() }
        livePoller?.start()
        load()
    }

    func disappear() {
        viewers = max(0, viewers - 1)
        if viewers == 0 { stop() }
    }

    func stop() {
        viewers = 0
        livePoller?.stop()
        livePoller = nil
    }

    func setRange(_ r: AnalyticsRange) {
        guard r != range else { return }
        range = r
        generation += 1
        overview = nil
        previous = nil
        breakdowns = [:]
        pageLists = [:]
        events = nil
        load()
    }

    /// Asks again for everything on show.
    func refresh() {
        generation += 1
        overview = nil
        previous = nil
        breakdowns = [:]
        pageLists = [:]
        events = nil
        load()
        livePoller?.kick()
    }

    // MARK: Loading

    /// What the page on show needs, unless already here for this range.
    func load() {
        switch section {
        case .overview:
            if overview == nil {
                fetch("overview", { api, ws, a, b in try await api.analyticsOverview(workspaceId: ws, start: a, end: b) }) { self.overview = $0 }
            }
            if previous == nil {
                let (a, b) = range.previousBounds
                fetch("overview.previous", quiet: true, { api, ws, _, _ in try await api.analyticsOverview(workspaceId: ws, start: a, end: b) }) { self.previous = $0 }
            }
        case .sources:
            let key = "sources.\(sourceDimension)", dim = sourceDimension
            if breakdowns[key] == nil {
                fetch(key, { api, ws, a, b in try await api.analyticsTrafficSources(workspaceId: ws, dimension: dim, start: a, end: b) }) { self.breakdowns[key] = $0 }
            }
        case .pages:
            let key = "pages.\(pagesKind)", kind = pagesKind
            if pageLists[key] == nil {
                fetch(key, { api, ws, a, b in try await api.analyticsPages(workspaceId: ws, kind: kind, start: a, end: b) }) { self.pageLists[key] = $0 }
            }
        case .geography:
            let key = "geo.\(geoDimension)", dim = geoDimension
            if breakdowns[key] == nil {
                fetch(key, { api, ws, a, b in try await api.analyticsGeography(workspaceId: ws, dimension: dim, start: a, end: b) }) { self.breakdowns[key] = $0 }
            }
        case .technology:
            for dim in ["device", "os", "browser"] {
                let key = "tech.\(dim)"
                if breakdowns[key] == nil {
                    fetch(key, { api, ws, a, b in try await api.analyticsTechnology(workspaceId: ws, dimension: dim, start: a, end: b) }) { self.breakdowns[key] = $0 }
                }
            }
        case .events:
            if events == nil {
                fetch("events", { api, ws, a, b in try await api.analyticsEvents(workspaceId: ws, start: a, end: b) }) { self.events = $0 }
            }
        }
    }

    func isLoading(_ key: String) -> Bool { loading.contains(key) }

    /// One report for the range on show; its answer is kept only if the range is still the same.
    /// A `quiet` report is only an extra: when it fails the page shows without it.
    private func fetch<T>(_ key: String,
                          quiet: Bool = false,
                          _ request: @escaping (WebyarAPI, String, String, String) async throws -> T,
                          apply: @escaping (T) -> Void) {
        guard let ws = app.workspace, !loading.contains(key) else { return }
        let gen = generation
        let (start, end) = range.bounds
        let api = app.api
        loading.insert(key)
        if !quiet { error = nil }
        Task {
            defer { if gen == generation { loading.remove(key) } }
            do {
                let value = try await request(api, ws.id, start, end)
                guard gen == generation else { return }
                apply(value)
                locked = false
            } catch let e as ApiError where e.status == 403 {
                guard gen == generation, !quiet else { return }
                // The plan no longer carries it: say so, and have the sidebar look again.
                locked = true
                Task { await app.loadPlan() }
            } catch {
                guard gen == generation, !quiet, !(error is CancellationError) else { return }
                Log.error("web analytics \(key)", error)
                self.error = ErrorText.of(error, app.strings)
            }
        }
    }

    private func loadLive() async throws {
        guard let ws = app.workspace else { return }
        live = try await app.api.analyticsLiveVisitors(workspaceId: ws.id)
    }
}
