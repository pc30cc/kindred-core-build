import Foundation
import Observation

// Settings → Online support: the chat with the platform's own team
// (docs/PLATFORM_SUPPORT.md). The same rules as the Android app's
// `SupportViewModels.kt`, so the two phones behave alike.

/// The server's limits, refused here before anything is sent.
enum SupportLimits {
    /// A message body, in characters.
    static let maxBody = 4000
    /// A rating comment, in characters.
    static let maxComment = 1000
    /// A file, decoded.
    static let maxFileBytes = 2 * 1024 * 1024
    /// The six types the endpoint takes: PNG, JPEG, WebP, GIF, PDF, plain text.
    static let fileTypes: Set<String> = [
        "image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain",
    ]

    /// A MIME type as the server spells it: lower case, no parameters, and
    /// `image/jpg` taken for what it means. Nil when it is not one of the six.
    static func canonicalType(_ raw: String) -> String? {
        var type = raw.split(separator: ";").first.map(String.init) ?? raw
        type = type.trimmingCharacters(in: .whitespaces).lowercased()
        if type == "image/jpg" || type == "image/pjpeg" { type = "image/jpeg" }
        return fileTypes.contains(type) ? type : nil
    }
}

/// What an error from `/api/platform-support` means to the operator: its own
/// codes first (docs/PLATFORM_SUPPORT.md), then the app's usual wording.
func supportErrorText(_ error: Error, language: Language) -> String {
    guard let api = error as? APIError else { return Str.offlineBody(language) }
    guard case .server(let status, let message) = api else { return api.text(language) }
    let code = message ?? ""
    if code.contains("conversation_ended") { return SupportStr.conversationEnded(language) }
    if code.contains("rate_limited") { return SupportStr.rateLimited(language) }
    if code.contains("file_too_large") { return SupportStr.fileTooLarge(language) }
    if code.contains("file_type_not_allowed") { return Str.fileTypeNotAllowed(language) }
    if code.contains("support_disabled") || code.contains("support_not_configured") {
        return SupportStr.unavailable(language)
    }
    // The server's message is a code, not a sentence: the status says it
    // better in the operator's language.
    return APIError.server(status: status, message: nil).text(language)
}

private func serverCode(_ error: Error) -> String {
    if case .server(_, let message)? = error as? APIError { return message ?? "" }
    return ""
}

// MARK: - Settings

/// Settings' view of support: whether to offer it, whether the team is online
/// now, and how much of what it wrote is unread.
@MainActor
@Observable
final class SupportStatusModel {
    /// Nil until the first answer; then kept while a later read fails.
    private(set) var status: SupportStatus?

    @ObservationIgnored private let api: any SupportAPI
    @ObservationIgnored private var generation = 0

    init(api: any SupportAPI = Backend.current) {
        self.api = api
    }

    func refresh() async {
        generation += 1
        let mine = generation
        guard let fresh = try? await api.supportStatus(), mine == generation else { return }
        if fresh != status { status = fresh }
    }

    /// Reads again on the team's news and, while on screen, every minute —
    /// "online" is a clock as much as an event.
    func follow(_ signals: AsyncStream<SupportSignal>) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.listen(signals) }
            group.addTask { await self.tick() }
        }
    }

    private func listen(_ signals: AsyncStream<SupportSignal>) async {
        for await _ in signals { await refresh() }
    }

    private func tick() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: UInt64(SupportChatModel.statusInterval * 1_000_000_000))
        }
    }
}

// MARK: - The chat

/// What the support chat is showing, and so what its bottom is.
enum SupportComposerMode: Equatable, Sendable {
    /// No conversation is open: a page as fresh as the very first — the
    /// greeting, and the composer, whose first message opens a conversation.
    case fresh
    /// A conversation is open: its messages, and the composer writes to it.
    case active
    /// The conversation on screen ended while it was open here: its end and
    /// its rating, no composer, and a button that starts a new one.
    case ended
}

/// The history as the server last told it, and what is still on its way.
struct SupportChatContent: Equatable, Sendable {
    var conversations: [SupportConversation] = []
    var items: [SupportItem] = []
    var activeConversationID: String?
    var pending: [PendingSupportItem] = []
    /// The conversation on screen when none is open: one that ended while it
    /// was open here, so its end and its rating are seen. Nil for a fresh
    /// start — on arrival with nothing open, or after "Start a new
    /// conversation".
    var endedHereID: String?

    /// The conversation the chat shows: the open one, or the one that just ended here.
    var shown: SupportConversation? {
        guard let id = activeConversationID ?? endedHereID else { return nil }
        return conversations.first { $0.id == id }
    }

    /// An open conversation is written to; an ended one is not — ever. With
    /// nothing open the page starts afresh, and earlier conversations are in
    /// `closed`, not in the chat.
    var composer: SupportComposerMode {
        if activeConversationID != nil { return .active }
        if shown?.ended == true { return .ended }
        return .fresh
    }

    /// The shown conversation's messages and joins; none on a fresh page.
    var shownItems: [SupportItem] {
        guard let shown else { return [] }
        return items.filter { $0.conversationID == shown.id }
    }

    /// Every conversation that has ended, the newest first.
    var closed: [SupportConversation] { closedSupportConversations(conversations) }

    var isEmpty: Bool { shownItems.isEmpty && pending.isEmpty }
}

enum SupportChatState: Equatable, Sendable {
    case loading
    case failed(String)
    case loaded(SupportChatContent)

    var content: SupportChatContent? {
        if case .loaded(let content) = self { return content }
        return nil
    }
}

/// The conversations that have ended, the one that ended last first.
func closedSupportConversations(_ conversations: [SupportConversation]) -> [SupportConversation] {
    conversations
        .filter(\.ended)
        .sorted { ($0.endedAt ?? $0.createdAt ?? .distantPast) > ($1.endedAt ?? $1.createdAt ?? .distantPast) }
}

/// A line to know a closed conversation by: what the operator wrote first —
/// its text, or the name of the file they sent — else the team's first word.
func supportConversationPreview(_ conversationID: String, items: [SupportItem]) -> String? {
    let own = items.filter { $0.conversationID == conversationID && !$0.isJoin }
    guard let first = own.first(where: { !$0.fromTeam }) ?? own.first else { return nil }
    let text = first.body.trimmingCharacters(in: .whitespacesAndNewlines)
    if let line = text.split(whereSeparator: \.isNewline).first, !line.isEmpty { return String(line) }
    return first.attachments.first?.fileName
}

/// Rates a conversation once. A second tap while the first is on its way, or
/// after it landed, does nothing; a conversation the server says is rated
/// already, or cannot be, is simply read again. The chat and the closed
/// conversations both rate through one.
@MainActor
@Observable
final class SupportRater {
    /// Conversations whose rating is on its way; their button waits.
    private(set) var busy: Set<String> = []

    @ObservationIgnored private let api: any SupportAPI

    init(api: any SupportAPI) {
        self.api = api
    }

    enum Outcome: Equatable {
        case rated(SupportConversation)
        /// Rated already, or not ratable: read the history again.
        case stale
        case failed(Error)

        static func == (lhs: Outcome, rhs: Outcome) -> Bool {
            switch (lhs, rhs) {
            case (.rated(let a), .rated(let b)): a == b
            case (.stale, .stale), (.failed, .failed): true
            default: false
            }
        }
    }

    /// Nil when there was nothing to send: no such conversation, a score out
    /// of range, not ratable, or a rating of it already on its way.
    func rate(_ conversation: SupportConversation?, score: Int, comment: String?) async -> Outcome? {
        guard let conversation, (1...5).contains(score), conversation.canRate,
              !busy.contains(conversation.id) else { return nil }
        let id = conversation.id
        busy.insert(id)
        defer { busy.remove(id) }
        let trimmed = comment.map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(SupportLimits.maxComment)) }
        do {
            let rated = try await api.rateSupportConversation(
                id: id, score: score, comment: (trimmed?.isEmpty ?? true) ? nil : trimmed
            )
            return .rated(rated)
        } catch {
            let code = serverCode(error)
            if code.contains("already_rated") || code.contains("not_ratable") { return .stale }
            return .failed(error)
        }
    }
}

/// The support chat: the conversation that is open, or — with none open — a
/// fresh page like the very first, and the composer that writes to it. The
/// conversations that ended are in `SupportChatContent.closed`, read in their
/// own screen (`SupportArchiveModel`).
///
/// A message or a file shows at once as "sending" and becomes the server's
/// when it lands; one that fails stays, marked, with a retry. The client id
/// travels with every attempt — and a file's bytes stay with it — so a retry
/// never posts twice. Messages go one at a time, in the order they were
/// written.
///
/// Each names the conversation it was written to: the open one, or none for
/// the first message of a new one. Once a conversation has ended nothing more
/// is written to it: the composer gives way to the end and a button that
/// starts a new conversation, and a message the team's close overtook is
/// refused by the server (`conversation_ended`) and handed back to the
/// composer, never moved to another conversation.
@MainActor
@Observable
final class SupportChatModel {
    /// How often the history is read while the chat is on screen without the
    /// operator's channel; with it, a safety net only.
    static let historyInterval: TimeInterval = 15
    static let historySafetyInterval: TimeInterval = 30
    /// How often the team's presence is read while on screen.
    static let statusInterval: TimeInterval = 60

    private(set) var state: SupportChatState = .loading
    /// Who answers and whether they are there: the bar, the offline banner, the hours.
    private(set) var status: SupportStatus?
    var draft = ""
    /// Something to tell the operator once, as an alert.
    var notice: String?
    /// Bumped when the composer should take the keyboard — after "Start a
    /// new conversation", or when a refused message is handed back.
    private(set) var focusRequest = 0

    let rater: SupportRater
    /// The operator's language, for what this model writes itself.
    var language: Language = .en
    /// The session is gone: the screen signs the operator out.
    @ObservationIgnored var onUnauthorized: (@MainActor () async -> Void)?
    /// Whether the operator's own channel is joined, which relaxes polling.
    @ObservationIgnored var isRealtimeUp: @MainActor () -> Bool = { false }

    @ObservationIgnored private let api: any SupportAPI
    @ObservationIgnored private var opened = false
    @ObservationIgnored private var workspaceID: String?
    @ObservationIgnored private var historyGeneration = 0
    @ObservationIgnored private var statusGeneration = 0
    /// One message on the wire at a time: they arrive in the order written.
    @ObservationIgnored private var sendChain: Task<Void, Never>?
    /// On screen and in front of the operator: what the team writes is being read.
    @ObservationIgnored private(set) var isVisible = false
    /// The team's messages as of the last read, to tell what is new since.
    @ObservationIgnored private var knownTeamItems: Set<String>?
    @ObservationIgnored private var teamNewsUnread = false
    /// Bumped each time the chat is marked read, so a count asked for before
    /// that is not taken for news.
    @ObservationIgnored private var readMarks = 0
    @ObservationIgnored private let makeClientID: () -> String

    init(api: any SupportAPI = Backend.current, makeClientID: @escaping () -> String = { UUID().uuidString }) {
        self.api = api
        self.rater = SupportRater(api: api)
        self.makeClientID = makeClientID
    }

    var content: SupportChatContent? { state.content }

    // MARK: Reading

    /// The first look. Later ones are `refresh` and the signals.
    func open(workspaceID: String?) async {
        self.workspaceID = workspaceID
        guard !opened else { return }
        opened = true
        await refresh()
    }

    func refresh() async {
        async let statusRead: Void = loadStatus()
        async let historyRead: Void = loadHistory()
        _ = await (statusRead, historyRead)
    }

    func loadHistory() async {
        historyGeneration += 1
        let mine = historyGeneration
        do {
            let history = try await api.supportHistory()
            guard mine == historyGeneration else { return }
            apply(history)
            await markReadIfDue()
        } catch {
            guard mine == historyGeneration else { return }
            if case .unauthorized? = error as? APIError {
                await onUnauthorized?()
                return
            }
            // A read that fails over a chat on screen keeps it; only a chat
            // that never arrived shows the failure.
            if state.content == nil { state = .failed(supportErrorText(error, language: language)) }
        }
    }

    func loadStatus() async {
        statusGeneration += 1
        let mine = statusGeneration
        let marksBefore = readMarks
        guard var fresh = try? await api.supportStatus(), mine == statusGeneration else { return }
        // Counted before this phone said it had read them: they are read.
        if readMarks != marksBefore { fresh.unread = 0 }
        status = fresh
        await markReadIfDue()
    }

    private func apply(_ history: SupportHistory) {
        let delivered = Set(history.items.compactMap(\.clientMessageID))
        let previous = state.content
        let endedHere: String?
        if history.activeConversationID != nil || previous == nil {
            // Arriving, an open conversation is shown, else a fresh page.
            endedHere = nil
        } else {
            // Already here, the conversation on screen stays when it ends,
            // until the operator starts a new one.
            endedHere = (previous?.activeConversationID ?? previous?.endedHereID)
                .flatMap { id in history.conversations.contains { $0.id == id } ? id : nil }
        }
        let next = SupportChatContent(
            conversations: history.conversations,
            items: history.items,
            activeConversationID: history.activeConversationID,
            pending: (previous?.pending ?? []).filter { !delivered.contains($0.clientMessageID) },
            endedHereID: endedHere
        )
        if state != .loaded(next) { state = .loaded(next) }

        let team = Set(history.items.filter { $0.fromTeam && !$0.isJoin }.map(\.id))
        if let known = knownTeamItems, !team.isSubset(of: known) { teamNewsUnread = true }
        knownTeamItems = team
    }

    /// Tells the server the chat has been read — while it is on screen, and
    /// only when there is something to read: an unread count, or a reply
    /// that arrived since the last look.
    private func markReadIfDue() async {
        guard isVisible else { return }
        let unread = (status?.unread ?? 0) > 0
        guard unread || teamNewsUnread else { return }
        teamNewsUnread = false
        status?.unread = 0
        readMarks += 1
        try? await api.markSupportRead()
    }

    // MARK: Writing

    /// After the conversation on screen ended: a fresh page, as at the very
    /// first, whose first message opens a new conversation.
    func startNewConversation() {
        guard var content = state.content, content.composer == .ended else { return }
        content.endedHereID = nil
        state = .loaded(content)
        focusRequest += 1
    }

    func send() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        guard body.count <= SupportLimits.maxBody else {
            notice = SupportStr.messageTooLong(language, limit: SupportLimits.maxBody)
            return
        }
        let id = makeClientID()
        guard enqueue({ target in
            PendingSupportItem(clientMessageID: id, body: body, createdAt: Date(), conversationID: target)
        }) else { return }
        draft = ""
    }

    /// A picked file. Refused here, before a byte is sent, when the server
    /// would refuse it: over 2 MB, or not one of the six types.
    func sendFile(data: Data, fileName: String, mimeType: String) {
        guard let type = SupportLimits.canonicalType(mimeType) else {
            notice = Str.fileTypeNotAllowed(language)
            return
        }
        guard data.count <= SupportLimits.maxFileBytes else {
            notice = SupportStr.fileTooLarge(language)
            return
        }
        let id = makeClientID()
        let upload = SupportUpload(data: data, fileName: fileName, mimeType: type)
        _ = enqueue { target in
            PendingSupportItem(clientMessageID: id, body: "", createdAt: Date(), file: upload, conversationID: target)
        }
    }

    /// Tries a message or file that did not go through again, with the same id.
    func retry(_ clientMessageID: String) {
        guard var content = state.content,
              let index = content.pending.firstIndex(where: { $0.clientMessageID == clientMessageID && $0.failed })
        else { return }
        content.pending[index].failed = false
        let again = content.pending[index]
        state = .loaded(content)
        deliver(again)
    }

    /// Waits for everything handed to the wire so far. For tests.
    func settle() async {
        await sendChain?.value
    }

    /// Adds what `make` writes — to the open conversation, or, on a fresh
    /// page, to a new one — and sends it. Nothing is written to a
    /// conversation that ended on screen; the operator starts a new one.
    private func enqueue(_ make: (String?) -> PendingSupportItem) -> Bool {
        guard var content = state.content, content.composer != .ended else { return false }
        let entry = make(content.activeConversationID)
        content.pending.append(entry)
        state = .loaded(content)
        deliver(entry)
        return true
    }

    private func deliver(_ entry: PendingSupportItem) {
        let previous = sendChain
        sendChain = Task { @MainActor [weak self] in
            await previous?.value
            await self?.transmit(entry)
        }
    }

    private func transmit(_ entry: PendingSupportItem) async {
        do {
            let result: SupportPostResult
            if let file = entry.file {
                result = try await api.sendSupportAttachment(
                    fileName: file.fileName, mimeType: file.mimeType, data: file.data,
                    clientMessageID: entry.clientMessageID,
                    conversationID: entry.conversationID, workspaceID: workspaceID
                )
            } else {
                result = try await api.sendSupportMessage(
                    body: entry.body, clientMessageID: entry.clientMessageID,
                    conversationID: entry.conversationID, workspaceID: workspaceID
                )
            }
            merge(result, clientMessageID: entry.clientMessageID)
            // The team may have answered already, or joined: read the chat as
            // the server has it.
            await loadHistory()
        } catch {
            if case .unauthorized? = error as? APIError {
                await onUnauthorized?()
                return
            }
            if serverCode(error).contains("conversation_ended") {
                await handBack(entry)
                return
            }
            guard var content = state.content else { return }
            if let index = content.pending.firstIndex(where: { $0.clientMessageID == entry.clientMessageID }) {
                content.pending[index].failed = true
                state = .loaded(content)
            }
            notice = supportErrorText(error, language: language)
        }
    }

    /// The team ended the conversation while `entry` was on its way to it:
    /// it leaves the transcript, its words go back to the composer for a new
    /// conversation, and the chat is read again to show the end.
    private func handBack(_ entry: PendingSupportItem) async {
        if var content = state.content {
            let ended = content.activeConversationID == entry.conversationID ? content.activeConversationID : nil
            content.pending.removeAll { $0.clientMessageID == entry.clientMessageID }
            if content.activeConversationID == entry.conversationID { content.activeConversationID = nil }
            content.endedHereID = ended ?? content.endedHereID
            state = .loaded(content)
        }
        if entry.file == nil {
            let current = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            draft = current.isEmpty ? entry.body : draft + "\n" + entry.body
        }
        notice = SupportStr.conversationEnded(language)
        await loadHistory()
    }

    private func merge(_ result: SupportPostResult, clientMessageID: String) {
        guard var content = state.content else { return }
        let conversation = result.conversation
        if let index = content.conversations.firstIndex(where: { $0.id == conversation.id }) {
            content.conversations[index] = conversation
        } else {
            content.conversations.append(conversation)
        }
        if !content.items.contains(where: { $0.id == result.item.id }) { content.items.append(result.item) }
        if !conversation.ended { content.activeConversationID = conversation.id }
        content.pending.removeAll { $0.clientMessageID == clientMessageID }
        state = .loaded(content)
    }

    // MARK: Rating

    /// Rates a conversation that ended on screen — once; see `SupportRater`.
    func rate(_ conversationID: String, score: Int, comment: String?) async {
        let conversation = state.content?.conversations.first { $0.id == conversationID }
        switch await rater.rate(conversation, score: score, comment: comment) {
        case .rated(let updated)?:
            guard var content = state.content,
                  let index = content.conversations.firstIndex(where: { $0.id == updated.id }) else { return }
            content.conversations[index] = updated
            state = .loaded(content)
        case .stale?:
            await loadHistory()
        case .failed(let error)?:
            notice = supportErrorText(error, language: language)
        case nil:
            break
        }
    }

    // MARK: Following

    /// While on screen and in front of the operator: the chat is being read,
    /// the team's news arrives as signals, and — in case the channel is down
    /// — the history is read every little while too, the status every minute.
    /// Ends when the calling task is cancelled.
    func follow(_ signals: AsyncStream<SupportSignal>) async {
        isVisible = true
        defer { isVisible = false }
        // Back in front of the operator: what happened meanwhile. The first
        // time, `open`'s own read is still on its way.
        if state.content == nil { await markReadIfDue() } else { await refresh() }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.listen(signals) }
            group.addTask { await self.poll() }
        }
    }

    private func listen(_ signals: AsyncStream<SupportSignal>) async {
        for await signal in signals {
            if signal.kind == SupportSignal.resync { await refresh() } else { await loadHistory() }
        }
    }

    /// The safety net under the signals: the history every little while,
    /// the team's presence every minute.
    private func poll() async {
        var lastStatus = Date()
        while !Task.isCancelled {
            let interval = isRealtimeUp() ? Self.historySafetyInterval : Self.historyInterval
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            if Date().timeIntervalSince(lastStatus) >= Self.statusInterval {
                lastStatus = Date()
                await loadStatus()
            }
            await loadHistory()
        }
    }
}

// MARK: - Closed conversations

enum SupportArchiveState: Equatable, Sendable {
    case loading
    case failed(String)
    /// The history as the server last told it; only its ended conversations are shown.
    case loaded(conversations: [SupportConversation], items: [SupportItem])
}

/// The conversations that ended: the list, the newest first, and one of them
/// read back with its end and its rating. Nothing here is written to — a new
/// question is a new conversation, in the chat.
@MainActor
@Observable
final class SupportArchiveModel {
    private(set) var state: SupportArchiveState = .loading
    var notice: String?
    let rater: SupportRater
    var language: Language = .en
    @ObservationIgnored var onUnauthorized: (@MainActor () async -> Void)?

    @ObservationIgnored private let api: any SupportAPI
    @ObservationIgnored private var opened = false
    @ObservationIgnored private var generation = 0

    init(api: any SupportAPI = Backend.current) {
        self.api = api
        self.rater = SupportRater(api: api)
    }

    var closed: [SupportConversation] {
        guard case .loaded(let conversations, _) = state else { return [] }
        return closedSupportConversations(conversations)
    }

    func conversation(_ id: String) -> SupportConversation? {
        guard case .loaded(let conversations, _) = state else { return nil }
        return conversations.first { $0.id == id }
    }

    func items(of id: String) -> [SupportItem] {
        guard case .loaded(_, let items) = state else { return [] }
        return items.filter { $0.conversationID == id }
    }

    func preview(_ id: String) -> String? {
        guard case .loaded(_, let items) = state else { return nil }
        return supportConversationPreview(id, items: items)
    }

    func open() async {
        guard !opened else { return }
        opened = true
        await load()
    }

    func load() async {
        generation += 1
        let mine = generation
        do {
            let history = try await api.supportHistory()
            guard mine == generation else { return }
            let next = SupportArchiveState.loaded(conversations: history.conversations, items: history.items)
            if next != state { state = next }
        } catch {
            guard mine == generation else { return }
            if case .unauthorized? = error as? APIError {
                await onUnauthorized?()
                return
            }
            if case .loaded = state { return }
            state = .failed(supportErrorText(error, language: language))
        }
    }

    /// Read again on the team's news: a conversation reopened, or a reply to
    /// an old one. Ends when the calling task is cancelled.
    func follow(_ signals: AsyncStream<SupportSignal>) async {
        for await signal in signals where signal.kind != SupportSignal.read {
            await load()
        }
    }

    func rate(_ conversationID: String, score: Int, comment: String?) async {
        switch await rater.rate(conversation(conversationID), score: score, comment: comment) {
        case .rated(let updated)?:
            guard case .loaded(var conversations, let items) = state,
                  let index = conversations.firstIndex(where: { $0.id == updated.id }) else { return }
            conversations[index] = updated
            state = .loaded(conversations: conversations, items: items)
        case .stale?:
            await load()
        case .failed(let error)?:
            notice = supportErrorText(error, language: language)
        case nil:
            break
        }
    }
}
