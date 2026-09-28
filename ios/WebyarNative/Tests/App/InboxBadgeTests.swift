import Foundation
import XCTest
@testable import WebyarNative

/// A row of a list. Out here because inside the API double `conversation`
/// names the protocol's own method rather than the shared test helper.
private func listRow(_ id: String, workspace: String, unread: Int) throws -> Conversation {
    try conversation(id, workspace: workspace, unread: unread)
}

/// The Open tab and the colleagues list, as the server would answer them,
/// scriptable between reads.
private actor BadgeAPI: TestAPIBase {
    private(set) var reads: [InboxFilter] = []
    private(set) var teamReads = 0
    /// Unread count per conversation in the Open tab.
    private var open: [String: Int] = ["c1": 2, "c2": 0, "c3": 1]
    /// The AI queue: busy, and never to light the dot.
    private var automated: [String: Int] = ["a1": 4]
    private var team = 1
    private var failing = false

    func setOpen(_ value: [String: Int]) { open = value }
    func setTeam(_ value: Int) { team = value }
    func setFailing(_ value: Bool) { failing = value }
    var openReads: Int { reads.filter { $0 == .open }.count }

    func conversations(workspaceID: String, filter: InboxFilter, etag: String?) async throws -> ListPage {
        reads.append(filter)
        if failing { throw APIError.transport }
        let rows = filter == .ai ? automated : filter == .open ? open : [:]
        return ListPage(
            conversations: try rows.sorted { $0.key < $1.key }.map { id, unread in
                try listRow(id, workspace: workspaceID, unread: unread)
            },
            etag: nil
        )
    }

    func colleagues(workspaceID: String) async throws -> ColleaguesResponse {
        teamReads += 1
        if failing { throw APIError.transport }
        // `team` colleagues with an unread thread, two messages each, and one
        // whose thread is read — so a count of messages and a count of
        // threads come out different.
        let unread = (0..<team).map { index in
            Colleague(
                userId: "u\(index + 2)", role: "agent", fullName: nil, email: nil,
                avatarURL: nil, unread: 2, lastMessage: nil
            )
        }
        let read = Colleague(
            userId: "u99", role: "agent", fullName: nil, email: nil,
            avatarURL: nil, unread: 0, lastMessage: nil
        )
        return ColleaguesResponse(colleagues: unread + [read], totalUnread: team * 2, me: "u1")
    }
}

@MainActor
final class InboxBadgeTests: XCTestCase {
    private var api: BadgeAPI!
    private var sync: SyncCoordinator!

    override func setUp() async throws {
        api = BadgeAPI()
        sync = SyncCoordinator(api: api, persistent: false, storeRoot: nil, startsRealtime: false)
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
    }

    private func badge() -> InboxBadge { InboxBadge(api: api, sync: sync) }

    /// Long enough for one debounced read to land.
    private func settle() async throws {
        try await Task.sleep(nanoseconds: UInt64((CachePolicy.listEventDebounce + 0.4) * 1_000_000_000))
    }

    /// Starts tracking and waits until the first reads are in.
    private func tracking(_ badge: InboxBadge, team: Bool = true) async throws -> Task<Void, Never> {
        let task = Task { await badge.track(workspaceID: "w1", includesTeam: team) }
        try await Task.sleep(nanoseconds: 150_000_000)
        return task
    }

    func testTheDotCountsTheOpenTabAndColleaguesOnly() async throws {
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        XCTAssertEqual(badge.conversations, 2, "c1 and c3 hold unread messages; c2 is read")
        XCTAssertEqual(badge.teamThreads, 1)
        XCTAssertEqual(badge.total, 3)
        let reads = await api.reads
        XCTAssertFalse(reads.contains(.ai), "the AI queue is never asked for: it does not light the dot")
    }

    /// The point of it: nothing unread in Open or Colleagues, no dot — however
    /// busy the AI queue is.
    /// Two messages from one colleague are one thing to answer.
    func testColleaguesCountAsThreadsNotMessages() async throws {
        await api.setTeam(2)
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        XCTAssertEqual(badge.teamThreads, 2, "two colleagues with unread threads, four messages between them")
        XCTAssertEqual(badge.total, 4)
    }

    func testEverythingReadMeansNoDot() async throws {
        await api.setOpen(["c1": 0, "c2": 0])
        await api.setTeam(0)
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        XCTAssertFalse(badge.hasUnread)
    }

    func testANewMessageLightsTheDot() async throws {
        await api.setOpen(["c1": 0])
        await api.setTeam(0)
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        XCTAssertFalse(badge.hasUnread)
        await api.setOpen(["c1": 0, "c9": 1])
        // As the coordinator does with every realtime event: the lists are
        // told their copy is out of date before anyone hears of it.
        sync.lists(for: "w1")?.invalidate()
        sync.emit(.message(conversationID: "c9", message: nil))
        try await settle()
        XCTAssertEqual(badge.conversations, 1)
    }

    /// Reading a conversation here takes the dot away at once, although the
    /// server announces nothing for a read and the list was fetched a moment
    /// ago: the read goes to the server, not to the copy in hand.
    func testReadingAConversationHereClearsTheDot() async throws {
        await api.setOpen(["c1": 1])
        await api.setTeam(0)
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        XCTAssertTrue(badge.hasUnread)
        await api.setOpen(["c1": 0])
        sync.emit(.seen(conversationID: "c1"))
        try await settle()
        XCTAssertFalse(badge.hasUnread)
    }

    func testATeamEventReadsOnlyTheTeamCount() async throws {
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        let before = await api.openReads
        await api.setTeam(4)
        sync.emit(.team(peerID: "u2"))
        try await settle()
        XCTAssertEqual(badge.teamThreads, 4)
        let after = await api.openReads
        XCTAssertEqual(after, before, "a team message says nothing about visitors' conversations")
    }

    func testABurstIsOneRead() async throws {
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        let before = await api.openReads
        sync.emit(.message(conversationID: "c1", message: nil))
        sync.emit(.push(conversationID: "c1", messageID: "m1"))
        sync.emit(.conversationChanged(conversationID: "c1"))
        try await settle()
        let after = await api.openReads
        XCTAssertLessThanOrEqual(after - before, 1)
    }

    func testWithoutTeamChatOnlyTheOpenTabCounts() async throws {
        let badge = badge()
        let task = try await tracking(badge, team: false)
        defer { task.cancel() }
        XCTAssertEqual(badge.teamThreads, 0)
        XCTAssertEqual(badge.total, 2)
        let teamReads = await api.teamReads
        XCTAssertEqual(teamReads, 0)
    }

    func testAFailedReadKeepsTheDot() async throws {
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        await api.setFailing(true)
        sync.emit(.resync)
        try await settle()
        XCTAssertEqual(badge.total, 3, "one failed request does not blink the dot off")
    }

    func testAnotherWorkspaceStartsFromNothing() async throws {
        let badge = badge()
        let first = try await tracking(badge)
        first.cancel()
        await api.setFailing(true)
        sync.sessionChanged(userID: "u1", workspaceID: "w2")
        let second = Task { await badge.track(workspaceID: "w2", includesTeam: true) }
        defer { second.cancel() }
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(badge.total, 0, "w1's count is never shown under w2")
    }
}
