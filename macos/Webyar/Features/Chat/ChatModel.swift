import AppKit
import Foundation
import Observation

/// A row of the thread: a message, a notice, or a day separator.
struct ChatRow: Identifiable, Equatable {
    enum Side { case incoming, outgoing, system, day }

    var id: String
    var side: Side
    var body: String
    var time = ""
    var createdAt: Date?
    var isAi = false
    var senderId: String?
    var senderName = ""
    var avatarName = ""
    var avatarURL: String?
    var attachments: [AttachmentInfo] = []
    /// The avatar and the name · time line sit under the last bubble of a run.
    var showAvatar = true
    var showMeta = true
    var pending = false
    var failed = false
    var clientId: String?

    /// Who sent it; a change of sender starts a new run of bubbles.
    var runKey: String {
        switch side {
        case .outgoing: return isAi ? "ai" : (senderId ?? "agent")
        case .incoming: return "in"
        case .system: return "sys"
        case .day: return "day"
        }
    }

    var meta: String {
        if failed { return time }
        return side == .outgoing && !senderName.isEmpty ? "\(senderName) · \(time)" : time
    }

    static func from(_ m: Message, _ s: Strings) -> ChatRow {
        let side: Side = m.isSystem ? .system : m.isOutgoing ? .outgoing : .incoming
        var r = ChatRow(id: m.id, side: side, body: side == .system ? (SystemText.of(m.metadata, s) ?? m.body) : m.body)
        r.createdAt = m.createdAt
        r.time = m.createdAt.map { Display.clockTime($0, s.language) } ?? ""
        r.isAi = m.senderType == SenderType.ai || m.senderType == SenderType.bot
        r.senderId = m.senderId
        if side == .outgoing {
            r.avatarURL = r.isAi ? nil : m.senderAvatar
            r.avatarName = r.isAi ? "" : (m.senderName ?? "")
        }
        if r.isAi {
            r.senderName = (m.senderName ?? "").isEmpty ? s["aiReply"] : m.senderName!
        } else {
            r.senderName = m.senderName ?? ""
        }
        r.attachments = (m.attachments ?? []).map { AttachmentInfo($0, s) }
        return r
    }
}

/// One thread: the conversation's header state and actions, the messages
/// with their files, the reply box and the details beside it — the Windows
/// app's ChatView and DetailsPanel, as a model.
@MainActor
@Observable
final class ChatModel {
    static let maxUpload = 20 * 1024 * 1024
    /// "specialist" or "assistant", kept for the session as on iOS and Windows.
    static var voice = "specialist"

    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var poller: Poller?
    @ObservationIgnored private var events: Signal<InboxEvent>.Token?
    @ObservationIgnored private var lastSeenMessage: String?
    @ObservationIgnored private var outbox: [ChatRow] = []
    @ObservationIgnored var onChanged: (() -> Void)?
    @ObservationIgnored private var loggedPhotos = false

    let id: String
    private(set) var conversation: Conversation?
    private(set) var rows: [ChatRow] = []
    /// Bumped each time this operator sends, so the thread scrolls to the bottom.
    private(set) var sentCount = 0
    private(set) var loading = true
    private(set) var busy = false

    struct Notice: Equatable {
        var severity: Banner.Severity
        var message: String
        var retry = false
    }
    var notice: Notice?

    /// False when the thread was opened with the arrow keys: the list keeps the keyboard.
    @ObservationIgnored var focusComposerOnOpen = true

    // Composer
    var draft = ""
    /// What Send does after sending, remembered per operator as on the web; Enter runs it.
    var sendAction: PostSendAction = .none {
        didSet { UserDefaults.standard.set(sendAction.rawValue, forKey: sendActionKey) }
    }
    var pendingFile: (name: String, mime: String, data: Data)?
    var voice = ChatModel.voice { didSet { ChatModel.voice = voice } }
    let recorder = VoiceRecorder()

    // Details
    private(set) var notes: [ConversationNote] = []
    private(set) var profile: VisitorProfile?

    init(app: AppModel, id: String, conversation: Conversation?) {
        self.app = app
        self.id = id
        self.conversation = conversation
        sendAction = UserDefaults.standard.string(forKey: sendActionKey).flatMap(PostSendAction.init(rawValue:)) ?? .none
    }

    var aiMode: Bool { conversation?.isAiManaged == true }

    #if DEBUG
    /// The thread on screen, for the debug command file.
    nonisolated(unsafe) static weak var debugCurrent: ChatModel?
    func debugRefresh() { poller?.kick() }
    #endif

    func start() {
        #if DEBUG
        Self.debugCurrent = self
        #endif
        poller = Poller("thread", interval: { [weak self] in
            guard let self else { return 5 }
            return self.app.pollInterval(Double(min(5, self.app.config.pollIntervalSeconds)))
        }) { [weak self] in try await self?.load() }
        poller?.start()
        events = app.inboxEvents.subscribe { [weak self] e in
            if e.conversationId == nil || e.conversationId == self?.id { self?.poller?.kick() }
        }
        Task { await loadDetails() }
    }

    func close() {
        poller?.stop()
        events?.cancelNow()
        if recorder.isRecording { recorder.cancel() }
    }

    /// New list data for the open conversation: header, actions and details follow it.
    func update(_ c: Conversation) {
        guard c.id == id else { return }
        let wasAi = aiMode
        conversation = c
        if aiMode && !wasAi {
            if recorder.isRecording { recorder.cancel() }
            pendingFile = nil
        }
        refreshAvatars()
    }

    private func refreshAvatars() {
        guard let c = conversation else { return }
        for i in rows.indices where rows[i].side == .incoming {
            rows[i].avatarName = c.contacts?.name ?? ""
            rows[i].avatarURL = c.contacts?.avatarUrl
        }
    }

    // MARK: Messages

    private func load() async throws {
        defer { loading = false }
        let list = try await app.api.messages(conversationId: id)
        let s = app.strings
        if !loggedPhotos {
            // Which operator replies came with a photo link, and from where: "no photo in the chat" is
            // then a question of what the server sent, answered from the log.
            loggedPhotos = true
            let agents = list.filter { $0.senderType == SenderType.agent }
            let hosts = Set(agents.compactMap { $0.senderAvatar.flatMap { URL(string: $0)?.host ?? "relative" } })
            Log.write("[chat-photos] \(id.prefix(8)) operatorReplies=\(agents.count) withPhoto=\(agents.filter { !($0.senderAvatar ?? "").isEmpty }.count) hosts=\(hosts.sorted().joined(separator: ","))")
        }
        var wanted: [ChatRow] = []
        var day: Date?
        let cal = Calendar.current
        for m in list.sorted(by: { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }) {
            var row = ChatRow.from(m, s)
            if row.side == .incoming {
                row.avatarName = conversation?.contacts?.name ?? ""
                row.avatarURL = conversation?.contacts?.avatarUrl
            }
            if let at = row.createdAt, day.map({ !cal.isDate($0, inSameDayAs: at) }) ?? true {
                day = at
                wanted.append(ChatRow(id: "day:\(Int(cal.startOfDay(for: at).timeIntervalSince1970))", side: .day, body: Display.dayLabel(at, s)))
            }
            wanted.append(row)
        }
        // A message the server already has (its client id came back) is no longer ours to show:
        // otherwise a poll between the insert and the reply, or a 500 after the insert, shows it twice.
        let delivered = Set(list.compactMap { $0.metadata?["client_message_id"]?.string })
        if !delivered.isEmpty, outbox.contains(where: { $0.clientId.map(delivered.contains) == true }) {
            for o in outbox where o.clientId.map(delivered.contains) == true {
                if let cid = o.clientId { thenActions[cid] = nil; retryFiles[cid] = nil }
            }
            outbox.removeAll { $0.clientId.map(delivered.contains) == true }
        }
        wanted.append(contentsOf: outbox)
        Self.group(&wanted)
        if wanted != rows { rows = wanted }

        // Seen once per new message, and only while someone is actually looking.
        // Only while the thread is really on screen: the inbox keeps it open behind other pages.
        if let newest = list.last(where: { $0.senderType == SenderType.contact })?.id, newest != lastSeenMessage,
           app.isForeground, app.visibleConversationId == id {
            lastSeenMessage = newest
            Task { try? await app.api.markSeen(conversationId: id) }
        }
    }

    /// As in the web thread: the avatar and the name · time line sit under the
    /// last bubble of a run from one sender; a new day or a pause of more than
    /// five minutes starts a new run.
    static func group(_ items: inout [ChatRow]) {
        for i in items.indices {
            let m = items[i]
            guard m.side == .incoming || m.side == .outgoing else { continue }
            let next = i + 1 < items.count ? items[i + 1] : nil
            var continues = false
            if let next, next.runKey == m.runKey, next.side == m.side {
                if let b = next.createdAt, let a = m.createdAt { continues = b.timeIntervalSince(a) <= 300 } else { continues = true }
            }
            items[i].showAvatar = !continues
            items[i].showMeta = !continues || m.failed
        }
    }

    // MARK: Sending

    /// Messages that did not go out and wait for Retry.
    var hasFailed: Bool { rows.contains { $0.failed } }

    var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pendingFile != nil }

    private var sendActionKey: String { "sendAction.\(app.user?.id ?? "")" }

    /// `then` overrides the remembered action for this one message (picking it in the menu sends at once).
    func send(then override: PostSendAction? = nil) {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let file = pendingFile
        guard !body.isEmpty || file != nil, let ws = app.workspace else { return }
        sentCount += 1
        if aiMode {
            // One say-now at a time: a second Enter while the first is out would reach the visitor twice.
            guard !body.isEmpty, !busy else { return }
            busy = true
            Task { await sayNow(body) }
            return
        }
        draft = ""
        pendingFile = nil
        let s = app.strings
        let clientId = UUID().uuidString.lowercased()
        var row = ChatRow(id: clientId, side: .outgoing, body: body)
        row.clientId = clientId
        row.createdAt = Date()
        row.time = Display.clockTime(Date(), s.language)
        row.pending = true
        row.senderId = app.user?.id
        row.avatarName = app.user?.fullName ?? ""
        row.avatarURL = app.account?.avatarUrl
        if let file { row.attachments = [AttachmentInfo.local(name: file.name, mime: file.mime, data: file.data, s)] }
        outbox.append(row)
        rows.append(row)
        Self.group(&rows)
        thenActions[clientId] = override ?? sendAction
        Task { await deliver(clientId, workspaceId: ws.id, file: file) }
    }

    /// The status change each message in the outbox asked for, kept for a retry.
    @ObservationIgnored private var thenActions: [String: PostSendAction] = [:]

    private func deliver(_ clientId: String, workspaceId: String, file: (name: String, mime: String, data: Data)?) async {
        guard let i = outbox.firstIndex(where: { $0.clientId == clientId }) else { return }
        outbox[i].failed = false
        outbox[i].pending = true
        syncOutbox()
        let body = outbox[i].body
        do {
            var attachmentId: String?
            if let file {
                let server = try await app.api.uploadAttachment(workspaceId: workspaceId, conversationId: id, fileName: file.name, mimeType: file.mime, data: file.data)
                attachmentId = server
                if let local = outbox.first(where: { $0.clientId == clientId })?.attachments.first?.id {
                    AttachmentStore.shared.alias(local, server)
                }
            }
            let then = thenActions[clientId] ?? .none
            let result = try await app.api.sendMessage(conversationId: id, workspaceId: workspaceId, body: body, clientMessageId: clientId,
                                                       attachmentId: attachmentId, then: then)
            outbox.removeAll { $0.clientId == clientId }
            thenActions[clientId] = nil
            if then != .none { afterSend(then, result) }
            poller?.kick()
            onChanged?()
        } catch {
            Log.error("send", error)
            if let j = outbox.firstIndex(where: { $0.clientId == clientId }) {
                outbox[j].pending = false
                outbox[j].failed = true
                outbox[j].time = "\(app.strings["sendFailed"]) · \(outbox[j].time)"
            }
            syncOutbox()
            retryFiles[clientId] = file
            notice = Notice(severity: .error, message: ErrorText.of(error, app.strings), retry: true)
        }
    }

    /// The status the server set, on show at once; or why it left it alone.
    private func afterSend(_ then: PostSendAction, _ result: PostSendResult?) {
        if result?.changed == true {
            let next = result?.status ?? (then == .resolve ? ConversationStatus.resolved : ConversationStatus.pending)
            conversation?.status = next
        } else if let blocked = result?.blocked, blocked != "no_change" {
            notice = Notice(severity: .warning, message: app.strings["sendActionBlocked"])
        }
    }

    @ObservationIgnored private var retryFiles: [String: (name: String, mime: String, data: Data)?] = [:]

    func retryFailed() {
        notice = nil
        guard let ws = app.workspace else { return }
        for row in outbox where row.failed {
            guard let cid = row.clientId else { continue }
            if let i = outbox.firstIndex(where: { $0.clientId == cid }) {
                outbox[i].time = Display.clockTime(Date(), app.strings.language)
            }
            let file = retryFiles[cid] ?? nil
            Task { await deliver(cid, workspaceId: ws.id, file: file) }
        }
    }

    private func syncOutbox() {
        for o in outbox {
            if let i = rows.firstIndex(where: { $0.clientId == o.clientId }) { rows[i] = o }
        }
        Self.group(&rows)
    }

    /// The AI says it; the draft stays until that worked.
    private func sayNow(_ body: String) async {
        let s = app.strings
        busy = true
        defer { busy = false }
        do {
            try await app.api.aiSayNow(id, body: body, attribution: voice)
            // Keep whatever was typed while it was out.
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == body { draft = "" }
            notice = Notice(severity: .success, message: s["sayNowSent"])
            poller?.kick()
            onChanged?()
        } catch {
            Log.error("say now", error)
            notice = Notice(severity: .error, message: "\(s["sayNowFailed"]) — \(ErrorText.of(error, s))")
        }
    }

    // MARK: Files

    /// Puts a file in the composer to go out with the next Send.
    func attach(url: URL) {
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey])
            if (values.fileSize ?? 0) > Self.maxUpload {
                notice = Notice(severity: .error, message: app.strings["fileTooLarge"])
                return
            }
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            attach(name: url.lastPathComponent, mime: Mime.of(url.lastPathComponent), data: data)
        } catch {
            Log.error("pick file", error)
            notice = Notice(severity: .error, message: app.strings["attachmentFailed"])
        }
    }

    func attach(name: String, mime: String, data: Data) {
        guard !aiMode else { return }
        guard data.count <= Self.maxUpload else {
            notice = Notice(severity: .error, message: app.strings["fileTooLarge"])
            return
        }
        pendingFile = (name, mime, data)
    }

    // MARK: Voice notes

    func toggleRecording() {
        if recorder.isRecording {
            stopRecording(keep: true)
            return
        }
        Task {
            do {
                try await recorder.start()
            } catch {
                Log.error("voice record", error)
                notice = Notice(severity: .error, message: (error as? VoiceRecorder.Failure) == .denied ? app.strings["micBlocked"] : app.strings["micFailed"])
            }
        }
    }

    func stopRecording(keep: Bool) {
        guard recorder.isRecording else { return }
        if !keep {
            recorder.cancel()
            return
        }
        guard let (data, length) = recorder.stop() else { return }
        // A tap on the mic by mistake is not a message.
        guard length >= 1, data.count >= 1024 else { return }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        attach(name: "voice-note-\(f.string(from: Date())).m4a", mime: "audio/mp4", data: data)
    }

    // MARK: Header actions

    func toggleStatus() {
        guard let c = conversation, let ws = app.workspace else { return }
        let next = c.isResolved ? ConversationStatus.open : ConversationStatus.resolved
        run({ try await self.app.api.updateConversation(c.id, workspaceId: ws.id, status: next) }) { $0.status = next }
    }

    /// Spam or not, as the web inbox's button: the thread moves between the queues.
    func toggleSpam() {
        guard let c = conversation, let ws = app.workspace else { return }
        let spam = c.isSpam != true
        let s = app.strings
        run({
            if spam { try await self.app.api.markSpam(c.id, workspaceId: ws.id) } else { try await self.app.api.unmarkSpam(c.id, workspaceId: ws.id) }
        }) { [weak self] in
            $0.isSpam = spam
            self?.notice = Notice(severity: .success, message: s[spam ? "markedSpamTitle" : "removedFromSpam"])
        }
    }

    func assignToMe() {
        guard let c = conversation, let ws = app.workspace, let me = app.user else { return }
        if c.isAiManaged {
            run({ try await self.app.api.takeOver(c.id, workspaceId: ws.id) }) {
                $0.assignedTo = me.id
                $0.aiState = "human_active"
                $0.metadata = nil
            }
        } else {
            run({ try await self.app.api.claim(c.id, workspaceId: ws.id) }) { $0.assignedTo = me.id }
        }
    }

    /// Open, waiting for the customer or resolved, from the details panel.
    func setStatus(_ next: String) {
        guard let c = conversation, let ws = app.workspace, c.status != next else { return }
        run({ try await self.app.api.updateConversation(c.id, workspaceId: ws.id, status: next) }) { $0.status = next }
    }

    func setPriority(_ p: String) {
        guard let c = conversation, let ws = app.workspace else { return }
        run({ try await self.app.api.updateConversation(c.id, workspaceId: ws.id, priority: p) }) { $0.priority = p }
    }

    func transfer(to userId: String) {
        guard let c = conversation, let ws = app.workspace else { return }
        run({ try await self.app.api.updateConversation(c.id, workspaceId: ws.id, assignTo: userId) }) { $0.assignedTo = userId }
    }

    func unassign() {
        guard let c = conversation, let ws = app.workspace else { return }
        run({ try await self.app.api.updateConversation(c.id, workspaceId: ws.id, unassign: true) }) { $0.assignedTo = nil }
    }

    private func run(_ action: @escaping () async throws -> Void, after: @escaping (inout Conversation) -> Void) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await action()
                if var c = conversation {
                    after(&c)
                    update(c)
                }
                onChanged?()
            } catch {
                Log.error("conversation action", error)
                notice = Notice(severity: .error, message: ErrorText.of(error, app.strings))
            }
        }
    }

    // MARK: Details: visitor, tags, notes

    func loadDetails() async {
        guard let ws = app.workspace else { return }
        async let p = app.api.visitorProfile(workspaceId: ws.id, conversationId: id)
        await loadNotes()
        profile = await p
    }

    func loadNotes() async {
        guard let ws = app.workspace else { return }
        do {
            notes = try await app.api.notes(conversationId: id, workspaceId: ws.id)
                .sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
        } catch {
            Log.error("notes", error)
        }
    }

    /// Tags show at once and are saved one change after another: the server replaces the whole
    /// list, so two quick edits built on a list still in flight would drop one of them.
    func setTags(_ tags: [String]) {
        guard var c = conversation, let ws = app.workspace else { return }
        let before = c.tags ?? []
        c.tags = tags
        conversation = c
        let previous = tagsSaving
        tagsSaving = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            do {
                try await self.app.api.setTags(c.id, workspaceId: ws.id, tags: tags)
                self.onChanged?()
            } catch {
                // Put back what was there, unless a later edit has changed it since.
                if var cur = self.conversation, cur.tags == tags {
                    cur.tags = before
                    self.conversation = cur
                }
                self.notice = Notice(severity: .error, message: ErrorText.of(error, self.app.strings))
            }
        }
    }

    @ObservationIgnored private var tagsSaving: Task<Void, Never>?

    func addTag(_ raw: String) {
        let tag = raw.trimmingCharacters(in: .whitespaces)
        guard !tag.isEmpty else { return }
        var tags = conversation?.tags ?? []
        if !tags.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) { tags.append(tag) }
        setTags(tags)
    }

    func addNote(_ body: String) async -> Bool {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let ws = app.workspace else { return false }
        do {
            try await app.api.addNote(conversationId: id, workspaceId: ws.id, body: text)
            await loadNotes()
            return true
        } catch {
            notice = Notice(severity: .error, message: ErrorText.of(error, app.strings))
            return false
        }
    }

    func deleteNote(_ noteId: String) {
        guard let ws = app.workspace else { return }
        Task {
            do {
                try await app.api.deleteNote(conversationId: id, workspaceId: ws.id, noteId: noteId)
                await loadNotes()
            } catch {
                notice = Notice(severity: .error, message: ErrorText.of(error, app.strings))
            }
        }
    }

    // MARK: Saved replies

    func cannedResponses(_ query: String) async throws -> [CannedResponse] {
        guard let ws = app.workspace else { return [] }
        return try await app.api.cannedResponses(workspaceId: ws.id, locale: app.strings.language.code, query: query)
    }

    func useCanned(_ r: CannedResponse) {
        draft = r.body
        guard let ws = app.workspace else { return }
        Task { try? await app.api.trackCannedUse(r.id, workspaceId: ws.id) }
    }
}
