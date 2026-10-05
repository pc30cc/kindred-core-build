import Foundation
import XCTest
@testable import Webyar

/// A scripted analytics endpoint that records each report asked for.
private actor AnalyticsAPI: TestAPIBase {
    private(set) var requests: [String] = []
    var delay: UInt64 = 0
    var error: APIError?
    var sessions = 100

    func setDelay(_ value: UInt64) { delay = value }
    func setError(_ value: APIError?) { error = value }
    func setSessions(_ value: Int) { sessions = value }

    private func answer(_ label: String) async throws {
        requests.append(label)
        let wait = delay
        if wait > 0 { try? await Task.sleep(nanoseconds: wait) }
        if let error { throw error }
    }

    func analyticsOverview(workspaceID: String, range: AnalyticsDateRange) async throws -> WebAnalyticsOverview {
        let asked = sessions
        try await answer("overview \(range.start)…\(range.end)")
        return WebAnalyticsOverview(sessions: asked, pageviews: asked * 3)
    }

    func analyticsLiveVisitors(workspaceID: String) async throws -> Int {
        try await answer("live")
        return 4
    }

    func analyticsBreakdown(
        workspaceID: String, report: WebAnalyticsBreakdown, dimension: String, range: AnalyticsDateRange
    ) async throws -> WebAnalyticsRows<WebAnalyticsRow> {
        try await answer("\(report.rawValue).\(dimension)")
        return WebAnalyticsRows(rows: [WebAnalyticsRow(key: dimension, sessions: 1)])
    }

    func analyticsPages(workspaceID: String, kind: String, range: AnalyticsDateRange) async throws -> WebAnalyticsRows<WebAnalyticsPage> {
        try await answer("pages.\(kind)")
        return WebAnalyticsRows(rows: [WebAnalyticsPage(path: "/", views: 3)])
    }

    func analyticsEvents(workspaceID: String, range: AnalyticsDateRange) async throws -> WebAnalyticsRows<WebAnalyticsEvent> {
        try await answer("events")
        return WebAnalyticsRows(rows: [])
    }
}

@MainActor
final class AnalyticsViewModelTests: XCTestCase {
    private var api: AnalyticsAPI!
    private var appState: AppState!
    /// 2026-09-27 12:00 UTC.
    private let noon = Date(timeIntervalSince1970: 1_790_510_400)

    override func setUp() async throws {
        api = AnalyticsAPI()
        appState = AppState(api: api)
    }

    private func model() -> AnalyticsViewModel {
        let now = noon
        return AnalyticsViewModel(api: api, clock: { now })
    }

    // MARK: - Ranges

    func testRangesCountBackFromTodayInUTC() {
        XCTAssertEqual(AnalyticsRange.week.bounds(now: noon), AnalyticsDateRange(start: "2026-09-21", end: "2026-09-27"))
        XCTAssertEqual(AnalyticsRange.week.previousBounds(now: noon), AnalyticsDateRange(start: "2026-09-14", end: "2026-09-20"))
        XCTAssertEqual(AnalyticsRange.month.bounds(now: noon).start, "2026-08-31")
        XCTAssertEqual(AnalyticsRange.quarter.bounds(now: noon).start, "2026-06-30")
    }

    func testChangeIsRelativeToThePeriodBefore() {
        XCTAssertEqual(AnalyticsViewModel.change(120, 100) ?? 0, 0.2, accuracy: 0.0001)
        XCTAssertEqual(AnalyticsViewModel.change(80, 100) ?? 0, -0.2, accuracy: 0.0001)
        XCTAssertNil(AnalyticsViewModel.change(5, 0), "no change from nothing")
        XCTAssertNil(AnalyticsViewModel.change(nil, 3))
    }

    // MARK: - Lazy loading and the cache

    func testTheOverviewLoadsWithThePeriodBefore() async {
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.overview?.sessions, 100)
        XCTAssertNotNil(vm.previous)
        let asked = await api.requests
        XCTAssertEqual(asked, ["overview 2026-08-31…2026-09-27", "overview 2026-08-03…2026-08-30"])
        XCTAssertTrue(vm.loading.isEmpty)
    }

    func testOnlyTheSectionOnScreenIsAskedForAndOnlyOnce() async {
        let vm = model()
        vm.section = .technology
        await vm.load(workspaceID: "w1", appState: appState)
        await vm.load(workspaceID: "w1", appState: appState)
        let asked = await api.requests
        XCTAssertEqual(asked, ["browsers-systems.device", "browsers-systems.os", "browsers-systems.browser"])
        XCTAssertNil(vm.overview, "nothing is read for a section nobody opened")

        vm.section = .sources
        vm.sourceDimension = "campaign"
        await vm.load(workspaceID: "w1", appState: appState)
        XCTAssertNotNil(vm.breakdowns[AnalyticsViewModel.key("sources", "campaign")])
    }

    func testAnotherRangeStartsOver() async {
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        let before = vm.generation
        vm.setRange(.week)
        XCTAssertGreaterThan(vm.generation, before)
        XCTAssertNil(vm.overview)
        await vm.load(workspaceID: "w1", appState: appState)
        let asked = await api.requests
        XCTAssertEqual(asked.suffix(2), ["overview 2026-09-21…2026-09-27", "overview 2026-09-14…2026-09-20"])
    }

    func testAnAnswerForTheOldRangeIsDropped() async {
        await api.setDelay(200_000_000)
        await api.setSessions(1)
        let vm = model()
        let slow = Task { await vm.load(workspaceID: "w1", appState: appState) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        vm.setRange(.quarter)
        await api.setDelay(0)
        await api.setSessions(2)
        await vm.load(workspaceID: "w1", appState: appState)
        await slow.value
        XCTAssertEqual(vm.overview?.sessions, 2, "the 28-day answer arrived late and was not shown under 90 days")
    }

    /// The screen's `.task` restarts whenever its key changes — the first
    /// workspace arriving does it. The report it had asked for must still
    /// land, and the restarted task must not ask for it a second time.
    func testARestartedScreenTaskStillGetsTheReportAlreadyOut() async {
        await api.setDelay(150_000_000)
        let vm = model()
        let first = Task { await vm.load(workspaceID: "w1", appState: appState) }
        try? await Task.sleep(nanoseconds: 30_000_000)
        first.cancel()
        await vm.load(workspaceID: "w1", appState: appState)
        await first.value
        XCTAssertEqual(vm.overview?.sessions, 100)
        XCTAssertNotNil(vm.previous)
        let asked = await api.requests
        XCTAssertEqual(asked.filter { $0.hasPrefix("overview 2026-08-31") }.count, 1, "joined, not asked twice")
        XCTAssertTrue(vm.loading.isEmpty)
    }

    func testAnotherWorkspaceKeepsNothing() async {
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        vm.use(workspaceID: "w2")
        XCTAssertNil(vm.overview)
        XCTAssertNil(vm.live)
    }

    // MARK: - Failure

    func testAPlanWithoutAnalyticsLocksTheScreen() async {
        await api.setError(.server(status: 403, message: "module_not_in_plan"))
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        XCTAssertTrue(vm.locked)
        XCTAssertFalse(vm.failed)
    }

    func testAnyOtherFailureOffersToTryAgain() async {
        await api.setError(.transport)
        let vm = model()
        vm.section = .events
        await vm.load(workspaceID: "w1", appState: appState)
        XCTAssertTrue(vm.failed)
        XCTAssertFalse(vm.locked)
        await api.setError(nil)
        vm.refresh()
        XCTAssertFalse(vm.failed)
        await vm.load(workspaceID: "w1", appState: appState)
        XCTAssertNotNil(vm.events)
    }

    // MARK: - Live count

    func testTheLiveCountArrivesAndStopsWithItsTask() async {
        let vm = model()
        let poller = Task { await vm.pollLive(workspaceID: "w1", appState: appState) }
        let arrived = await eventually { vm.live == 4 }
        XCTAssertTrue(arrived)
        poller.cancel()
        await poller.value
    }

    // MARK: - Formatting

    func testFormatting() {
        XCTAssertEqual(AnalyticsFormat.duration(134, .en), "2 m 14 s")
        XCTAssertEqual(AnalyticsFormat.duration(48, .en), "48 s")
        XCTAssertEqual(AnalyticsFormat.channel("organic_search", .en), "Organic search")
        XCTAssertEqual(AnalyticsFormat.channel("(unknown)", .en), Str.analyticsUnknown(.en))
        XCTAssertEqual(AnalyticsFormat.country("Iran", .en).flag, "🇮🇷")
        XCTAssertEqual(AnalyticsFormat.country("Türkiye", .en).flag, "🇹🇷")
        XCTAssertEqual(AnalyticsFormat.day("2026-09-27").map { Int($0.timeIntervalSince1970) }, 1_790_467_200)
        XCTAssertFalse(AnalyticsFormat.percent(0.004, .en).hasPrefix("0%"), "a small share is not rounded to nothing")
    }
}
