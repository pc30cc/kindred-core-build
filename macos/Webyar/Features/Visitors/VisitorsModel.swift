import AppKit
import Foundation
import Observation

/// The web console's Visitors page, as the Windows app's VisitorsPage: who is
/// on the site now, where they are and what they are reading, with the same
/// filters, numbers, details and page history, and a map. Polls every five
/// seconds (the web's default live refresh), the map every ten; a nudge on
/// the realtime visitors channel refreshes at once.
@MainActor
@Observable
final class VisitorsModel {
    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var poller: Poller?
    @ObservationIgnored private var mapPoller: Poller?
    @ObservationIgnored private var events: Signal<JSONValue>.Token?
    @ObservationIgnored private var historyGeneration = 0
    @ObservationIgnored private var mapConfigured = false
    @ObservationIgnored private var workspaceId: String?
    @ObservationIgnored private var tokens = 0

    // MARK: List

    /// Everyone the server returned, newest activity first.
    private(set) var visitors: [LiveVisitor] = []
    private(set) var loading = true
    /// The first load failed and there is nothing to show.
    private(set) var failed = false
    /// When the list was last loaded: the "2m ago" lines count from it.
    private(set) var now = Date()
    private(set) var includeOffline = false

    var search = ""
    var onlineOnly = false
    var chatOnly = false
    /// A country code, or nil for all countries.
    var country: String?

    // MARK: Selection

    private(set) var selectedId: String?
    /// The selected visitor as last seen (kept when they drop off the list).
    private(set) var selected: LiveVisitor?
    private(set) var history: [VisitStep]?
    private(set) var historyLoading = false
    private(set) var chatBusy = false
    var chatError: String?
    private(set) var copied = false
    /// Ask the list to scroll a row into view (a marker was clicked).
    private(set) var reveal: VisitorReveal?

    // MARK: Map

    /// Markers from /api/visitor-intel/map; nil until they arrive.
    private(set) var pins: [VisitorPin]?
    /// The map is switched off for this workspace (map-config says `enabled: false`).
    private(set) var mapDisabled = false
    /// map-config's default_center.
    private(set) var mapCenter: VisitorMapCenter?
    /// Fly the map to the selected visitor.
    private(set) var focus: VisitorMapFocus?

    init(app: AppModel) {
        self.app = app
    }

    /// Starts on the page's first appearance; again after `stop()` when the page comes back.
    func start() {
        guard poller == nil else { return }
        if workspaceId != app.workspace?.id { reset() }
        workspaceId = app.workspace?.id
        poller = Poller("visitors", interval: { 5 }) { [weak self] in try await self?.load() }
        poller?.start()
        if !mapDisabled {
            mapPoller = Poller("visitors map", interval: { 10 }) { [weak self] in try await self?.loadMap() }
            mapPoller?.start()
        }
        app.realtime?.wantsVisitors = true
        events = app.visitorEvents.subscribe { [weak self] _ in self?.poller?.kick() }
    }

    func stop() {
        poller?.stop()
        poller = nil
        mapPoller?.stop()
        mapPoller = nil
        events?.cancelNow()
        events = nil
        app.realtime?.wantsVisitors = false
    }

    func refresh() {
        poller?.kick()
        mapPoller?.kick()
    }

    func setIncludeOffline(_ on: Bool) {
        guard on != includeOffline else { return }
        includeOffline = on
        poller?.kick()
    }

    /// Another workspace: nothing of the last one carries over.
    private func reset() {
        visitors = []
        loading = true
        failed = false
        search = ""
        onlineOnly = false
        chatOnly = false
        country = nil
        closeDetail()
        pins = nil
        mapDisabled = false
        mapCenter = nil
        mapConfigured = false
    }

    // MARK: Data

    private func load() async throws {
        guard let ws = app.workspace else { return }
        let list: [LiveVisitor]
        do {
            list = try await app.api.liveVisitors(workspaceId: ws.id, includeOffline: includeOffline)
        } catch {
            if visitors.isEmpty && !(error is CancellationError) {
                loading = false
                failed = true
            }
            throw error
        }
        guard app.workspace?.id == ws.id else { return }
        // Newest activity first; ties keep the server's order.
        visitors = list.enumerated().sorted { a, b in
            let x = a.element.lastActivityAt ?? .distantPast, y = b.element.lastActivityAt ?? .distantPast
            return x != y ? x > y : a.offset < b.offset
        }.map(\.element)
        now = Date()
        loading = false
        failed = false
        if let id = selectedId, let v = visitors.first(where: { $0.id == id }) { selected = v }
        app.visitorsOnline = onlineCount
    }

    private func loadMap() async throws {
        guard let ws = app.workspace else { return }
        if !mapConfigured {
            let config = try await app.api.visitorMapConfig(workspaceId: ws.id)
            guard app.workspace?.id == ws.id else { return }
            if config["enabled"]?.bool == false {
                mapDisabled = true
                mapPoller?.stop()
                mapPoller = nil
                return
            }
            if let c = config["default_center"], let lat = c["lat"]?.double, let lng = c["lng"]?.double {
                mapCenter = VisitorMapCenter(lat: lat, lng: lng, zoom: c["zoom"]?.double ?? 3)
            }
            mapConfigured = true
        }
        let map = try await app.api.visitorMap(workspaceId: ws.id)
        guard app.workspace?.id == ws.id else { return }
        if let markers = map["markers"]?.array {
            pins = markers.compactMap { VisitorPin(json: $0) }
        }
    }

    // MARK: What shows

    /// The list on show: search, the online and conversation toggles, the country.
    var visible: [LiveVisitor] {
        let q = search.trimmingCharacters(in: .whitespaces)
        let s = app.strings
        let wantOnline = self.onlineOnly, wantChat = self.chatOnly, wantCountry = self.country
        return visitors.filter { v in
            guard VisitorText.matches(v, q, s) else { return false }
            if wantOnline && VisitorText.status(v) != "online" { return false }
            if wantChat && v.conversation == nil { return false }
            if let wantCountry, v.geo?.countryCode != wantCountry { return false }
            return true
        }
    }

    var onlineCount: Int { visitors.filter { VisitorText.status($0) == "online" }.count }
    var activeCount: Int { visitors.filter { VisitorText.status($0) != "offline" }.count }
    var countryCount: Int { Set(visitors.compactMap { $0.geo?.countryCode }.filter { !$0.isEmpty }).count }
    var pageCount: Int { Set(visitors.compactMap(\.currentPage).filter { !$0.isEmpty }).count }

    /// The countries in the list, by name, for the country filter.
    var countries: [VisitorCountry] {
        var seen = Set<String>()
        var out: [VisitorCountry] = []
        for v in visitors {
            guard let code = v.geo?.countryCode, !code.isEmpty, !seen.contains(code) else { continue }
            seen.insert(code)
            let name = v.geo?.country ?? ""
            out.append(VisitorCountry(code: code, name: name.isEmpty ? code : name, sortKey: name))
        }
        // The chosen country stays choosable while nobody from it is on the site.
        if let country, !seen.contains(country) { out.append(VisitorCountry(code: country, name: country, sortKey: country)) }
        return out.sorted { $0.sortKey.localizedCompare($1.sortKey) == .orderedAscending }
    }

    /// The map's markers: the map endpoint's, else each visitor's own coordinates until they arrive.
    var mapPins: [VisitorPin] {
        if let pins { return pins }
        return visitors.compactMap { VisitorPin(visitor: $0) }
    }

    // MARK: Selection

    func select(_ id: String?) {
        guard let id, id != selectedId, let v = visitors.first(where: { $0.id == id }) else { return }
        selectedId = id
        selected = v
        copied = false
        loadHistory(id)
        if let lat = v.geo?.latitude, let lng = v.geo?.longitude {
            tokens += 1
            focus = VisitorMapFocus(lat: lat, lng: lng, token: tokens)
        }
    }

    func closeDetail() {
        selectedId = nil
        selected = nil
        history = nil
        historyLoading = false
        historyGeneration += 1
        copied = false
    }

    /// A marker was clicked: show that visitor, clearing the filters if they hide them.
    func selectFromMap(_ id: String) {
        guard visitors.contains(where: { $0.id == id }) else { return }
        if !visible.contains(where: { $0.id == id }) {
            search = ""
            onlineOnly = false
            chatOnly = false
            country = nil
        }
        select(id)
        tokens += 1
        reveal = VisitorReveal(id: id, token: tokens)
    }

    private func loadHistory(_ sessionId: String) {
        historyGeneration += 1
        let generation = historyGeneration
        history = nil
        guard let ws = app.workspace else { return }
        historyLoading = true
        let s = app.strings
        Task { [weak self] in
            guard let self else { return }
            do {
                let h = try await self.app.api.pageHistory(workspaceId: ws.id, sessionId: sessionId)
                guard generation == self.historyGeneration else { return }
                self.history = VisitorText.steps(h, s)
            } catch {
                Log.error("page history", error)
            }
            if generation == self.historyGeneration { self.historyLoading = false }
        }
    }

    /// Opens the visitor's conversation, starting one when there is none (the server reuses an open one).
    func chat(with visitor: LiveVisitor) {
        guard let ws = app.workspace, !chatBusy else { return }
        chatBusy = true
        Task { [weak self] in
            guard let self else { return }
            do {
                var id = visitor.conversation?.id
                if id == nil {
                    id = try await self.app.api.startChatWithVisitor(workspaceId: ws.id, sessionId: visitor.id).conversationId
                }
                self.chatBusy = false
                if let id { self.app.openConversation(id) }
            } catch {
                Log.error("start chat", error)
                self.chatBusy = false
                self.chatError = ErrorText.of(error, self.app.strings)
            }
        }
    }

    func copySession(_ id: String? = nil) {
        guard let id = id ?? selectedId else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(id, forType: .string)
        if id == selectedId { copied = true }
    }
}

// MARK: - Values

struct VisitorCountry: Identifiable, Hashable {
    let code: String
    let name: String
    let sortKey: String
    var id: String { code }
}

/// One step of the visit: where they came in, where they went, where they are.
struct VisitStep: Identifiable, Hashable {
    let id: Int
    let label: String
    let url: String?
    let title: String?
    let when: Date?
    let current: Bool
}

struct VisitorMapCenter: Equatable {
    let lat: Double
    let lng: Double
    let zoom: Double
}

struct VisitorMapFocus: Equatable {
    let lat: Double
    let lng: Double
    let token: Int
}

struct VisitorReveal: Equatable {
    let id: String
    let token: Int
}

/// A dot on the map.
struct VisitorPin: Identifiable, Equatable {
    let id: String
    let lat: Double
    let lng: Double
    let status: String
    let place: String
    let page: String

    /// A marker from /api/visitor-intel/map.
    init?(json m: JSONValue) {
        guard let lat = m["lat"]?.double, let lng = m["lng"]?.double else { return nil }
        self.lat = lat
        self.lng = lng
        id = m["id"]?.string ?? m["id"]?.int.map { String($0) } ?? "\(lat),\(lng)"
        status = m["status"]?.string ?? "unknown"
        place = [m["city"]?.text, m["country"]?.text].compactMap { $0 }.joined(separator: ", ")
        page = m["current_page"]?.text ?? ""
    }

    /// A visitor's own coordinates, while the map endpoint has not answered.
    init?(visitor v: LiveVisitor) {
        guard let lat = v.geo?.latitude, let lng = v.geo?.longitude else { return nil }
        id = v.id
        self.lat = lat
        self.lng = lng
        status = VisitorText.status(v)
        place = [v.geo?.city, v.geo?.country].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
        page = v.currentPage ?? ""
    }

    var tooltip: String {
        [place, page].filter { !$0.isEmpty }.joined(separator: "\n")
    }
}

// MARK: - Wording

/// The visitors page's wording, as on the web (the Windows app's VisitorText).
enum VisitorText {
    static func name(_ v: LiveVisitor, _ s: Strings) -> String {
        Display.visitorName(name: v.contact?.name, code: v.contact?.code, fallbackId: v.contact?.id ?? v.id,
                            city: v.geo?.city, region: v.geo?.region, countryCode: v.geo?.countryCode, s)
    }

    /// "online", "idle" or "offline".
    static func status(_ v: LiveVisitor) -> String {
        switch v.status ?? "" {
        case "online": return "online"
        case "idle": return "idle"
        default: return "offline"
        }
    }

    /// City, the province for Iran, country.
    static func location(_ g: VisitorGeoInfo?) -> String? {
        guard let g else { return nil }
        var region: String?
        if let r = g.region, r != g.city, g.countryCode == "IR" { region = r }
        var parts: [String] = []
        for p in [g.city, region, g.country] {
            guard let p, !p.trimmingCharacters(in: .whitespaces).isEmpty, !parts.contains(p) else { continue }
            parts.append(p)
        }
        return parts.isEmpty ? nil : parts.joined(separator: "، ")
    }

    static func ago(_ at: Date, now: Date, _ s: Strings) -> String {
        let sec = max(0, now.timeIntervalSince(at))
        if sec < 60 { return s["visitorsJustNow"] }
        if sec < 3600 { return s.get("visitorsMinutesAgo", "n", Int(sec / 60)) }
        return s.get("visitorsHoursAgo", "n", Int(sec / 3600))
    }

    /// host/path without the scheme, as a line fits it. Persian slugs arrive
    /// percent-encoded; people read them decoded.
    static func shortUrl(_ url: String?) -> String {
        guard let url = url?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty else { return "" }
        if let c = URLComponents(string: url), let scheme = c.scheme, !scheme.isEmpty, let host = c.host, !host.isEmpty {
            var path = c.percentEncodedPath.isEmpty ? "/" : c.percentEncodedPath
            if let q = c.percentEncodedQuery { path += "?" + q }
            let decoded = path.removingPercentEncoding ?? path
            return decoded == "/" ? host : host + decoded
        }
        // Not parseable as is (unencoded Persian, say): drop the scheme by hand.
        var rest = url
        for prefix in ["https://", "http://"] where rest.lowercased().hasPrefix(prefix) {
            rest = String(rest.dropFirst(prefix.count))
            if rest.hasSuffix("/"), rest.filter({ $0 == "/" }).count == 1 { rest.removeLast() }
            break
        }
        return rest.removingPercentEncoding ?? rest
    }

    static func matches(_ v: LiveVisitor, _ q: String, _ s: Strings) -> Bool {
        guard !q.isEmpty else { return true }
        let fields: [String?] = [v.currentPage, v.geo?.country, v.geo?.city, v.browser, v.contact?.name, v.contact?.email]
        if fields.contains(where: { $0?.localizedCaseInsensitiveContains(q) == true }) { return true }
        return name(v, s).localizedCaseInsensitiveContains(q)
    }

    /// The visit on a line: the entry point, the pages in between (a page
    /// read twice in a row once), and where they are now.
    static func steps(_ h: PageHistory, _ s: Strings) -> [VisitStep] {
        var steps: [VisitStep] = []
        func add(_ label: String, _ url: String?, _ title: String?, _ when: Date?, _ current: Bool) {
            steps.append(VisitStep(id: steps.count, label: label, url: url, title: title, when: when, current: current))
        }
        if let e = h.entry { add(s["visitorEntryPoint"], e.landingUrl, e.landingTitle, e.landedAt, false) }
        for p in (h.items ?? []).reversed() {
            if let last = steps.last, last.url == p.url { continue }
            add(s["visitorJourney"], p.url, p.title, p.viewedAt, false)
        }
        if let cur = h.current {
            if let last = steps.last, last.url == cur.url { steps.removeLast() }
            add(s["visitorCurrentlyOn"], cur.url, cur.title, cur.viewedAt, true)
        }
        return steps
    }
}
