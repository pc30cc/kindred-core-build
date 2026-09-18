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
}

@MainActor
@Observable
final class InboxViewModel {

    private(set) var state: LoadState<[Conversation]> = .loading
    var filter: InboxFilter = .open
    var searchText = ""

    private let api: any WebyarAPI
    private var loadTask: Task<Void, Never>?

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    /// Conversations after the filter and the search box, sorted newest first.
    var visible: [Conversation] {
        guard let all = state.value else { return [] }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        let matched = query.isEmpty ? all : all.filter { conversation in
            let haystack = [
                conversation.contact?.name,
                conversation.contact?.email,
                conversation.contact?.visitorCode,
                conversation.subject,
                conversation.lastMessage?.body,
            ]
            return haystack.contains { $0?.lowercased().contains(query) == true }
        }

        return matched.sorted { lhs, rhs in
            // A thread with no activity at all sorts last rather than
            // crashing into the top on a nil date.
            (lhs.lastActivity ?? .distantPast) > (rhs.lastActivity ?? .distantPast)
        }
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
                let conversations = try await api.conversations(workspaceID: workspaceID, filter: filter)
                guard !Task.isCancelled else { return }
                state = .loaded(conversations)
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
            let conversations = try await api.conversations(workspaceID: workspaceID, filter: filter)
            state = .loaded(conversations)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // Keep showing what we have; the next pull can try again.
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
