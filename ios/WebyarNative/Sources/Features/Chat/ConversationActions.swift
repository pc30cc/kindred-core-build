import SwiftUI
import Observation

/// Everything the chat screen's menu can change about a conversation.
///
/// One model rather than one per sheet, because the server takes them
/// together: `PATCH /api/conversations/:id` records a single diff across
/// status, priority, assignee and tags, and splitting that up on the client
/// would only invent orderings the server never sees.
@MainActor
@Observable
final class ConversationActionsModel {

    private(set) var status: ConversationStatus
    private(set) var priority: ConversationPriority
    private(set) var assignedTo: String?
    private(set) var tags: [String]

    private(set) var members: [WorkspaceMember] = []
    private(set) var notes: LoadState<[ConversationNote]> = .loading
    private(set) var isSaving = false
    /// Set when a change was rejected, so the screen can say so instead of
    /// silently reverting under the operator's hands.
    var saveFailed = false
    /// Set when an invitation went out and the visitor has not answered yet.
    var pendingInvitation: CallInvitation?
    var inviteFailed = false

    private let conversationID: String
    private let workspaceID: String
    private let api: any WebyarAPI

    init(conversation: Conversation, api: any WebyarAPI = Backend.current) {
        self.conversationID = conversation.id
        self.workspaceID = conversation.workspaceId
        self.status = conversation.status
        self.priority = conversation.priority ?? .normal
        self.assignedTo = conversation.assignedTo
        self.tags = conversation.tags ?? []
        self.api = api
    }

    var assigneeName: String? {
        guard let assignedTo else { return nil }
        return members.first { $0.userId == assignedTo }?.displayName
    }

    /// Members who may actually be handed a conversation.
    var transferCandidates: [WorkspaceMember] {
        members
            .filter(\.canReceiveWork)
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    func load(appState: AppState) async {
        async let membersResult = try? await api.workspaceMembers(workspaceID: workspaceID)
        async let notesResult = try? await api.notes(
            conversationID: conversationID,
            workspaceID: workspaceID
        )
        members = await membersResult ?? []
        // A note list that failed to load is an empty list with a retry, not
        // an error that hides the rest of the menu.
        notes = .loaded(await notesResult ?? [])
    }

    // MARK: - Edits

    func setStatus(_ new: ConversationStatus, appState: AppState) async {
        let previous = status
        status = new
        await save(appState: appState, revert: { self.status = previous }) {
            try await self.api.updateConversation(
                conversationID: self.conversationID,
                workspaceID: self.workspaceID,
                status: new, priority: nil, assignedTo: nil, tags: nil
            )
        }
    }

    func setPriority(_ new: ConversationPriority, appState: AppState) async {
        let previous = priority
        priority = new
        await save(appState: appState, revert: { self.priority = previous }) {
            try await self.api.updateConversation(
                conversationID: self.conversationID,
                workspaceID: self.workspaceID,
                status: nil, priority: new, assignedTo: nil, tags: nil
            )
        }
    }

    /// `nil` hands the thread back to the queue.
    func assign(to userID: String?, appState: AppState) async {
        let previous = assignedTo
        assignedTo = userID
        await save(appState: appState, revert: { self.assignedTo = previous }) {
            try await self.api.updateConversation(
                conversationID: self.conversationID,
                workspaceID: self.workspaceID,
                status: nil, priority: nil,
                // The double optional is what tells the client the difference
                // between "clear the assignee" and "leave it alone".
                assignedTo: .some(userID), tags: nil
            )
        }
    }

    func addTag(_ raw: String, appState: AppState) async {
        let tag = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !tag.isEmpty, !tags.contains(tag), tags.count < 20 else { return }
        await setTags(tags + [tag], appState: appState)
    }

    func removeTag(_ tag: String, appState: AppState) async {
        await setTags(tags.filter { $0 != tag }, appState: appState)
    }

    private func setTags(_ new: [String], appState: AppState) async {
        let previous = tags
        tags = new
        await save(appState: appState, revert: { self.tags = previous }) {
            try await self.api.updateConversation(
                conversationID: self.conversationID,
                workspaceID: self.workspaceID,
                status: nil, priority: nil, assignedTo: nil, tags: new
            )
        }
    }

    // MARK: - Notes

    func addNote(_ body: String, appState: AppState) async {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            try await api.addNote(
                conversationID: conversationID,
                workspaceID: workspaceID,
                body: text
            )
            // Re-reading is cheap and gives the note its server id, author and
            // timestamp — all three of which a local guess would get wrong.
            notes = .loaded(try await api.notes(conversationID: conversationID, workspaceID: workspaceID))
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            saveFailed = true
        }
    }

    func deleteNote(_ note: ConversationNote, appState: AppState) async {
        let previous = notes.value ?? []
        notes = .loaded(previous.filter { $0.id != note.id })
        do {
            try await api.deleteNote(
                conversationID: conversationID,
                workspaceID: workspaceID,
                noteID: note.id
            )
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            notes = .loaded(previous)
            saveFailed = true
        }
    }

    // MARK: - Calls

    /// Asks the visitor to join a call. The operator never dials out: an
    /// invitation is created, the widget offers it, and a room only exists
    /// once the visitor accepts — which is why this ends in "waiting", not in
    /// a ringing tone.
    func invite(_ channel: CallChannel, appState: AppState) async {
        do {
            pendingInvitation = try await api.inviteToCall(
                conversationID: conversationID,
                workspaceID: workspaceID,
                channel: channel
            )
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            inviteFailed = true
        }
    }

    func cancelInvitation() async {
        guard let invitation = pendingInvitation else { return }
        pendingInvitation = nil
        try? await api.cancelInvitation(id: invitation.id)
    }

    // MARK: - Plumbing

    private func save(
        appState: AppState,
        revert: @escaping @MainActor () -> Void,
        _ work: @escaping () async throws -> Void
    ) async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await work()
        } catch APIError.unauthorized {
            revert()
            await appState.handleUnauthorized()
        } catch {
            // The optimistic value goes back rather than staying on screen: a
            // status the server never accepted is a lie the operator would act
            // on.
            revert()
            saveFailed = true
        }
    }
}
