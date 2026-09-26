import Foundation
import XCTest
@testable import WebyarNative

/// The inbox against a scripted server: the saved list at once, the server's
/// after it, one read for a burst of events, and never a frame of another
/// workspace's rows.
@MainActor
final class InboxViewModelTests: XCTestCase {
    private var root: URL!
    private var api: TestAPI!
    private var sync: SyncCoordinator!
    private var appState: AppState!

    override func setUp() async throws {
        root = try temporaryFolder()
        api = TestAPI()
        sync = SyncCoordinator(api: api, persistent: true, storeRoot: root, startsRealtime: false)
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        appState = AppState(api: api)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func model() -> InboxViewModel {
        InboxViewModel(api: api, sync: sync)
    }

    // 1. Empty cache cold start: a skeleton, then the server's list

    func testWithNothingSavedTheListLoadsFromTheServer() async throws {
        await api.setList("w1", [try conversation("a")])
        let vm = model()
        vm.load(workspaceID: "w1", appState: appState)
        XCTAssertFalse(vm.content(for: "w1").isLoaded, "a skeleton: nothing to show yet")
        let loaded = await eventually { vm.content(for: "w1").value?.map(\.id) == ["a"] }
        XCTAssertTrue(loaded)
    }

    // 3./4. Populated cache, offline: the saved list stays on screen

    func testTheSavedListShowsAtOnceAndStaysWhenOffline() async throws {
        await sync.store(for: "w1")?.saveList(ConversationLists.key(.open), [try conversation("a"), try conversation("b")], etag: nil)
        await api.setListError(.transport)
        let vm = model()
        vm.load(workspaceID: "w1", appState: appState)
        let shown = await eventually { vm.content(for: "w1").value?.map(\.id) == ["a", "b"] }
        XCTAssertTrue(shown)
        let offline = await eventually { vm.syncStatus == .offline }
        XCTAssertTrue(offline, "the rows stay; the screen says they are the saved ones")
        XCTAssertTrue(vm.content(for: "w1").isLoaded)
    }

    func testOfflineWithNothingSavedIsTheErrorScreen() async throws {
        await api.setListError(.transport)
        let vm = model()
        vm.load(workspaceID: "w1", appState: appState)
        let failed = await eventually {
            if case .failed = vm.content(for: "w1") { return true }
            return false
        }
        XCTAssertTrue(failed)
    }

    // 13./16. Workspace switch while loading

    func testAWorkspaceSwitchNeverShowsTheLastWorkspacesRows() async throws {
        await api.setList("w1", [try conversation("one", workspace: "w1")])
        await api.setList("w2", [try conversation("two", workspace: "w2")])
        await api.setListDelay("w1", 300_000_000)
        let vm = model()
        vm.load(workspaceID: "w1", appState: appState)

        sync.sessionChanged(userID: "u1", workspaceID: "w2")
        vm.load(workspaceID: "w2", appState: appState)
        XCTAssertFalse(vm.content(for: "w2").isLoaded)
        XCTAssertTrue(vm.visible(in: "w2").isEmpty)

        let second = await eventually { vm.content(for: "w2").value?.map(\.id) == ["two"] }
        XCTAssertTrue(second)
        // The slow answer for w1 lands now, and changes nothing.
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(vm.content(for: "w2").value?.map(\.id), ["two"])
        XCTAssertEqual(vm.visible(in: "w2").map(\.id), ["two"])
        XCTAssertFalse(vm.content(for: "w1").isLoaded, "w1's screen would be told to wait, not shown w2's rows")
    }

    // Events: one read for a burst, none for a list nobody looks at

    func testABurstOfEventsIsOneListRead() async throws {
        await api.setList("w1", [try conversation("a")])
        let vm = model()
        vm.load(workspaceID: "w1", appState: appState)
        _ = await eventually { vm.content(for: "w1").isLoaded }
        let listening = Task { await vm.listen(workspaceID: "w1") }
        defer { listening.cancel() }
        _ = await eventually { self.sync.listenerCount >= 1 }
        let before = await api.listReadCount

        for i in 0..<6 { sync.emit(.message(conversationID: "c\(i)", message: nil)) }
        try await Task.sleep(nanoseconds: UInt64((CachePolicy.listEventDebounce + 0.5) * 1_000_000_000))
        let after = await api.listReadCount
        XCTAssertEqual(after, before + 1)
    }

    func testAListNobodyIsLookingAtIsReadOnceWhenLookedAtAgain() async throws {
        await api.setList("w1", [try conversation("a")])
        let vm = model()
        vm.load(workspaceID: "w1", appState: appState)
        _ = await eventually { vm.content(for: "w1").isLoaded }
        let listening = Task { await vm.listen(workspaceID: "w1") }
        defer { listening.cancel() }
        _ = await eventually { self.sync.listenerCount >= 1 }

        vm.isOnScreen = false   // a thread is open over it
        let before = await api.listReadCount
        for i in 0..<3 { sync.emit(.message(conversationID: "c\(i)", message: nil)) }
        try await Task.sleep(nanoseconds: 1_000_000_000)
        var after = await api.listReadCount
        XCTAssertEqual(after, before, "no reads for a list under a thread")

        vm.isOnScreen = true    // back to the inbox
        _ = await eventually { await self.api.listReadCount == before + 1 }
        after = await api.listReadCount
        XCTAssertEqual(after, before + 1)
    }

    func testANewListFromTheServerReplacesTheSavedOne() async throws {
        await sync.store(for: "w1")?.saveList(ConversationLists.key(.open), [try conversation("old")], etag: nil)
        await api.setList("w1", [try conversation("new")])
        let vm = model()
        vm.load(workspaceID: "w1", appState: appState)
        let fresh = await eventually { vm.content(for: "w1").value?.map(\.id) == ["new"] }
        XCTAssertTrue(fresh, "the server is the truth: a conversation gone from it is gone from the list")
        XCTAssertEqual(vm.syncStatus, .idle)
    }
}
