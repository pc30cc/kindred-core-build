import SwiftUI
import Observation

/// What a list screen can be showing at any moment.
///
/// Modelling this as one value rather than a pile of booleans is what makes it
/// impossible to render a spinner and an empty state at the same time.
enum LoadState<Value>: Sendable where Value: Sendable {
    case loading
    case loaded(Value)
    case failed(APIError)

    var value: Value? {
        if case .loaded(let value) = self { return value }
        return nil
    }

    /// True once the rows on screen are real content rather than placeholders.
    var isLoaded: Bool {
        if case .loaded = self { return true }
        return false
    }
}

/// How the last attempt to bring what is on screen up to date went.
///
/// Apart from `LoadState` on purpose. `LoadState` says what content there is
/// to show; this says how fresh it is. With a copy saved on the phone a
/// failed read no longer means "nothing to show": the rows stay, and this
/// says they are the saved ones — which is the difference between an inbox
/// that disappears in a lift and one that says "offline" above what it had.
enum SyncStatus: Equatable, Sendable {
    /// Up to date as far as anyone knows.
    case idle
    /// The last read could not reach the server; the saved copy is on show.
    case offline
    /// The server answered with a failure; what was shown before is kept.
    case failed(APIError)

    var isOffline: Bool { self == .offline }
}

@MainActor
@Observable
final class InboxViewModel {

    private(set) var state: LoadState<[Conversation]> = .loading
    /// How fresh `state` is. Only meaningful while `state` is `.loaded`.
    private(set) var syncStatus: SyncStatus = .idle
    /// The counters behind each queue, so a filter can say how much is in it
    /// before the operator taps into it.
    private(set) var counts: InboxCounts?
    /// Device and location per conversation, keyed by conversation id.
    ///
    /// Decorative, exactly as in the web: the list renders without it, so a
    /// failure here never becomes an error state.
    private(set) var visitors: [String: VisitorProfile] = [:]
    var filter: InboxFilter = .open
    /// A channel inbox laid over the queue — Telegram, Bale, and the rest.
    ///
    /// Not a queue: the conversations endpoint has no channel parameter, so
    /// this narrows what came back, exactly as `?channel=` does on the web.
    var channel: ChannelInbox?
    /// Which channels this workspace has installed and can still use.
    private(set) var channels: [ChannelInbox] = []
    var searchText = ""
    /// The filter sheet's three fields.
    var fieldFilter = InboxFieldFilter()

    /// The workspace and queue `state` belongs to. A screen asking for
    /// another workspace's rows is told `.loading` until they are its own —
    /// not one frame of the previous workspace's list.
    private(set) var stateWorkspaceID: String?
    @ObservationIgnored private var stateFilter: InboxFilter?

    /// Set by the screen: the list is what the operator is looking at (its
    /// tab, nothing pushed over it). A list nobody is looking at is not read
    /// again for every event; it is read once when it is looked at again.
    @ObservationIgnored var isOnScreen = true {
        didSet { if isOnScreen, !oldValue, isStale { scheduleRefresh(after: 0) } }
    }

    @ObservationIgnored private let api: any WebyarAPI
    @ObservationIgnored private let sync: SyncCoordinator
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var refreshSoon: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private weak var appState: AppState?
    /// Something changed on the server since the list was last read.
    @ObservationIgnored private var isStale = false

    init(api: any WebyarAPI = Backend.current, sync: SyncCoordinator = .shared) {
        self.api = api
        self.sync = sync
    }

    /// Keeps the selected queue inside the set the plan actually grants.
    ///
    /// A plan can change under the app — switching workspace is the ordinary
    /// way — and leaving the selection on a queue that no longer exists would
    /// show an empty list with no visible reason.
    func reconcileFilter(with available: [InboxFilter]) {
        guard !available.isEmpty, !available.contains(filter) else { return }
        filter = available[0]
    }

    /// What the screen for `workspaceID` may show.
    func content(for workspaceID: String?) -> LoadState<[Conversation]> {
        guard stateWorkspaceID == workspaceID else { return .loading }
        return state
    }

    /// One conversation out of the loaded list, by id.
    ///
    /// The whole list, not `visible`: a notification names a conversation
    /// without knowing which queue the operator happens to be looking at, and
    /// refusing to open a thread because it is filtered out of the current
    /// view would be the app disagreeing with its own banner.
    func conversation(id: String) -> Conversation? {
        state.value?.first { $0.id == id }
    }

    /// Conversations after the queue, the search box and the filter sheet,
    /// sorted newest first — for `workspaceID` only.
    ///
    /// All three are applied here rather than on the server because
    /// `GET /api/conversations` has no text search — the web filters its own
    /// list the same way, so the two surfaces agree on what a match is.
    func visible(in workspaceID: String?) -> [Conversation] {
        guard stateWorkspaceID == workspaceID, let all = state.value else { return [] }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        let searched = query.isEmpty ? all : all.filter { conversation in
            let haystack = [
                conversation.contact?.name,
                conversation.contact?.email,
                conversation.contact?.visitorCode,
                conversation.subject,
                conversation.lastMessage?.body,
            ]
            return haystack.contains { $0?.lowercased().contains(query) == true }
        }

        let matched = fieldFilter.isEmpty ? searched : searched.filter(fieldFilter.matches)
        let onChannel = channel.map { inbox in
            matched.filter { $0.channelKey == inbox.key }
        } ?? matched

        return onChannel
            // Belt and braces: a row of another workspace is never drawn.
            .filter { $0.workspaceId == workspaceID }
            .sorted { lhs, rhs in
                // A thread with no activity at all sorts last rather than
                // crashing into the top on a nil date.
                (lhs.lastActivity ?? .distantPast) > (rhs.lastActivity ?? .distantPast)
            }
    }

    /// The channels the switcher can offer. Decorative in the same sense the
    /// visitor lookups are: a failure leaves the menu with its queues and
    /// nothing else, which is the state the app shipped in.
    func loadChannels(workspaceID: String?) async {
        guard let workspaceID else { return }
        channels = (try? await api.channelInboxes(workspaceID: workspaceID)) ?? []
        // A channel that has just left the plan must not stay selected with
        // nothing behind it.
        if let channel, !channels.contains(channel) { self.channel = nil }
    }

    /// Opens one inbox from the switcher: either a queue or a channel, never
    /// both at once. They read as siblings in the menu, so they behave as
    /// siblings here.
    func open(_ filter: InboxFilter) {
        self.filter = filter
        channel = nil
    }

    func open(_ channel: ChannelInbox) {
        self.channel = channel
        // A channel inbox shows what is open on it; the other queues are
        // reachable from the same menu.
        filter = .open
    }

    /// Shows the list for this workspace and queue: this session's copy or
    /// the one saved on the phone at once, then the server's.
    func load(workspaceID: String?, appState: AppState) {
        self.appState = appState
        guard let workspaceID else {
            stateWorkspaceID = nil
            stateFilter = nil
            state = .loaded([])
            return
        }

        // A fast filter or workspace switch must not let an older, slower
        // response land on top of a newer one.
        generation += 1
        let gen = generation
        loadTask?.cancel()
        let filter = self.filter

        if workspaceID != stateWorkspaceID {
            counts = nil
            visitors = [:]
            syncStatus = .idle
        }
        if workspaceID != stateWorkspaceID || filter != stateFilter {
            // Synchronously, so the first frame for the new list is already
            // the right one: this session's copy, or a skeleton.
            if let known = sync.lists(for: workspaceID)?.cachedInMemory(filter) {
                show(known, workspaceID: workspaceID, filter: filter)
            } else {
                stateWorkspaceID = workspaceID
                stateFilter = filter
                state = .loading
            }
        }

        loadTask = Task {
            // The copy saved on the phone while the server is asked.
            if !state.isLoaded, let lists = sync.lists(for: workspaceID) {
                if let saved = await lists.cached(filter), gen == generation, !state.isLoaded {
                    show(saved, workspaceID: workspaceID, filter: filter)
                }
                if counts == nil, let saved = await sync.store(for: workspaceID)?.counts(), gen == generation, counts == nil {
                    counts = saved
                }
            }
            await fetch(workspaceID: workspaceID, filter: filter, generation: gen)
        }
    }

    /// Pull-to-refresh. Unlike `load` it keeps the current rows on screen
    /// while the request is in flight, so the list does not blank out under
    /// the finger.
    func refresh(workspaceID: String?, appState: AppState) async {
        self.appState = appState
        guard let workspaceID else { return }
        sync.lists(for: workspaceID)?.invalidate()
        await fetch(workspaceID: workspaceID, filter: filter, generation: generation)
    }

    private func show(_ list: [Conversation], workspaceID: String, filter: InboxFilter) {
        let own = list.filter { $0.workspaceId == workspaceID }
        stateWorkspaceID = workspaceID
        stateFilter = filter
        // Unchanged rows are not re-published: a poll that finds nothing new
        // redraws nothing.
        if case .loaded(let current) = state, current == own { return }
        state = .loaded(own)
    }

    private func fetch(workspaceID: String, filter: InboxFilter, generation gen: Int) async {
        isStale = false
        async let counters = try? await api.inboxCounts(workspaceID: workspaceID, scope: "mine")
        do {
            let conversations: [Conversation]
            if let lists = sync.lists(for: workspaceID) {
                conversations = try await lists.fetch(filter)
            } else {
                conversations = try await api.conversations(workspaceID: workspaceID, filter: filter)
            }
            // The counters are a nice-to-have on top of the list, so a
            // failure there must not empty the inbox.
            let fetchedCounts = await counters
            guard gen == generation, !Task.isCancelled else { return }
            show(conversations, workspaceID: workspaceID, filter: filter)
            syncStatus = .idle
            if let fetchedCounts {
                if counts != fetchedCounts { counts = fetchedCounts }
                await sync.store(for: workspaceID)?.saveCounts(fetchedCounts)
            }
            await loadVisitors(for: conversations, workspaceID: workspaceID)
        } catch APIError.unauthorized {
            await appState?.handleUnauthorized()
        } catch {
            guard gen == generation, !Task.isCancelled else { return }
            let apiError = (error as? APIError) ?? .transport
            if state.isLoaded, stateWorkspaceID == workspaceID {
                // The rows stay; the screen says they may not be current.
                syncStatus = apiError == .transport ? .offline : .failed(apiError)
            } else {
                state = .failed(apiError)
            }
        }
    }

    // MARK: - Staying fresh

    /// Listens for as long as the screen exists: realtime events, pushes and
    /// the return to the foreground read the list again (one read for a
    /// burst); without realtime, the list is polled while it is on screen.
    func listen(workspaceID: String?) async {
        guard let workspaceID else { return }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.consumeEvents(workspaceID: workspaceID) }
            group.addTask { await self.poll(workspaceID: workspaceID) }
        }
    }

    private func consumeEvents(workspaceID: String) async {
        for await event in sync.events() {
            guard stateWorkspaceID == workspaceID else { continue }
            switch event {
            case .message, .conversationChanged, .push, .resync, .reconcile:
                isStale = true
                if isOnScreen { scheduleRefresh(after: CachePolicy.listEventDebounce) }
            }
        }
    }

    private func poll(workspaceID: String) async {
        while !Task.isCancelled {
            let interval = sync.realtimeConnected ? CachePolicy.listSafetyInterval : CachePolicy.listPollInterval
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            guard sync.isForeground, isOnScreen, stateWorkspaceID == workspaceID else { continue }
            sync.lists(for: workspaceID)?.invalidate()
            await fetch(workspaceID: workspaceID, filter: filter, generation: generation)
        }
    }

    private func scheduleRefresh(after delay: TimeInterval) {
        refreshSoon?.cancel()
        refreshSoon = Task {
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard !Task.isCancelled, let workspaceID = stateWorkspaceID else { return }
            // Something changed on the server: an answer from before it is
            // not shared, however recent.
            sync.lists(for: workspaceID)?.invalidate()
            await fetch(workspaceID: workspaceID, filter: filter, generation: generation)
        }
    }

    /// One batched lookup per page of conversations, never one per row — and
    /// only for the rows not already known from a moment ago.
    private func loadVisitors(for conversations: [Conversation], workspaceID: String) async {
        guard !conversations.isEmpty else { return }
        let cache = VisitorIntelCache.shared
        let ids = conversations.map(\.id)
        var known: [String: VisitorProfile] = [:]
        for id in ids { if let profile = cache.profile(for: id) { known[id] = profile } }
        let missing = cache.missing(ids)
        if !missing.isEmpty,
           let fetched = try? await api.visitorIntel(workspaceID: workspaceID, conversationIDs: missing) {
            cache.store(fetched, workspaceID: workspaceID)
            known.merge(fetched) { _, new in new }
        }
        guard !known.isEmpty, stateWorkspaceID == workspaceID else { return }
        // Merged rather than replaced: switching queue re-uses what is already
        // known about a thread instead of blanking its avatar for a moment.
        var merged = visitors
        merged.merge(known) { _, new in new }
        if merged.count != visitors.count || known.contains(where: { visitors[$0.key] == nil }) {
            visitors = merged
        }
    }

    func visitor(for conversation: Conversation) -> VisitorProfile? {
        visitors[conversation.id]
    }

    /// Takes ownership of a thread.
    ///
    /// Unlike resolving, this does not remove the row — the conversation stays
    /// in the same queue, it just becomes yours — so the list is reloaded
    /// rather than mutated, and the server decides what "yours" now means.
    func claim(_ conversation: Conversation, workspaceID: String?, appState: AppState) async {
        do {
            try await api.claim(conversationID: conversation.id, workspaceID: conversation.workspaceId)
            Haptics.success()
            await refresh(workspaceID: workspaceID, appState: appState)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // Nothing changed server-side, so nothing changes here either.
        }
    }

    func setStatus(_ status: ConversationStatus, for conversation: Conversation, appState: AppState) async {
        // Optimistic: the row animates away immediately, because waiting for a
        // round trip to acknowledge a swipe feels broken.
        let previous = state.value
        if var list = state.value, let index = list.firstIndex(where: { $0.id == conversation.id }) {
            list.remove(at: index)
            state = .loaded(list)
        }

        do {
            try await api.setStatus(status, conversationID: conversation.id, workspaceID: conversation.workspaceId)
            // Every list held for this workspace forgets the row's old place;
            // the next read (the event this change publishes) confirms it.
            sync.lists(for: conversation.workspaceId)?.remove(conversation.id)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // Put it back — the server never agreed to the change.
            if let previous, stateWorkspaceID == conversation.workspaceId { state = .loaded(previous) }
        }
    }
}

/// The three things an operator actually looks a conversation up by.
///
/// Separate from the search box on purpose: search is one word against
/// everything, this is a specific word against a specific field, and the two
/// compose — a subject filter narrows what the search box already found.
struct InboxFieldFilter: Equatable, Sendable {
    var name = ""
    var email = ""
    var subject = ""

    var isEmpty: Bool {
        [name, email, subject].allSatisfy {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    var activeCount: Int {
        [name, email, subject].count {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    func matches(_ conversation: Conversation) -> Bool {
        contains(conversation.contact?.name, name)
            && contains(conversation.contact?.email, email)
            && contains(conversation.subject, subject)
    }

    private func contains(_ haystack: String?, _ needle: String) -> Bool {
        let wanted = needle.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !wanted.isEmpty else { return true }
        return haystack?.lowercased().contains(wanted) == true
    }
}
