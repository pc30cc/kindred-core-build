import Foundation
import Observation

/// Whether anything in the Inbox is waiting to be read — the dot on its tab.
///
/// Exactly the two places an operator is expected to answer: the **Open** tab
/// — its conversations holding a customer message nobody has opened
/// (`unread_count` on the rows of that very list, so the dot and the tab can
/// never disagree) — and **Colleagues** — team messages not read yet
/// (`total_unread` of the colleagues list), when team chat is on. The AI
/// queue is deliberately not counted: the AI is answering those, and a dot
/// that never goes away is a dot nobody looks at. Once everything in both is
/// read, there is no dot.
///
/// Read again on every realtime event — a message, a conversation changing,
/// a push, a read on this phone, a team message, coming back to the app —
/// one read per burst, and on a slow poll underneath for a platform without
/// realtime. It runs for as long as the shell's task does, whichever tab is
/// open: the dot matters most when the Inbox is not the tab on screen.
@MainActor
@Observable
final class InboxBadge {
    /// Conversations in the Open tab holding a customer message nobody has
    /// opened.
    private(set) var conversations = 0
    /// Team messages from colleagues not read yet.
    private(set) var teamMessages = 0

    var total: Int { conversations + teamMessages }
    var hasUnread: Bool { total > 0 }

    @ObservationIgnored private let api: any WebyarAPI
    @ObservationIgnored private let sync: SyncCoordinator
    @ObservationIgnored private var workspaceID: String?
    @ObservationIgnored private var includesTeam = false
    @ObservationIgnored private var conversationsSoon: Task<Void, Never>?
    @ObservationIgnored private var teamSoon: Task<Void, Never>?

    init(api: any WebyarAPI = Backend.current, sync: SyncCoordinator = .shared) {
        self.api = api
        self.sync = sync
    }

    /// For as long as the caller's task lives. The shell keys it on the
    /// workspace and on whether team chat is on, so either changing starts it
    /// over.
    func track(workspaceID: String?, includesTeam: Bool) async {
        if workspaceID != self.workspaceID {
            // Another workspace's count is never shown under this one.
            conversations = 0
            teamMessages = 0
        }
        self.workspaceID = workspaceID
        self.includesTeam = includesTeam
        if !includesTeam { teamMessages = 0 }
        guard let workspaceID else { return }

        await refreshConversations(workspaceID)
        await refreshTeam(workspaceID)
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.consumeEvents(workspaceID: workspaceID) }
            group.addTask { await self.poll(workspaceID: workspaceID) }
        }
        conversationsSoon?.cancel()
        teamSoon?.cancel()
    }

    private func consumeEvents(workspaceID: String) async {
        for await event in sync.events() {
            switch event {
            case .message, .conversationChanged, .push:
                // The coordinator has already told the lists to ask again.
                conversationsSoon = debounced(conversationsSoon) { await $0.refreshConversations(workspaceID) }
            case .seen:
                // Nothing on the server announced this read, so nothing has
                // told the lists yet that their copy is out of date.
                conversationsSoon = debounced(conversationsSoon) { await $0.refreshConversations(workspaceID, fresh: true) }
            case .team:
                teamSoon = debounced(teamSoon) { await $0.refreshTeam(workspaceID) }
            case .resync, .reconcile:
                conversationsSoon = debounced(conversationsSoon) { await $0.refreshConversations(workspaceID) }
                teamSoon = debounced(teamSoon) { await $0.refreshTeam(workspaceID) }
            }
        }
    }

    private func poll(workspaceID: String) async {
        while !Task.isCancelled {
            let interval = sync.realtimeConnected ? CachePolicy.badgeSafetyInterval : CachePolicy.badgePollInterval
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            guard sync.isForeground else { continue }
            await refreshConversations(workspaceID, fresh: true)
            await refreshTeam(workspaceID)
        }
    }

    /// One read for a burst: a message, its push and its seen land together.
    private func debounced(
        _ pending: Task<Void, Never>?,
        _ read: @escaping @MainActor (InboxBadge) async -> Void
    ) -> Task<Void, Never> {
        pending?.cancel()
        return Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(CachePolicy.listEventDebounce * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            await read(self)
        }
    }

    /// A failed read keeps the count in hand: a dot that blinks off because
    /// one request failed would be telling the operator something untrue.
    ///
    /// Read through the same shared list the Inbox reads, so it costs a
    /// revalidation (usually a 304) rather than a query of its own, and is
    /// shared with the Inbox when both ask at once. `fresh` makes it ask the
    /// server rather than take an answer from a moment ago.
    func refreshConversations(_ workspaceID: String, fresh: Bool = false) async {
        guard let lists = sync.lists(for: workspaceID) else { return }
        if fresh { lists.invalidate() }
        guard let rows = try? await lists.fetch(.open), self.workspaceID == workspaceID else { return }
        let value = rows.filter { $0.workspaceId == workspaceID && $0.hasUnread }.count
        if value != conversations { conversations = value }
    }

    func refreshTeam(_ workspaceID: String) async {
        guard includesTeam,
              let response = try? await api.colleagues(workspaceID: workspaceID),
              self.workspaceID == workspaceID, includesTeam
        else { return }
        let value = max(0, response.totalUnread
            ?? response.colleagues.reduce(0) { $0 + max(0, $1.unread ?? 0) })
        if value != teamMessages { teamMessages = value }
    }
}
