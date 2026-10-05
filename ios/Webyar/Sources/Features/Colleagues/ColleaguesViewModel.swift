import Foundation
import Observation

/// The colleagues in this workspace and each one's last team message — the
/// Colleagues tab in the Inbox and the Colleagues screen read the same.
///
/// Live while its screen is: a message or a read on the operator's own team
/// channel reads the list again (one read for a burst), so does coming back
/// to the app, and a slow poll covers a platform or a moment without the
/// channel.
@MainActor
@Observable
final class ColleaguesViewModel {
    private(set) var state: LoadState<[Colleague]> = .loading
    var searchText = ""

    @ObservationIgnored private let api: any WebyarAPI
    @ObservationIgnored private let sync: SyncCoordinator
    @ObservationIgnored private var workspaceID: String?
    @ObservationIgnored private var refreshSoon: Task<Void, Never>?

    init(api: any WebyarAPI = Backend.current, sync: SyncCoordinator = .shared) {
        self.api = api
        self.sync = sync
    }

    var visible: [Colleague] { matching(searchText) }

    /// The colleagues whose name or address contains `query`.
    func matching(_ query: String) -> [Colleague] {
        guard let all = state.value else { return [] }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return all }
        return all.filter { colleague in
            [colleague.fullName, colleague.email]
                .contains { $0?.lowercased().contains(query) == true }
        }
    }

    /// Messages from colleagues not read yet: the Colleagues tab's count.
    var unreadTotal: Int {
        state.value?.reduce(0) { $0 + max(0, $1.unread ?? 0) } ?? 0
    }

    func load(workspaceID: String?, appState: AppState) async {
        use(workspaceID: workspaceID)
        guard let workspaceID else {
            state = .loaded([])
            return
        }
        do {
            let colleagues = try await api.colleagues(workspaceID: workspaceID).colleagues
            guard self.workspaceID == workspaceID else { return }
            state = .loaded(colleagues)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch let error as APIError {
            guard self.workspaceID == workspaceID, state.value == nil else { return }
            state = .failed(error)
        } catch {
            guard self.workspaceID == workspaceID, state.value == nil else { return }
            state = .failed(.transport)
        }
    }

    /// Quietly, keeping what is on screen when the read fails.
    func refresh(workspaceID: String?) async {
        guard let workspaceID,
              let colleagues = try? await api.colleagues(workspaceID: workspaceID).colleagues,
              self.workspaceID == nil || self.workspaceID == workspaceID
        else { return }
        self.workspaceID = workspaceID
        state = .loaded(colleagues)
    }

    /// Another workspace: nothing of the last one's colleagues stays.
    private func use(workspaceID: String?) {
        guard workspaceID != self.workspaceID else { return }
        self.workspaceID = workspaceID
        refreshSoon?.cancel()
        state = .loading
    }

    /// Clears the badge as the thread opens, rather than one refresh later.
    func markRead(_ userID: String) {
        guard var all = state.value, let index = all.firstIndex(where: { $0.userId == userID })
        else { return }
        let old = all[index]
        all[index] = Colleague(
            userId: old.userId, role: old.role, fullName: old.fullName, email: old.email,
            avatarURL: old.avatarURL, unread: 0, lastMessage: old.lastMessage
        )
        state = .loaded(all)
    }

    // MARK: - Staying current

    /// For as long as the caller's task lives. Ends by itself when the
    /// workspace changes (the task is keyed on it) or the screen goes.
    func listen(workspaceID: String?) async {
        guard let workspaceID else { return }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.consumeEvents(workspaceID: workspaceID) }
            group.addTask { await self.poll(workspaceID: workspaceID) }
        }
        refreshSoon?.cancel()
    }

    private func consumeEvents(workspaceID: String) async {
        for await event in sync.events() {
            switch event {
            case .team, .resync, .reconcile:
                scheduleRefresh(workspaceID: workspaceID)
            case .message, .conversationChanged, .push, .seen:
                continue
            }
        }
    }

    private func poll(workspaceID: String) async {
        while !Task.isCancelled {
            let interval = sync.teamRealtimeConnected
                ? CachePolicy.teamListSafetyInterval
                : CachePolicy.teamListPollInterval
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            guard sync.isForeground else { continue }
            await refresh(workspaceID: workspaceID)
        }
    }

    /// One read for a burst: a message and its read land a moment apart.
    private func scheduleRefresh(workspaceID: String) {
        refreshSoon?.cancel()
        refreshSoon = Task {
            try? await Task.sleep(nanoseconds: UInt64(CachePolicy.listEventDebounce * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self.refresh(workspaceID: workspaceID)
        }
    }
}
