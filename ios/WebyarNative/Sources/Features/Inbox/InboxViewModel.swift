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

@MainActor
@Observable
final class InboxViewModel {

    private(set) var state: LoadState<[Conversation]> = .loading
    /// The counters behind each queue, so a filter can say how much is in it
    /// before the operator taps into it.
    private(set) var counts: InboxCounts?
    /// Device and location per conversation, keyed by conversation id.
    ///
    /// Decorative, exactly as in the web: the list renders without it, so a
    /// failure here never becomes an error state.
    private(set) var visitors: [String: VisitorProfile] = [:]
    /// Whether that batch read is still out. Until it lands a row cannot tell
    /// "no operating system" from "not known yet", and guessing shows
    /// initials it is about to replace.
    private(set) var isResolvingVisitors = true
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

    private let api: any WebyarAPI
    private var loadTask: Task<Void, Never>?

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
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

    /// Conversations after the queue, the search box and the filter sheet,
    /// sorted newest first.
    ///
    /// All three are applied here rather than on the server because
    /// `GET /api/conversations` has no text search — the web filters its own
    /// list the same way, so the two surfaces agree on what a match is.
    /// One conversation out of the loaded list, by id.
    ///
    /// The whole list, not `visible`: a notification names a conversation
    /// without knowing which queue the operator happens to be looking at, and
    /// refusing to open a thread because it is filtered out of the current
    /// view would be the app disagreeing with its own banner.
    func conversation(id: String) -> Conversation? {
        state.value?.first { $0.id == id }
    }

    var visible: [Conversation] {
        guard let all = state.value else { return [] }
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

        return onChannel.sorted { lhs, rhs in
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

    func load(workspaceID: String?, appState: AppState) {
        guard let workspaceID else {
            state = .loaded([])
            return
        }

        // A fast filter switch must not let an older, slower response land on
        // top of a newer one.
        loadTask?.cancel()
        loadTask = Task { [filter] in
            do {
                // The counters are a nice-to-have on top of the list, so a
                // failure there must not empty the inbox.
                async let counters = try? await api.inboxCounts(workspaceID: workspaceID, scope: "mine")
                let conversations = try await api.conversations(workspaceID: workspaceID, filter: filter)
                guard !Task.isCancelled else { return }
                state = .loaded(conversations)
                counts = await counters
                await loadVisitors(for: conversations, workspaceID: workspaceID)
            } catch APIError.unauthorized {
                await appState.handleUnauthorized()
            } catch let error as APIError {
                guard !Task.isCancelled else { return }
                state = .failed(error)
            } catch {
                guard !Task.isCancelled else { return }
                state = .failed(.transport)
            }
        }
    }

    /// Pull-to-refresh. Unlike `load` it keeps the current rows on screen
    /// while the request is in flight, so the list does not blank out under
    /// the finger.
    func refresh(workspaceID: String?, appState: AppState) async {
        guard let workspaceID else { return }
        do {
            async let counters = try? await api.inboxCounts(workspaceID: workspaceID, scope: "mine")
            let conversations = try await api.conversations(workspaceID: workspaceID, filter: filter)
            state = .loaded(conversations)
            counts = await counters
            await loadVisitors(for: conversations, workspaceID: workspaceID)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // Keep showing what we have; the next pull can try again.
        }
    }

    /// One batched lookup per page of conversations, never one per row.
    private func loadVisitors(for conversations: [Conversation], workspaceID: String) async {
        guard !conversations.isEmpty else { return }
        let profiles = try? await api.visitorIntel(
            workspaceID: workspaceID,
            conversationIDs: conversations.map(\.id)
        )
        guard !Task.isCancelled else { return }
        isResolvingVisitors = false
        guard let profiles else { return }
        // Merged rather than replaced: switching queue re-uses what is already
        // known about a thread instead of blanking its avatar for a moment.
        visitors.merge(profiles) { _, new in new }
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
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // Put it back — the server never agreed to the change.
            if let previous { state = .loaded(previous) }
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
