import Foundation
import XCTest
@testable import WebyarNative

/// A scripted visitors endpoint: a list per workspace, how long each read
/// takes, and a count of every call.
private actor VisitorsAPI: TestAPIBase {
    var lists: [String: [LiveVisitor]] = [:]
    var listError: APIError?
    var listDelay: UInt64 = 0
    var history = VisitorPageHistory()
    var startResult = StartVisitorChatResult(conversationID: "new-conv", created: true)
    private(set) var listReads: [(workspace: String, offline: Bool)] = []
    private(set) var startCalls = 0

    func set(_ workspace: String, _ list: [LiveVisitor]) { lists[workspace] = list }
    func setError(_ error: APIError?) { listError = error }
    func setDelay(_ nanoseconds: UInt64) { listDelay = nanoseconds }
    func setHistory(_ value: VisitorPageHistory) { history = value }

    func liveVisitors(workspaceID: String, includeOffline: Bool) async throws -> [LiveVisitor] {
        listReads.append((workspaceID, includeOffline))
        let delay = listDelay
        let answer = lists[workspaceID] ?? []
        let error = listError
        if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
        if let error { throw error }
        return includeOffline ? answer : answer.filter { $0.presence != .offline }
    }

    func visitorPageHistory(workspaceID: String, sessionID: String) async throws -> VisitorPageHistory { history }

    func visitorMap(workspaceID: String) async throws -> VisitorMap {
        VisitorMap(markers: (lists[workspaceID] ?? []).compactMap(VisitorMapMarker.init(visitor:)), total: 0, withoutLocation: 1)
    }

    func startChatWithVisitor(workspaceID: String, sessionID: String) async throws -> StartVisitorChatResult {
        startCalls += 1
        return startResult
    }
}

@MainActor
final class VisitorsViewModelTests: XCTestCase {
    private var api: VisitorsAPI!
    private var appState: AppState!

    override func setUp() async throws {
        api = VisitorsAPI()
        appState = AppState(api: api)
    }

    private func visitor(
        _ id: String, _ presence: VisitorPresence = .online, minutesAgo: Double = 0,
        country: String? = nil, page: String? = nil, chat: Bool = false, name: String? = nil
    ) -> LiveVisitor {
        LiveVisitor(
            id: id, presence: presence, currentPage: page,
            lastActivityAt: Date(timeIntervalSince1970: 1_000_000 - minutesAgo * 60),
            geo: country.map { VisitorGeo(country: "Land \($0)", countryCode: $0, city: "City \($0)", latitude: 10, longitude: 20) },
            contact: name.map { VisitorContactRef(id: "c-\(id)", name: $0) },
            conversation: chat ? VisitorConversationRef(id: "conv-\(id)") : nil
        )
    }

    // MARK: - Loading

    func testTheListArrivesMostRecentFirst() async {
        await api.set("w1", [visitor("old", minutesAgo: 9), visitor("new", minutesAgo: 1), visitor("mid", minutesAgo: 4)])
        let vm = VisitorsViewModel(api: api)
        await vm.refresh(workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.phase, .loaded)
        XCTAssertEqual(vm.visitors.map(\.id), ["new", "mid", "old"])
    }

    func testAFailedFirstReadIsTheErrorAndALaterOneKeepsTheList() async {
        await api.setError(.transport)
        let vm = VisitorsViewModel(api: api)
        await vm.refresh(workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.phase, .failed)

        await api.setError(nil)
        await api.set("w1", [visitor("a")])
        await vm.refresh(workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.visitors.map(\.id), ["a"])

        await api.setError(.server(status: 500, message: nil))
        await vm.refresh(workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.phase, .loaded, "a failed tick keeps the list on screen")
        XCTAssertEqual(vm.visitors.map(\.id), ["a"])
    }

    func testASlowAnswerForTheLastWorkspaceIsDropped() async {
        await api.set("w1", [visitor("from-w1")])
        await api.set("w2", [visitor("from-w2")])
        await api.setDelay(200_000_000)
        let vm = VisitorsViewModel(api: api)
        let slow = Task { await vm.refresh(workspaceID: "w1", appState: appState) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        await api.setDelay(0)
        await vm.refresh(workspaceID: "w2", appState: appState)
        _ = await slow.value
        XCTAssertEqual(vm.visitors.map(\.id), ["from-w2"], "never a row of another workspace")
    }

    func testIncludingOfflineAsksAgainAtOnce() async {
        await api.set("w1", [visitor("here"), visitor("gone", .offline)])
        let vm = VisitorsViewModel(api: api)
        await vm.refresh(workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.visitors.map(\.id), ["here"])
        await vm.setIncludeOffline(true, workspaceID: "w1", appState: appState)
        XCTAssertEqual(Set(vm.visitors.map(\.id)), ["here", "gone"])
        let reads = await api.listReads
        XCTAssertEqual(reads.last?.offline, true)
    }

    func testPollingStopsWhenItsTaskIsCancelled() async {
        await api.set("w1", [visitor("a")])
        let vm = VisitorsViewModel(api: api)
        let poller = Task { await vm.poll(workspaceID: "w1", appState: appState) }
        let first = await eventually { vm.phase == .loaded }
        XCTAssertTrue(first)
        poller.cancel()
        await poller.value
        let reads = await api.listReads.count
        try? await Task.sleep(nanoseconds: 100_000_000)
        let after = await api.listReads.count
        XCTAssertEqual(reads, after, "nothing polls once the screen has gone")
    }

    // MARK: - What shows

    func testFiltersAndSearchNarrowTheList() async {
        await api.set("w1", [
            visitor("a", country: "IR", page: "https://s.example/pricing", chat: true),
            visitor("b", .idle, country: "TR", page: "https://s.example/blog"),
            visitor("c", country: "IR", page: "https://s.example/", name: "Sara"),
        ])
        let vm = VisitorsViewModel(api: api)
        await vm.refresh(workspaceID: "w1", appState: appState)
        let name: (LiveVisitor) -> String = { $0.contact?.name ?? "Visitor" }

        vm.onlineOnly = true
        XCTAssertEqual(Set(vm.visible(name: name).map(\.id)), ["a", "c"])
        vm.chatOnly = true
        XCTAssertEqual(vm.visible(name: name).map(\.id), ["a"])
        vm.clearFilters()
        vm.country = "TR"
        XCTAssertEqual(vm.visible(name: name).map(\.id), ["b"])
        vm.clearFilters()
        vm.search = "pricing"
        XCTAssertEqual(vm.visible(name: name).map(\.id), ["a"])
        vm.search = "sara"
        XCTAssertEqual(vm.visible(name: name).map(\.id), ["c"], "the name on the row is searchable")
    }

    func testTheHeadlineNumbers() async {
        await api.set("w1", [
            visitor("a", country: "IR", page: "/x"),
            visitor("b", .idle, country: "TR", page: "/x"),
            visitor("c", .offline, country: "IR", page: "/y"),
        ])
        let vm = VisitorsViewModel(api: api)
        await vm.setIncludeOffline(true, workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.onlineCount, 1)
        XCTAssertEqual(vm.activeCount, 2)
        XCTAssertEqual(vm.countryCount, 2)
        XCTAssertEqual(vm.pageCount, 2)
        XCTAssertEqual(vm.countries.map(\.code), ["IR", "TR"])
    }

    func testAChosenCountryStaysChoosableWhenNobodyFromItIsLeft() async {
        await api.set("w1", [visitor("a", country: "IR")])
        let vm = VisitorsViewModel(api: api)
        await vm.refresh(workspaceID: "w1", appState: appState)
        vm.country = "DE"
        XCTAssertTrue(vm.countries.contains { $0.code == "DE" })
    }

    func testAnotherWorkspaceStartsClean() async {
        await api.set("w1", [visitor("a")])
        let vm = VisitorsViewModel(api: api)
        await vm.refresh(workspaceID: "w1", appState: appState)
        vm.search = "x"
        vm.onlineOnly = true
        vm.use(workspaceID: "w2")
        XCTAssertTrue(vm.visitors.isEmpty)
        XCTAssertEqual(vm.phase, .loading)
        XCTAssertEqual(vm.search, "")
        XCTAssertFalse(vm.onlineOnly)
    }

    func testTheMapFallsBackToTheListsOwnCoordinates() async {
        await api.set("w1", [visitor("a", country: "IR"), visitor("b")])
        let vm = VisitorsViewModel(api: api)
        await vm.refresh(workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.markers.map(\.id), ["a"])
        XCTAssertEqual(vm.unplacedCount, 1)
        await vm.refreshMap(workspaceID: "w1", appState: appState)
        XCTAssertNotNil(vm.map)
    }

    func testAVisitorWhoLeftIsStillThereToRead() async {
        await api.set("w1", [visitor("a")])
        let vm = VisitorsViewModel(api: api)
        await vm.refresh(workspaceID: "w1", appState: appState)
        await api.set("w1", [])
        await vm.refresh(workspaceID: "w1", appState: appState)
        XCTAssertFalse(vm.isListed("a"))
        XCTAssertEqual(vm.visitor(id: "a")?.id, "a")
    }

    // MARK: - Page history

    func testTheVisitReadsAsATimeline() {
        let t = Date(timeIntervalSince1970: 1_000)
        let steps = VisitorsViewModel.steps(VisitorPageHistory(
            items: [
                VisitorPageView(url: "/c", viewedAt: t.addingTimeInterval(30)),
                VisitorPageView(url: "/b", viewedAt: t.addingTimeInterval(20)),
                VisitorPageView(url: "/b", viewedAt: t.addingTimeInterval(10)),
            ],
            entry: VisitorPageEntry(landingURL: "/", landedAt: t),
            current: VisitorPageView(url: "/c", viewedAt: t.addingTimeInterval(30))
        ))
        XCTAssertEqual(steps.map(\.kind), [.entry, .journey, .current])
        XCTAssertEqual(steps.map(\.url), ["/", "/b", "/c"], "a page read twice in a row shows once")
        XCTAssertEqual(steps.map(\.id), [0, 1, 2])
    }

    func testHistoryLoadsForTheVisitorOpened() async {
        await api.setHistory(VisitorPageHistory(current: VisitorPageView(url: "/now")))
        let vm = VisitorsViewModel(api: api)
        await vm.loadHistory(sessionID: "a", workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.history?.map(\.kind), [.current])
        XCTAssertFalse(vm.historyLoading)
    }

    // MARK: - Chat

    func testAVisitorAlreadyInAChatOpensThatChat() async {
        let vm = VisitorsViewModel(api: api)
        let id = await vm.conversationID(for: visitor("a", chat: true), workspaceID: "w1", appState: appState)
        XCTAssertEqual(id, "conv-a")
        let calls = await api.startCalls
        XCTAssertEqual(calls, 0, "no request when the conversation is already known")
    }

    func testAVisitorWithoutAChatGetsOneStarted() async {
        let vm = VisitorsViewModel(api: api)
        let id = await vm.conversationID(for: visitor("a"), workspaceID: "w1", appState: appState)
        XCTAssertEqual(id, "new-conv")
        XCTAssertFalse(vm.chatBusy)
        XCTAssertFalse(vm.chatFailed)
    }

    // MARK: - Wording

    func testAddressesShortenForALine() {
        XCTAssertEqual(VisitorText.shortURL("https://shop.example/"), "shop.example")
        XCTAssertEqual(VisitorText.shortURL("https://shop.example/a?b=1"), "shop.example/a?b=1")
        XCTAssertEqual(
            VisitorText.shortURL("https://s.example/%D8%B3%D9%84%D8%A7%D9%85"), "s.example/سلام",
            "a Persian slug reads decoded"
        )
        XCTAssertEqual(VisitorText.shortURL(nil), "")
    }

    func testLocationsName() {
        XCTAssertEqual(
            VisitorText.location(VisitorGeo(country: "Iran", countryCode: "IR", region: "Isfahan", city: "Kashan")),
            "Kashan, Isfahan, Iran", "in Iran the province is what people say"
        )
        XCTAssertEqual(
            VisitorText.location(VisitorGeo(country: "Germany", countryCode: "DE", region: "Berlin", city: "Berlin")),
            "Berlin, Germany"
        )
        XCTAssertNil(VisitorText.location(VisitorGeo()))
    }

    func testTheAnonymousCodeMatchesTheWebs() {
        XCTAssertEqual(VisitorText.legacyCode("abc").count, 4)
        XCTAssertEqual(VisitorText.legacyCode("abc"), VisitorText.legacyCode("abc"))
        // 'a'·31² + 'b'·31 + 'c' = 96354, which is 22CI in base 36.
        XCTAssertEqual(VisitorText.legacyCode("abc"), "22CI")
    }

    func testTimeAgo() {
        let now = Date(timeIntervalSince1970: 10_000)
        XCTAssertEqual(VisitorFormat.ago(now.addingTimeInterval(-20), now: now, language: .en), Str.visitorsJustNow(.en))
        XCTAssertEqual(VisitorFormat.ago(now.addingTimeInterval(-300), now: now, language: .en), "5m ago")
        XCTAssertEqual(VisitorFormat.ago(now.addingTimeInterval(-7_300), now: now, language: .en), "2h ago")
        XCTAssertFalse(VisitorFormat.ago(now.addingTimeInterval(-300), now: now, language: .fa).contains("{n}"))
    }

    func testFlags() {
        XCTAssertEqual(VisitorText.flag("ir"), "🇮🇷")
        XCTAssertNil(VisitorText.flag("XYZ"))
        XCTAssertNil(VisitorText.flag(nil))
    }
}
