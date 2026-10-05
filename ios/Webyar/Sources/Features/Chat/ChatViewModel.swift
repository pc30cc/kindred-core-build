import SwiftUI
import Observation

/// One day's worth of transcript, so the view can put a date header above it.
struct MessageDay: Identifiable, Sendable {
    let id: Date
    let messages: [Message]
}

/// A message typed on this phone that the server has not confirmed yet.
///
/// Its `clientID` is chosen once, when the operator presses Send, and is the
/// same on every attempt to deliver that message: the server collapses a
/// replay of the same key, so a retry after a timeout — when the first try
/// may well have landed — can never send it twice.
struct OutgoingMessage: Identifiable, Equatable, Sendable {
    let clientID: String
    let body: String
    let createdAt: Date
    /// A photo already uploaded from the composer, drawn from this phone's
    /// own copy until the server's row replaces the bubble.
    var attachment: MessageAttachment? = nil
    var id: String { Self.localID(clientID) }

    static let localPrefix = "local:"
    static func localID(_ clientID: String) -> String { localPrefix + clientID }
}

extension Message {
    /// Drawn from this phone's outbox: not on the server yet.
    var isPending: Bool { id.hasPrefix(OutgoingMessage.localPrefix) }
}

@MainActor
@Observable
final class ChatViewModel {

    /// The transcript: the server's messages, then any still being sent.
    private(set) var state: LoadState<[Message]> = .loading
    /// How fresh the transcript is — `offline` keeps the saved copy on screen
    /// with a notice instead of replacing it with an error.
    private(set) var syncStatus: SyncStatus = .idle
    private(set) var isSending = false
    private(set) var sendFailed = false
    /// Device and location behind this thread, for the header avatar.
    private(set) var visitor: VisitorProfile?
    /// The photo waiting in the composer, if any.
    let photos: PhotoStager
    /// Goes up each time the operator sends something: the transcript
    /// follows their own message to the bottom wherever they were reading.
    private(set) var sentCount = 0

    var draft = ""

    @ObservationIgnored private let conversation: Conversation
    @ObservationIgnored private let api: any WebyarAPI
    @ObservationIgnored private let sync: SyncCoordinator
    @ObservationIgnored private var thread = ThreadSync()
    @ObservationIgnored private var outbox: [OutgoingMessage] = []
    /// The account and workspace this screen was opened in: an answer that
    /// lands after either changed is dropped, never shown or saved.
    @ObservationIgnored private let generation: Int
    @ObservationIgnored private var didStart = false
    @ObservationIgnored private var isReading = false
    @ObservationIgnored private var readAgain = false
    @ObservationIgnored private var saving: Task<Void, Never>?
    @ObservationIgnored private var readSoon: Task<Void, Never>?
    @ObservationIgnored private weak var appState: AppState?
    /// The last text send that failed, and the key it went out with. Sending
    /// the same words again reuses the key — the first attempt may have
    /// reached the server even though its answer never reached us.
    @ObservationIgnored private var lastFailedSend: (body: String, clientID: String, attachmentID: String?)?
    @ObservationIgnored private var lastSeenMarked: String?

    init(conversation: Conversation, api: any WebyarAPI = Backend.current, sync: SyncCoordinator = .shared) {
        self.conversation = conversation
        self.api = api
        self.sync = sync
        generation = sync.scopeGeneration
        photos = PhotoStager()
        photos.onUnauthorized = { [weak self] in await self?.appState?.handleUnauthorized() }
    }

    /// Something to send, and nothing holding it: a photo still uploading
    /// (or failed) keeps Send off until it is ready or taken out.
    var canSend: Bool {
        guard !isSending else { return false }
        if photos.photo != nil { return photos.attachmentID != nil }
        return !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

    private var isCurrentScope: Bool { generation == sync.scopeGeneration }

    // MARK: - Loading

    /// Opens the thread: the copy saved on this phone at once, then only what
    /// changed since (a delta from the saved cursor). Called again — by the
    /// retry button, after the AI speaks — it is a read of what changed.
    func load(appState: AppState) async {
        self.appState = appState
        if !didStart {
            didStart = true
            if let store = sync.store(for: conversation.workspaceId),
               let saved = await store.thread(conversation.id),
               isCurrentScope, thread.applyCached(saved) {
                publish()
            }
            await loadVisitor()
        }
        await read()
    }

    /// Reads now, or right after the read already running — never two at
    /// once, and never a burst of them for a burst of events.
    private func read() async {
        if isReading {
            readAgain = true
            return
        }
        isReading = true
        defer { isReading = false }
        repeat {
            readAgain = false
            await readOnce()
        } while readAgain && isCurrentScope
    }

    private func readOnce() async {
        let request = thread.beginFetch()
        do {
            let page = try await api.messagePage(conversationID: conversation.id, since: request.since)
            guard isCurrentScope else {
                thread.fetchFailed(transport: true)
                return
            }
            let applied = thread.applyResponse(page)
            if let write = applied.write { save(write) }
            syncStatus = .idle
            if applied.changed || !state.isLoaded { publish() }
            markSeenIfLooking()
        } catch APIError.unauthorized {
            thread.fetchFailed(transport: true)
            await appState?.handleUnauthorized()
        } catch let error as APIError {
            thread.fetchFailed(transport: error == .transport)
            guard isCurrentScope else { return }
            if case .server(let status, _) = error, status == 404 || status == 403 {
                // Deleted, or no longer this operator's to read: the saved
                // copy must not outlive it.
                await sync.store(for: conversation.workspaceId)?.forgetConversation(conversation.id)
                state = .failed(error)
                return
            }
            if state.isLoaded {
                syncStatus = error == .transport ? .offline : .failed(error)
            } else {
                state = .failed(error)
            }
        } catch {
            thread.fetchFailed(transport: true)
            guard isCurrentScope else { return }
            if state.isLoaded { syncStatus = .offline } else { state = .failed(.transport) }
        }
    }

    /// The server's rows (never the outbox), written in order so an older
    /// copy never lands after a newer one.
    private func save(_ write: ThreadWrite) {
        guard let store = sync.store(for: conversation.workspaceId) else { return }
        let id = conversation.id, cursor = thread.cursor, fullAt = thread.fullAt
        let previous = saving
        saving = Task {
            await previous?.value
            await store.saveThread(id, write, cursor: cursor, fullAt: fullAt)
        }
    }

    /// What the screen shows: the server's messages, then the ones still on
    /// their way — each outbox entry only until its key comes back on a
    /// server row, by a read, by realtime or by both.
    private func publish() {
        let delivered = Set(thread.messages.compactMap(\.clientMessageID))
        outbox.removeAll { delivered.contains($0.clientID) }
        if let failed = lastFailedSend, delivered.contains(failed.clientID) {
            // The send that "failed" had reached the server after all: its
            // words are on screen, so they leave the composer.
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == failed.body { draft = "" }
            if let attachmentID = failed.attachmentID, photos.attachmentID == attachmentID {
                photos.discard()
            }
            lastFailedSend = nil
            sendFailed = false
        }
        let me = appState?.session.user
        let pending = outbox.map { outgoing in
            Message(
                id: outgoing.id, conversationId: conversation.id, senderType: .agent,
                senderId: me?.id, body: outgoing.body, createdAt: outgoing.createdAt,
                senderName: me?.displayName, senderAvatar: appState?.myAvatarURL,
                metadata: ["client_message_id": .string(outgoing.clientID)],
                attachments: outgoing.attachment.map { [$0] }
            )
        }
        let next = thread.messages + pending
        if case .loaded(let current) = state, current == next { return }
        state = .loaded(next)
    }

    /// Seen once per new visitor message, and only while someone is
    /// actually looking at this thread.
    private func markSeenIfLooking() {
        guard sync.isForeground, PushController.shared.viewing == conversation.id,
              let newest = thread.messages.last(where: { $0.senderType == .contact })?.id,
              newest != lastSeenMarked
        else { return }
        lastSeenMarked = newest
        let id = conversation.id
        Task { [api, sync] in
            guard (try? await api.markSeen(conversationID: id)) != nil else { return }
            sync.emit(.seen(conversationID: id))
        }
    }

    /// Kept in memory for a while and shared with the inbox, so opening a
    /// thread from the list does not ask again for what the list just read.
    private func loadVisitor() async {
        if let known = VisitorIntelCache.shared.profile(for: conversation.id) {
            visitor = known
            return
        }
        let workspaceID = conversation.workspaceId
        guard let fetched = try? await api.visitorIntel(workspaceID: workspaceID, conversationIDs: [conversation.id]) else { return }
        VisitorIntelCache.shared.store(fetched, workspaceID: workspaceID)
        visitor = fetched[conversation.id]
    }

    // MARK: - Staying fresh

    /// Listens for as long as the screen exists. A realtime message shows at
    /// once and a delta follows to fill in its sender and files; a push or
    /// the return to the foreground reads what changed; without realtime the
    /// thread is polled — a delta, a few hundred bytes — while it is open.
    func listen() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.consumeEvents() }
            group.addTask { await self.poll() }
        }
    }

    private func consumeEvents() async {
        for await event in sync.events() {
            guard isCurrentScope else { continue }
            switch event {
            case .message(let conversationID, let row):
                guard conversationID == conversation.id else { continue }
                if let row, row.conversationId == conversation.id, thread.applyRealtime(row) { publish() }
                readShortly()
            case .conversationChanged(let conversationID):
                guard conversationID == nil || conversationID == conversation.id else { continue }
                readShortly()
            case .push(let conversationID, let messageID):
                guard conversationID == conversation.id else { continue }
                // Already here (realtime was faster): nothing to read for it.
                if let messageID, thread.contains(messageID: messageID) { continue }
                readShortly()
            case .resync:
                readShortly()
            case .reconcile:
                thread.requireWholeRead()
                readShortly()
            case .team, .seen:
                continue
            }
        }
    }

    private func poll() async {
        while !Task.isCancelled {
            let interval = sync.realtimeConnected ? CachePolicy.threadSafetyInterval : CachePolicy.threadPollInterval
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            guard sync.isForeground, isCurrentScope else { continue }
            await read()
        }
    }

    /// One read for a burst of events.
    private func readShortly() {
        readSoon?.cancel()
        readSoon = Task {
            try? await Task.sleep(nanoseconds: UInt64(CachePolicy.realtimeDeltaDelay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await read()
        }
    }

    // MARK: - Sending

    /// Advisory, and deliberately fire-and-forget: the count only orders the
    /// picker, so a failure to record one must never surface to the operator
    /// or hold up the message that was just sent.
    func recordShortcutUse(_ id: String, workspaceID: String?) {
        guard let workspaceID else { return }
        Task { [api] in try? await api.trackCannedResponseUse(id: id, workspaceID: workspaceID) }
    }

    func send(appState: AppState) async {
        self.appState = appState
        guard canSend else { return }
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // The photo in the composer goes with the words, as one message.
        let photo = photos.takeForSending()
        let attachmentID = photo?.attachmentID

        // The same words (and photo) after a failure are the same message:
        // same key.
        let clientID: String
        if let failed = lastFailedSend, failed.body == body, failed.attachmentID == attachmentID {
            clientID = failed.clientID
        } else {
            clientID = UUID().uuidString
        }
        lastFailedSend = nil

        isSending = true
        sendFailed = false

        // Clear the field straight away — a composer that stays full while a
        // request is in flight invites a second tap and a duplicate message —
        // and show the message at once, marked as still on its way.
        draft = ""
        var outgoing = OutgoingMessage(clientID: clientID, body: body, createdAt: Date())
        if let photo, let attachmentID {
            // The bubble draws this phone's copy at once, and so does the
            // server's row that replaces it: both look the file up by its id.
            AttachmentPreviews.store(photo.preview, for: attachmentID)
            outgoing.attachment = MessageAttachment(
                id: attachmentID, fileName: photo.fileName, mimeType: photo.mimeType,
                sizeBytes: photo.sizeBytes, kind: MessageAttachment.Kind.image.rawValue
            )
        }
        outbox.append(outgoing)
        publish()
        sentCount += 1

        do {
            try await api.send(
                body: body,
                conversationID: conversation.id,
                workspaceID: conversation.workspaceId,
                // The server collapses a replay of the same key, so this is
                // what makes a retry safe rather than duplicating.
                clientMessageID: clientID,
                attachmentID: attachmentID
            )
            if let photo { photos.sent(photo) }
            // The row itself comes back by realtime or by this delta —
            // whichever is first — and replaces the pending bubble. Not the
            // whole thread again.
            await read()
        } catch APIError.unauthorized {
            outbox.removeAll { $0.clientID == clientID }
            publish()
            await appState.handleUnauthorized()
        } catch {
            if thread.messages.contains(where: { $0.clientMessageID == clientID }) {
                // It landed; only the answer was lost. Nothing to hand back.
                outbox.removeAll { $0.clientID == clientID }
                publish()
            } else {
                outbox.removeAll { $0.clientID == clientID }
                publish()
                // Hand the text and the photo back so nothing the operator
                // put in is lost — and keep the key for when they press Send
                // again. The photo is already uploaded; it does not go again.
                if draft.isEmpty { draft = body }
                if let photo { photos.putBack(photo) }
                lastFailedSend = (body, clientID, attachmentID)
                sendFailed = true
            }
        }

        isSending = false
    }

    // MARK: - A photo in the composer

    /// Puts a picked photo in the composer and starts uploading it.
    func stagePhoto(data: Data, fileName: String, mimeType: String, appState: AppState) async {
        self.appState = appState
        let conversation = conversation
        let staged = await photos.stage(data: data, fileName: fileName, mimeType: mimeType) { [api] data, fileName, mimeType, onProgress in
            try await api.uploadAttachment(
                conversationID: conversation.id, workspaceID: conversation.workspaceId,
                fileName: fileName, mimeType: mimeType, data: data, onProgress: onProgress
            )
        }
        if !staged { sendFailed = true }
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
        self.appState = appState
        guard !isSending else { return }
        let caption = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // One key for this message, whatever happens between the steps.
        let clientID = UUID().uuidString

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
                clientMessageID: clientID,
                attachmentID: attachmentID
            )
            await read()
            sentCount += 1
            Haptics.success()
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            if draft.isEmpty { draft = caption }
            sendFailed = true
        }

        isSending = false
    }

    /// Reads what changed — after the AI spoke, or anything else that wants
    /// the transcript current. Never the whole thread for its own sake.
    func reload(appState: AppState) async {
        self.appState = appState
        await read()
    }

    func dismissSendError() {
        sendFailed = false
    }
}
