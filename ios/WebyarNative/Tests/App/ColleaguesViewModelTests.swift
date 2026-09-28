import Foundation
import XCTest
@testable import WebyarNative

/// A colleagues endpoint whose answer can change between reads.
private actor ColleaguesAPI: TestAPIBase {
    private(set) var reads = 0
    private var unread: [String: Int] = ["u2": 2, "u3": 0]
    private var failing = false

    func setUnread(_ id: String, _ count: Int) { unread[id] = count }
    func setFailing(_ value: Bool) { failing = value }

    func colleagues(workspaceID: String) async throws -> ColleaguesResponse {
        reads += 1
        if failing { throw APIError.transport }
        let rows = [("u2", "Sara Karimi", "sara@webyar.app"), ("u3", "Ali Rezaei", "ali@webyar.app")].map { id, name, email in
            Colleague(
                userId: id, role: "agent", fullName: "\(name) \(workspaceID)", email: email,
                avatarURL: nil, unread: unread[id], lastMessage: nil
            )
        }
        return ColleaguesResponse(colleagues: rows, totalUnread: nil, me: "u1")
    }
}

@MainActor
final class ColleaguesViewModelTests: XCTestCase {
    private var api: ColleaguesAPI!
    private var appState: AppState!
    private var sync: SyncCoordinator!

    override func setUp() async throws {
        api = ColleaguesAPI()
        appState = AppState(api: api)
        sync = SyncCoordinator(api: api, persistent: false, storeRoot: nil, startsRealtime: false)
    }

    private func model() -> ColleaguesViewModel {
        ColleaguesViewModel(api: api, sync: sync)
    }

    /// Long enough for one debounced read to land.
    private func settle() async throws {
        try await Task.sleep(nanoseconds: UInt64((CachePolicy.listEventDebounce + 0.4) * 1_000_000_000))
    }

    func testTheUnreadTotalAndTheSearchReadTheList() async {
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.state.value?.count, 2)
        XCTAssertEqual(vm.unreadTotal, 2)
        XCTAssertEqual(vm.matching("ALI").map(\.userId), ["u3"])
        XCTAssertEqual(vm.matching("webyar.app").count, 2, "the address is searched too")
        XCTAssertEqual(vm.matching("  ").count, 2)
    }

    /// The point of the Colleagues tab being live: a message heard on the
    /// operator's own team channel shows without a pull.
    func testATeamEventReadsTheListAgain() async throws {
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        let listening = Task { await vm.listen(workspaceID: "w1") }
        defer { listening.cancel() }
        try await Task.sleep(nanoseconds: 50_000_000)

        await api.setUnread("u3", 4)
        sync.emit(.team(peerID: "u3"))
        try await settle()
        XCTAssertEqual(vm.unreadTotal, 6)
        let reads = await api.reads
        XCTAssertEqual(reads, 2)
    }

    func testABurstOfTeamEventsIsOneRead() async throws {
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        let listening = Task { await vm.listen(workspaceID: "w1") }
        defer { listening.cancel() }
        try await Task.sleep(nanoseconds: 50_000_000)

        // A message and its read land a moment apart.
        sync.emit(.team(peerID: "u2"))
        sync.emit(.team(peerID: "u2"))
        sync.emit(.team(peerID: nil))
        try await settle()
        let reads = await api.reads
        XCTAssertEqual(reads, 2, "one read for the burst, after the first load")
    }

    func testComingBackToTheAppReadsTheListButConversationEventsDoNot() async throws {
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        let listening = Task { await vm.listen(workspaceID: "w1") }
        defer { listening.cancel() }
        try await Task.sleep(nanoseconds: 50_000_000)

        sync.emit(.message(conversationID: "c1", message: nil))
        sync.emit(.conversationChanged(conversationID: "c1"))
        try await settle()
        var reads = await api.reads
        XCTAssertEqual(reads, 1, "visitor conversations are the queues' to read")

        sync.emit(.resync)
        try await settle()
        reads = await api.reads
        XCTAssertEqual(reads, 2)
    }

    func testAFailedRefreshKeepsWhatIsOnScreen() async {
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        await api.setFailing(true)
        await vm.refresh(workspaceID: "w1")
        XCTAssertEqual(vm.state.value?.count, 2)
        await vm.load(workspaceID: "w1", appState: appState)
        XCTAssertEqual(vm.state.value?.count, 2, "a failed reload does not blank a list already shown")
    }

    func testAnotherWorkspaceKeepsNothingOfTheLast() async {
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        await api.setFailing(true)
        await vm.load(workspaceID: "w2", appState: appState)
        XCTAssertNil(vm.state.value, "w1's colleagues are never shown under w2")
        XCTAssertEqual(vm.unreadTotal, 0)
    }

    func testOpeningAThreadClearsItsBadgeAtOnce() async {
        let vm = model()
        await vm.load(workspaceID: "w1", appState: appState)
        vm.markRead("u2")
        XCTAssertEqual(vm.unreadTotal, 0)
    }
}
