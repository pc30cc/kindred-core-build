import Foundation
import XCTest
@testable import WebyarNative

/// The server's unread counts, scriptable between reads.
private actor BadgeAPI: TestAPIBase {
    private(set) var conversationReads = 0
    private(set) var teamReads = 0
    private var unread = 2
    private var team = 1
    private var failing = false

    func setUnread(_ value: Int) { unread = value }
    func setTeam(_ value: Int) { team = value }
    func setFailing(_ value: Bool) { failing = value }

    func unreadConversations(workspaceID: String) async throws -> Int {
        conversationReads += 1
        if failing { throw APIError.transport }
        return unread
    }

    func colleagues(workspaceID: String) async throws -> ColleaguesResponse {
        teamReads += 1
        if failing { throw APIError.transport }
        return ColleaguesResponse(colleagues: [], totalUnread: team, me: "u1")
    }
}

@MainActor
final class InboxBadgeTests: XCTestCase {
    private var api: BadgeAPI!
    private var sync: SyncCoordinator!

    override func setUp() async throws {
        api = BadgeAPI()
        sync = SyncCoordinator(api: api, persistent: false, storeRoot: nil, startsRealtime: false)
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

    func testTheDotCountsUnreadConversationsAndTeamMessages() async throws {
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        XCTAssertEqual(badge.conversations, 2)
        XCTAssertEqual(badge.teamMessages, 1)
        XCTAssertEqual(badge.total, 3)
        XCTAssertTrue(badge.hasUnread)
    }

    /// The point of it: a new message shows on the tab without anyone
    /// opening the inbox.
    func testANewMessageReadsTheCountAgain() async throws {
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        await api.setUnread(5)
        sync.emit(.message(conversationID: "c9", message: nil))
        try await settle()
        XCTAssertEqual(badge.conversations, 5)
    }

    /// And reading a conversation on this phone takes the dot away at once:
    /// the server announces nothing for a seen, so the phone does.
    func testReadingAConversationHereClearsTheDot() async throws {
        await api.setTeam(0)
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        XCTAssertTrue(badge.hasUnread)
        await api.setUnread(0)
        sync.emit(.seen(conversationID: "c1"))
        try await settle()
        XCTAssertFalse(badge.hasUnread)
    }

    func testATeamEventReadsOnlyTheTeamCount() async throws {
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        let before = await api.conversationReads
        await api.setTeam(4)
        sync.emit(.team(peerID: "u2"))
        try await settle()
        XCTAssertEqual(badge.teamMessages, 4)
        let after = await api.conversationReads
        XCTAssertEqual(after, before, "a team message says nothing about visitors' conversations")
    }

    func testABurstIsOneRead() async throws {
        let badge = badge()
        let task = try await tracking(badge)
        defer { task.cancel() }
        let before = await api.conversationReads
        sync.emit(.message(conversationID: "c1", message: nil))
        sync.emit(.push(conversationID: "c1", messageID: "m1"))
        sync.emit(.conversationChanged(conversationID: "c1"))
        try await settle()
        let after = await api.conversationReads
        XCTAssertEqual(after - before, 1)
    }

    func testWithoutTeamChatOnlyConversationsCount() async throws {
        let badge = badge()
        let task = try await tracking(badge, team: false)
        defer { task.cancel() }
        XCTAssertEqual(badge.teamMessages, 0)
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
        let second = Task { await badge.track(workspaceID: "w2", includesTeam: true) }
        defer { second.cancel() }
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(badge.total, 0, "w1's count is never shown under w2")
    }
}
