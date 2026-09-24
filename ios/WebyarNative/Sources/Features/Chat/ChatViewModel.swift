import SwiftUI
import Observation

/// One day's worth of transcript, so the view can put a date header above it.
struct MessageDay: Identifiable, Sendable {
    let id: Date
    let messages: [Message]
}

@MainActor
@Observable
final class ChatViewModel {

    private(set) var state: LoadState<[Message]> = .loading
    private(set) var isSending = false
    private(set) var sendFailed = false
    /// Device and location behind this thread, for the header avatar.
    private(set) var visitor: VisitorProfile?
    /// Whether that read is still outstanding, so the header can show a
    /// skeleton rather than initials it is about to replace.
    private(set) var isResolvingVisitor = true

    var draft = ""

    private let conversation: Conversation
    private let api: any WebyarAPI

    init(conversation: Conversation, api: any WebyarAPI = Backend.current) {
        self.conversation = conversation
        self.api = api
    }

    var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    /// Messages grouped into calendar days, oldest first — the order a
    /// transcript reads in.
    func days(calendar: Calendar) -> [MessageDay] {
        guard let messages = state.value else { return [] }

        let dated = messages
            .filter { $0.createdAt != nil }
            .sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }

        var groups: [Date: [Message]] = [:]
        for message in dated {
            guard let created = message.createdAt else { continue }
            let day = calendar.startOfDay(for: created)
            groups[day, default: []].append(message)
        }

        return groups.keys.sorted().map { MessageDay(id: $0, messages: groups[$0] ?? []) }
    }

    func load(appState: AppState) async {
        do {
            let messages = try await api.messages(conversationID: conversation.id)
            state = .loaded(messages)
            // Both of these are side effects of reading: neither may turn a
            // loaded transcript into a failure.
            try? await api.markSeen(conversationID: conversation.id)
            visitor = try? await api.visitorIntel(
                workspaceID: conversation.workspaceId,
                conversationIDs: [conversation.id]
            )[conversation.id]
            isResolvingVisitor = false
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch let error as APIError {
            state = .failed(error)
        } catch {
            state = .failed(.transport)
        }
    }

    /// Advisory, and deliberately fire-and-forget: the count only orders the
    /// picker, so a failure to record one must never surface to the operator
    /// or hold up the message that was just sent.
    func recordShortcutUse(_ id: String, workspaceID: String?) {
        guard let workspaceID else { return }
        Task { [api] in try? await api.trackCannedResponseUse(id: id, workspaceID: workspaceID) }
    }

    func send(appState: AppState) async {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }

        isSending = true
        sendFailed = false

        // Clear the field straight away — a composer that stays full while a
        // request is in flight invites a second tap and a duplicate message.
        draft = ""

        do {
            try await api.send(
                body: body,
                conversationID: conversation.id,
                workspaceID: conversation.workspaceId,
                // The server collapses a replay of the same key, so this is
                // what makes a retry safe rather than duplicating.
                clientMessageID: UUID().uuidString,
                attachmentID: nil
            )
            await reload(appState: appState)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // Hand the text back so nothing the operator typed is lost.
            draft = body
            sendFailed = true
        }

        isSending = false
    }

    /// Sends a file, with whatever is in the composer as its caption.
    ///
    /// Three server round-trips — reserve, upload, send — so the progress
    /// flag stays up for the whole thing rather than only the last step. The
    /// caption is cleared optimistically like a text send, and handed back on
    /// failure for the same reason.
    func sendAttachment(
        data: Data,
        fileName: String,
        mimeType: String,
        appState: AppState
    ) async {
        guard !isSending else { return }
        let caption = draft.trimmingCharacters(in: .whitespacesAndNewlines)

        isSending = true
        sendFailed = false
        draft = ""

        do {
            let attachmentID = try await api.uploadAttachment(
                conversationID: conversation.id,
                workspaceID: conversation.workspaceId,
                fileName: fileName,
                mimeType: mimeType,
                data: data
            )
            try await api.send(
                body: caption,
                conversationID: conversation.id,
                workspaceID: conversation.workspaceId,
                clientMessageID: UUID().uuidString,
                attachmentID: attachmentID
            )
            await reload(appState: appState)
            Haptics.success()
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            draft = caption
            sendFailed = true
        }

        isSending = false
    }

    /// Whether this transcript already contains a given message.
    ///
    /// The live channel carries the operator's own replies back to them, and
    /// a send has already re-read the thread by the time that arrives. This
    /// is what stops the echo costing a second round trip.
    func has(messageID: String) -> Bool {
        state.value?.contains { $0.id == messageID } ?? false
    }

    func reload(appState: AppState) async {
        do {
            let messages = try await api.messages(conversationID: conversation.id)
            state = .loaded(messages)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // Keep the transcript we have.
        }
    }

    func dismissSendError() {
        sendFailed = false
    }
}
