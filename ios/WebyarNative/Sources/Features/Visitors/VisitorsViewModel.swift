import Foundation
import Observation

/// A country the list can be narrowed to.
struct VisitorCountry: Identifiable, Hashable, Sendable {
    let code: String
    let name: String
    var id: String { code }
}

/// One step of a visit, for the page-history timeline: where they came in,
/// the pages in between, where they are now.
struct VisitStep: Identifiable, Hashable, Sendable {
    enum Kind: Sendable, Hashable { case entry, journey, current }

    let id: Int
    let kind: Kind
    let url: String?
    let title: String?
    let at: Date?
}

/// The web console's Visitors page, for the phone: who is on the site now,
/// where they are and what they are reading, with the same filters, numbers,
/// page history and map as the web and the desktop apps.
///
/// It refreshes by polling — the list every five seconds (the web's default
/// live refresh), the map every ten — and only while somebody is looking:
/// the screen runs `poll` from a `.task` keyed on the tab being on screen and
/// the app being in front (`SyncCoordinator.isForeground`), so SwiftUI stops
/// it the moment either is no longer true. Nothing here polls behind the
/// operator's back, which is the rule the rest of the app keeps too.
///
/// The realtime visitors channel is deliberately not joined. Its publications
/// carry nothing but "look again", which a five-second poll already does, and
/// a second socket for one screen is a cost with nothing to show for it.
@MainActor
@Observable
final class VisitorsViewModel {

    enum Phase: Equatable, Sendable {
        case loading
        case loaded
        /// The first read failed and there is nothing to show.
        case failed
    }

    // MARK: List

    /// Everyone the server returned, most recent activity first.
    private(set) var visitors: [LiveVisitor] = []
    private(set) var phase: Phase = .loading
    /// When the list last arrived: the "2m ago" lines count from it, so they
    /// tick forward with each refresh rather than on every redraw.
    private(set) var now = Date()
    private(set) var includeOffline = false

    var search = ""
    var onlineOnly = false
    var chatOnly = false
    /// A country code, or nil for every country.
    var country: String?

    // MARK: Map

    /// The map endpoint's markers; nil until it has answered once.
    private(set) var map: VisitorMap?

    // MARK: Detail

    /// The page history of the visitor whose page is open, by session id.
    private(set) var history: [VisitStep]?
    private(set) var historyLoading = false
    /// The last copy of each visitor seen, so a page opened on somebody who
    /// has since dropped off the list still has something to show.
    @ObservationIgnored private var lastSeen: [String: LiveVisitor] = [:]
    private(set) var chatBusy = false
    var chatFailed = false

    // MARK: Bookkeeping

    @ObservationIgnored private let api: any WebyarAPI
    @ObservationIgnored private var workspaceID: String?
    /// Every list read is numbered; an answer older than the one already on
    /// screen is dropped. A pull-to-refresh and the timer can both be out at
    /// once, and the slower one must not put an older list back.
    @ObservationIgnored private var listSerial = 0
    @ObservationIgnored private var appliedListSerial = 0
    @ObservationIgnored private var mapSerial = 0
    @ObservationIgnored private var appliedMapSerial = 0
    @ObservationIgnored private var historySerial = 0

    static let listInterval: Duration = .seconds(5)
    static let mapInterval: Duration = .seconds(10)

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    // MARK: - Workspace

    /// Another workspace: nothing of the last one carries over — not its
    /// visitors, not its filters, not the page that was open.
    func use(workspaceID: String?) {
        guard workspaceID != self.workspaceID else { return }
        self.workspaceID = workspaceID
        visitors = []
        phase = .loading
        search = ""
        onlineOnly = false
        chatOnly = false
        country = nil
        map = nil
        history = nil
        historyLoading = false
        lastSeen = [:]
        chatBusy = false
        chatFailed = false
        // Anything still out belongs to the old workspace.
        listSerial += 1
        appliedListSerial = listSerial
        mapSerial += 1
        appliedMapSerial = mapSerial
        historySerial += 1
    }

    // MARK: - Loading

    /// Reads the list until the calling task is cancelled.
    func poll(workspaceID: String, appState: AppState) async {
        use(workspaceID: workspaceID)
        while !Task.isCancelled {
            guard await refresh(workspaceID: workspaceID, appState: appState) else { return }
            try? await Task.sleep(for: Self.listInterval)
        }
    }

    /// Reads the map until the calling task is cancelled.
    func pollMap(workspaceID: String, appState: AppState) async {
        use(workspaceID: workspaceID)
        while !Task.isCancelled {
            guard await refreshMap(workspaceID: workspaceID, appState: appState) else { return }
            try? await Task.sleep(for: Self.mapInterval)
        }
    }

    /// One read of the list. Returns false once the session is gone, so a
    /// polling loop stops rather than asking again with a dead token.
    @discardableResult
    func refresh(workspaceID: String, appState: AppState) async -> Bool {
        use(workspaceID: workspaceID)
        listSerial += 1
        let serial = listSerial
        let offline = includeOffline
        do {
            let list = try await api.liveVisitors(workspaceID: workspaceID, includeOffline: offline)
            guard serial > appliedListSerial, self.workspaceID == workspaceID, includeOffline == offline else { return true }
            appliedListSerial = serial
            visitors = Self.sorted(list)
            for visitor in visitors { lastSeen[visitor.id] = visitor }
            now = Date()
            phase = .loaded
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
            return false
        } catch {
            // A failed tick keeps the list on screen; only a list that never
            // arrived becomes an error. A cancelled read — the tab going
            // away — is neither.
            guard !Task.isCancelled, self.workspaceID == workspaceID else { return true }
            if phase != .loaded { phase = .failed }
        }
        return true
    }

    @discardableResult
    func refreshMap(workspaceID: String, appState: AppState) async -> Bool {
        use(workspaceID: workspaceID)
        mapSerial += 1
        let serial = mapSerial
        do {
            let fresh = try await api.visitorMap(workspaceID: workspaceID)
            guard serial > appliedMapSerial, self.workspaceID == workspaceID else { return true }
            appliedMapSerial = serial
            map = fresh
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
            return false
        } catch {
            // The map falls back to the list's own coordinates.
        }
        return true
    }

    /// Turning "include offline" on or off asks again straight away, rather
    /// than leaving the switch looking broken for up to five seconds.
    func setIncludeOffline(_ on: Bool, workspaceID: String?, appState: AppState) async {
        guard on != includeOffline else { return }
        includeOffline = on
        guard let workspaceID else { return }
        await refresh(workspaceID: workspaceID, appState: appState)
    }

    /// Most recent activity first; ties keep the server's order, so rows
    /// with the same timestamp do not swap places on every refresh.
    static func sorted(_ list: [LiveVisitor]) -> [LiveVisitor] {
        list.enumerated().sorted { a, b in
            let x = a.element.lastActivityAt ?? .distantPast
            let y = b.element.lastActivityAt ?? .distantPast
            return x != y ? x > y : a.offset < b.offset
        }
        .map(\.element)
    }

    // MARK: - What shows

    /// The list with the search and the filters applied.
    ///
    /// `name` is how the screen names a visitor, so searching finds the words
    /// the operator can actually see on the row.
    func visible(name: (LiveVisitor) -> String) -> [LiveVisitor] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return visitors.filter { visitor in
            if onlineOnly, visitor.presence != .online { return false }
            if chatOnly, visitor.conversation == nil { return false }
            if let country, visitor.geo?.countryCode != country { return false }
            guard !query.isEmpty else { return true }
            let fields: [String?] = [
                visitor.currentPage, visitor.geo?.country, visitor.geo?.city, visitor.browser,
                visitor.os, visitor.contact?.name, visitor.contact?.email, name(visitor),
            ]
            return fields.contains { $0?.localizedCaseInsensitiveContains(query) == true }
        }
    }

    /// Any filter narrowing the list, search aside.
    var isFiltered: Bool { onlineOnly || chatOnly || country != nil }

    func clearFilters() {
        onlineOnly = false
        chatOnly = false
        country = nil
        search = ""
    }

    var onlineCount: Int { visitors.filter { $0.presence == .online }.count }
    var activeCount: Int { visitors.filter { $0.presence != .offline }.count }
    var countryCount: Int { Set(visitors.compactMap { Self.nonEmpty($0.geo?.countryCode) }).count }
    var pageCount: Int { Set(visitors.compactMap { Self.nonEmpty($0.currentPage) }).count }

    /// The countries on the list, by name, for the country filter. The one
    /// already chosen stays choosable while nobody from it is on the site, so
    /// the filter never silently changes under the operator.
    var countries: [VisitorCountry] {
        var seen = Set<String>()
        var out: [VisitorCountry] = []
        for visitor in visitors {
            guard let code = Self.nonEmpty(visitor.geo?.countryCode), !seen.contains(code) else { continue }
            seen.insert(code)
            out.append(VisitorCountry(code: code, name: Self.nonEmpty(visitor.geo?.country) ?? code))
        }
        if let country, !seen.contains(country) { out.append(VisitorCountry(code: country, name: country)) }
        return out.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    /// The map's markers: the map endpoint's, or — until it answers — each
    /// listed visitor's own coordinates, so the map is never blank while the
    /// list is not.
    var markers: [VisitorMapMarker] {
        map?.markers ?? visitors.compactMap(VisitorMapMarker.init(visitor:))
    }

    /// How many are on the site but could not be put on the map.
    var unplacedCount: Int {
        if let map { return map.withoutLocation }
        return visitors.filter { VisitorMapMarker(visitor: $0) == nil }.count
    }

    /// The visitor as the list has them now, or as they were last seen.
    func visitor(id: String) -> LiveVisitor? {
        visitors.first { $0.id == id } ?? lastSeen[id]
    }

    /// Whether the visitor is still on the live list.
    func isListed(_ id: String) -> Bool {
        visitors.contains { $0.id == id }
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        return value
    }

    // MARK: - Page history

    func loadHistory(sessionID: String, workspaceID: String?, appState: AppState) async {
        historySerial += 1
        let serial = historySerial
        history = nil
        guard let workspaceID else { return }
        historyLoading = true
        do {
            let fetched = try await api.visitorPageHistory(workspaceID: workspaceID, sessionID: sessionID)
            guard serial == historySerial else { return }
            history = Self.steps(fetched)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // The rest of the page stands without it.
            if serial == historySerial { history = [] }
        }
        if serial == historySerial { historyLoading = false }
    }

    /// The visit as a line: the entry point, the pages in between (a page
    /// read twice in a row once), and where they are now.
    static func steps(_ history: VisitorPageHistory) -> [VisitStep] {
        var steps: [VisitStep] = []
        func add(_ kind: VisitStep.Kind, _ url: String?, _ title: String?, _ at: Date?) {
            steps.append(VisitStep(id: steps.count, kind: kind, url: url, title: title, at: at))
        }
        if let entry = history.entry, entry.landingURL != nil || entry.landedAt != nil {
            add(.entry, entry.landingURL, entry.landingTitle, entry.landedAt)
        }
        // The server sends the most recent first; a timeline reads oldest first.
        for page in history.items.reversed() {
            if let last = steps.last, last.url == page.url { continue }
            add(.journey, page.url, page.title, page.viewedAt)
        }
        if let current = history.current {
            if let last = steps.last, last.url == current.url { steps.removeLast() }
            add(.current, current.url, current.title, current.viewedAt)
        }
        return steps
    }

    // MARK: - Chat

    /// The conversation to open for a visitor: the one they are already in,
    /// or a new one — the server hands back an open one rather than start a
    /// second, so a double tap cannot make two.
    func conversationID(for visitor: LiveVisitor, workspaceID: String?, appState: AppState) async -> String? {
        if let existing = visitor.conversation?.id { return existing }
        guard let workspaceID, !chatBusy else { return nil }
        chatBusy = true
        chatFailed = false
        defer { chatBusy = false }
        do {
            let result = try await api.startChatWithVisitor(workspaceID: workspaceID, sessionID: visitor.id)
            guard let id = result.conversationID, !id.isEmpty else {
                chatFailed = true
                return nil
            }
            return id
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            chatFailed = true
        }
        return nil
    }
}

// MARK: - Wording that needs no language

/// The parts of how a visitor is described that are the same in every
/// language — kept apart from the views so they can be tested.
enum VisitorText {
    /// City, then — for Iran, where the province is what people say — the
    /// region, then the country. Nil when none of it is known.
    static func location(_ geo: VisitorGeo?, separator: String = ", ") -> String? {
        guard let geo else { return nil }
        let region = geo.countryCode?.uppercased() == "IR" && geo.region != geo.city ? geo.region : nil
        var parts: [String] = []
        for part in [geo.city, region, geo.country] {
            guard let part = part?.trimmingCharacters(in: .whitespaces), !part.isEmpty, !parts.contains(part) else { continue }
            parts.append(part)
        }
        return parts.isEmpty ? nil : parts.joined(separator: separator)
    }

    /// `host/path` without the scheme, as a line fits it. Persian slugs
    /// arrive percent-encoded; people read them decoded.
    static func shortURL(_ url: String?) -> String {
        guard let url = url?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty else { return "" }
        if let parts = URLComponents(string: url), let scheme = parts.scheme, !scheme.isEmpty,
           let host = parts.host, !host.isEmpty {
            var path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
            if let query = parts.percentEncodedQuery { path += "?" + query }
            let decoded = path.removingPercentEncoding ?? path
            return decoded == "/" ? host : host + decoded
        }
        // Not parseable as it is (an unencoded Persian address): the scheme
        // comes off by hand.
        var rest = url
        for prefix in ["https://", "http://"] where rest.lowercased().hasPrefix(prefix) {
            rest = String(rest.dropFirst(prefix.count))
            break
        }
        if rest.hasSuffix("/"), rest.filter({ $0 == "/" }).count == 1 { rest.removeLast() }
        return rest.removingPercentEncoding ?? rest
    }

    /// The short code the web gives a visitor who never gave a name.
    ///
    /// `server/services/widget/anonymousContact.ts` `anonCodeFrom`: base 36 of
    /// a ×31 hash, the last four characters — so a visitor reads the same
    /// here as on the web and the desktop apps.
    static func legacyCode(_ seed: String) -> String {
        var hash: UInt32 = 0
        for unit in seed.utf16 { hash = hash &* 31 &+ UInt32(unit) }
        let digits = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        var out: [Character] = []
        repeat {
            out.insert(digits[Int(hash % 36)], at: 0)
            hash /= 36
        } while hash > 0
        while out.count < 4 { out.insert("0", at: 0) }
        return String(out.suffix(4))
    }

    /// The code shown for a visitor: the widget's own, else the web's derived
    /// one, so two anonymous visitors are still told apart.
    static func code(_ visitor: LiveVisitor) -> String {
        if let code = visitor.contact?.code?.trimmingCharacters(in: .whitespaces), !code.isEmpty { return code }
        return legacyCode(visitor.contact?.id ?? visitor.id)
    }

    /// Minutes and hours since, as whole numbers: `(0, 0)` is "just now".
    static func elapsed(since date: Date, now: Date) -> (minutes: Int, hours: Int) {
        let seconds = max(0, now.timeIntervalSince(date))
        return (Int(seconds / 60), Int(seconds / 3600))
    }

    /// A flag emoji for an ISO country code, or nil for anything that is not one.
    static func flag(_ code: String?) -> String? {
        let letters = (code ?? "").trimmingCharacters(in: .whitespaces).uppercased()
        guard letters.count == 2, letters.unicodeScalars.allSatisfy({ ("A"..."Z").contains($0) }) else { return nil }
        var scalars = String.UnicodeScalarView()
        for letter in letters.unicodeScalars {
            guard let scalar = Unicode.Scalar(0x1F1E6 + letter.value - 65) else { return nil }
            scalars.append(scalar)
        }
        return String(scalars)
    }
}

extension String {
    /// A copy template with its `{name}` placeholder filled in — the shape the
    /// few strings that carry a number use, so the copy itself stays a plain
    /// literal in every language.
    func filling(_ placeholder: String, with value: String) -> String {
        replacingOccurrences(of: "{\(placeholder)}", with: value)
    }
}
