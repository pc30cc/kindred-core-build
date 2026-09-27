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

/// One thread's replies still on their way, or failed and waiting for Retry. The inbox keeps one per
/// conversation, so a reply that fails after the operator has moved to another thread is there again,
/// with Retry, when they come back — not dropped with the thread's model.
@MainActor
final class ChatOutbox {
    typealias File = (name: String, mime: String, data: Data)

    private(set) var rows: [ChatRow] = []
    /// The status change and the file each message asked for, kept for a retry.
    private var thenActions: [String: PostSendAction] = [:]
    private var files: [String: File] = [:]
    /// A sent message stays on show until a read brings it: the number of sends when it went.
    private var sentOn: [String: Int] = [:]
    private var sends = 0
    /// The last delivery queued: each waits for the one before, so messages reach the server in the order they were sent.
    var queue: Task<Void, Never>?
    /// The thread's model on screen, redrawn as deliveries finish (nil while the thread is closed).
    weak var shown: ChatModel?

    var isEmpty: Bool { rows.isEmpty }
    var failedIds: [String] { rows.filter(\.failed).compactMap(\.clientId) }

    func add(_ row: ChatRow, then: PostSendAction, file: File?) {
        guard let cid = row.clientId else { return }
        rows.append(row)
        thenActions[cid] = then
        files[cid] = file
    }

    func row(_ clientId: String) -> ChatRow? { rows.first { $0.clientId == clientId } }
    func then(_ clientId: String) -> PostSendAction { thenActions[clientId] ?? .none }
    func file(_ clientId: String) -> File? { files[clientId] }

    func update(_ clientId: String, _ change: (inout ChatRow) -> Void) {
        if let i = rows.firstIndex(where: { $0.clientId == clientId }) { change(&rows[i]) }
    }

    /// The server took it: no longer pending, and kept until a read shows it, so it never blinks out.
    func sent(_ clientId: String) {
        guard let i = rows.firstIndex(where: { $0.clientId == clientId }) else { return }
        rows[i].pending = false
        rows[i].failed = false
        sends += 1
        sentOn[clientId] = sends
        thenActions[clientId] = nil
        files[clientId] = nil
    }

    /// Taken as a read starts: a read that started after a send finished has that message.
    var readMark: Int { sends }

    /// Lets go of what the server has: a message whose client id came back (by a read or by realtime —
    /// also a failed one the server kept despite the error), or a sent one a later read has brought.
    @discardableResult
    func settle(delivered: Set<String> = [], readBegan mark: Int? = nil) -> Bool {
        let gone = Set(rows.compactMap(\.clientId).filter { cid in
            if delivered.contains(cid) { return true }
            guard let mark, let at = sentOn[cid] else { return false }
            return at <= mark
        })
        guard !gone.isEmpty else { return false }
        rows.removeAll { $0.clientId.map(gone.contains) == true }
        for cid in gone {
            thenActions[cid] = nil
            files[cid] = nil
            sentOn[cid] = nil
        }
        return true
    }

    /// Failed messages the operator gives up on (one, or all): gone, and their files' bytes let go.
    func discardFailed(_ only: String? = nil) {
        let gone = rows.filter { $0.failed && (only == nil || $0.clientId == only) }
        guard !gone.isEmpty else { return }
        for r in gone {
            for a in r.attachments { AttachmentStore.shared.forget(a.id) }
            if let cid = r.clientId {
                thenActions[cid] = nil
                files[cid] = nil
            }
        }
        rows.removeAll { r in r.failed && (only == nil || r.clientId == only) }
    }
}

/// One thread: the conversation's header state and actions, the messages
/// with their files, the reply box and the details beside it — the Windows
/// app's ChatView and DetailsPanel, as a model.
@MainActor
@Observable
final class ChatModel {
    /// "specialist" or "assistant", kept for the session as on iOS and Windows.
    static var voice = "specialist"

    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var poller: Poller?
    @ObservationIgnored private var events: Signal<InboxEvent>.Token?
    @ObservationIgnored private var lastSeenMessage: String?
    /// Kept by the inbox per conversation, so it outlives this model (see ChatOutbox).
    @ObservationIgnored private let box: ChatOutbox
    @ObservationIgnored var onChanged: (() -> Void)?
    @ObservationIgnored private var loggedPhotos = false
    /// The server's messages: the saved copy, realtime rows and reads merged (see ThreadSync).
    @ObservationIgnored private var sync = ThreadSync()
    /// The workspace this thread belongs to: its saved copy is only ever read from and written to that workspace's store.
    @ObservationIgnored private let workspaceId: String?
    @ObservationIgnored private var closed = false
    /// Saves run one after another, so an older copy never lands after a newer one.
    @ObservationIgnored private var saving: Task<Void, Never>?
    @ObservationIgnored private var deltaSoon: Task<Void, Never>?

    let id: String
    private(set) var conversation: Conversation?
    private(set) var rows: [ChatRow] = []
    /// Bumped each time this operator sends, so the thread scrolls to the bottom.
    private(set) var sentCount = 0
    private(set) var loading = true
    private(set) var busy = false
    /// The last read failed for want of a connection: what is on show is the copy saved earlier.
    private(set) var offline = false

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

    init(app: AppModel, id: String, conversation: Conversation?, outbox: ChatOutbox) {
        self.app = app
        self.id = id
        self.conversation = conversation
        box = outbox
        workspaceId = app.workspace?.id
        sendAction = UserDefaults.standard.string(forKey: sendActionKey).flatMap(PostSendAction.init(rawValue:)) ?? .none
        // At the length cap the note goes into the card, whatever the view is doing.
        recorder.onLimit = { [weak self] in self?.stopRecording(keep: true) }
    }

    var aiMode: Bool { conversation?.isAiManaged == true }

    #if DEBUG
    /// The thread on screen, for the debug command file.
    nonisolated(unsafe) static weak var debugCurrent: ChatModel?
    func debugRefresh() { poller?.kick() }
    #endif

    private var store: LocalStore? { workspaceId.flatMap { app.store(for: $0) } }

    func start() {
        #if DEBUG
        Self.debugCurrent = self
        #endif
        box.shown = self
        // Replies still out, or failed, from an earlier visit to this thread show at once.
        if !box.isEmpty { render() }
        events = app.inboxEvents.subscribe { [weak self] e in self?.handle(e) }
        // The copy saved on this Mac first (a few milliseconds), then the server: a delta from
        // the saved cursor when there is one.
        let store = self.store, id = self.id
        Task { [weak self] in
            if let store, let saved = await store.thread(id) {
                guard let self, !self.closed else { return }
                if self.sync.applyCached(saved) {
                    self.render()
                    self.loading = false
                }
            }
            guard let self, !self.closed else { return }
            self.poller = Poller("thread", interval: { [weak self] in
                guard let self else { return 5 }
                return self.app.pollInterval(Double(min(5, self.app.config.pollIntervalSeconds)))
            }) { [weak self] in try await self?.load() }
            self.poller?.start()
        }
        Task { await loadDetails() }
    }

    func close() {
        closed = true
        poller?.stop()
        deltaSoon?.cancel()
        events?.cancelNow()
        if recorder.isRecording { recorder.cancel() }
        if box.shown === self { box.shown = nil }
    }

    /// A realtime event: a message row for this thread is shown at once, and a delta follows
    /// shortly to bring its sender, files and any other change (one read for a burst).
    private func handle(_ e: InboxEvent) {
        if e.isReconcile {
            sync.requireWholeRead()
            poller?.kick()
            return
        }
        guard e.conversationId == nil || e.conversationId == id else { return }
        if let m = e.message, m.conversationId == id, sync.applyRealtime(m) { render() }
        deltaSoon?.cancel()
        deltaSoon = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(CachePolicy.realtimeDeltaDelay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.poller?.kick()
        }
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
        let request = sync.beginFetch()
        let mark = box.readMark
        let page: ThreadPage
        do {
            page = try await app.api.messagePage(conversationId: id, since: request.since)
        } catch {
            sync.fetchFailed(transport: error.isTransport)
            if error.isTransport { offline = true }
            throw error
        }
        guard !closed else { return }
        offline = false
        if !loggedPhotos {
            // Which operator replies came with a photo link, and from where: "no photo in the chat" is
            // then a question of what the server sent, answered from the log.
            loggedPhotos = true
            let agents = page.messages.filter { $0.senderType == SenderType.agent }
            let hosts = Set(agents.compactMap { $0.senderAvatar.flatMap { URL(string: $0)?.host ?? "relative" } })
            Log.write("[chat-photos] \(id.prefix(8)) operatorReplies=\(agents.count) withPhoto=\(agents.filter { !($0.senderAvatar ?? "").isEmpty }.count) hosts=\(hosts.sorted().joined(separator: ","))")
        }
        let changed = sync.applyResponse(page)
        #if DEBUG
        Log.write("[sync] thread \(id.prefix(8)) \(page.delta ? "delta" : "full") rows=\(page.messages.count) total=\(sync.messages.count)")
        #endif
        if changed || !page.delta { save() }
        // Sent before this read began: the server's copy is in it, so ours can go.
        box.settle(readBegan: mark)
        render()

        // Seen once per new message, and only while someone is actually looking.
        // Only while the thread is really on screen: the inbox keeps it open behind other pages.
        if let newest = sync.messages.last(where: { $0.senderType == SenderType.contact })?.id, newest != lastSeenMessage,
           app.isForeground, app.visibleConversationId == id {
            lastSeenMessage = newest
            Task { try? await app.api.markSeen(conversationId: id) }
        }
    }

    /// The rows on show: the server's messages with day separators, then what is still being sent.
    private func render() {
        let s = app.strings
        var wanted: [ChatRow] = []
        var day: Date?
        let cal = Calendar.current
        for m in sync.messages {
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
        // A message the server already has (its client id came back — by a read or by realtime) is no
        // longer ours to show: otherwise a read between the insert and the reply, or a 500 after the
        // insert, shows it twice.
        let delivered = Set(sync.messages.compactMap { $0.metadata?["client_message_id"]?.string })
        if !delivered.isEmpty { box.settle(delivered: delivered) }
        wanted.append(contentsOf: box.rows)
        Self.group(&wanted)
        if wanted != rows { rows = wanted }
    }

    /// The server's messages (never the outbox) to this workspace's store, in order.
    private func save() {
        guard sync.hasServerData, let store else { return }
        let messages = sync.messages, cursor = sync.cursor, fullAt = sync.fullAt, id = self.id
        let previous = saving
        saving = Task {
            await previous?.value
            await store.saveThread(id, messages: messages, cursor: cursor, fullAt: fullAt)
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
        box.add(row, then: override ?? sendAction, file: file)
        rows.append(row)
        Self.group(&rows)
        enqueue(clientId, workspaceId: ws.id)
    }

    /// One delivery at a time, in the order they were sent: a line typed after a big file does not
    /// reach the visitor first. The row itself is on show at once.
    private func enqueue(_ clientId: String, workspaceId: String) {
        let previous = box.queue
        box.queue = Task { [self] in
            await previous?.value
            await deliver(clientId, workspaceId: workspaceId)
        }
    }

    /// The outbox is shared with any later model for this thread: whichever is on screen is redrawn,
    /// and hears how it went.
    private func deliver(_ clientId: String, workspaceId: String) async {
        // Discarded while it waited its turn.
        guard let row = box.row(clientId) else { return }
        let file = box.file(clientId)
        do {
            var attachmentId: String?
            if let file {
                let server = try await app.api.uploadAttachment(workspaceId: workspaceId, conversationId: id, fileName: file.name, mimeType: file.mime, data: file.data)
                attachmentId = server
                if let local = row.attachments.first?.id {
                    AttachmentStore.shared.alias(local, server)
                }
            }
            let then = box.then(clientId)
            let result = try await app.api.sendMessage(conversationId: id, workspaceId: workspaceId, body: row.body, clientMessageId: clientId,
                                                       attachmentId: attachmentId, then: then)
            box.sent(clientId)
            let shown = box.shown
            shown?.render()
            if then != .none { (shown ?? self).afterSend(then, result) }
            shown?.poller?.kick()
            onChanged?()
        } catch {
            Log.error("send", error)
            let failed = app.strings["sendFailed"]
            box.update(clientId) { r in
                r.pending = false
                r.failed = true
                r.time = "\(failed) · \(r.time)"
            }
            let shown = box.shown
            shown?.render()
            (shown ?? self).notice = Notice(severity: .error, message: ErrorText.of(error, app.strings), retry: true)
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

    /// Sends the failed messages again (one, or all), in their order, each after the one before.
    func retryFailed(_ only: String? = nil) {
        notice = nil
        guard let ws = app.workspace else { return }
        let now = Display.clockTime(Date(), app.strings.language)
        for cid in box.failedIds where only == nil || cid == only {
            // Pending at once, so a second Retry does not send it twice.
            box.update(cid) { r in
                r.failed = false
                r.pending = true
                r.time = now
            }
            enqueue(cid, workspaceId: ws.id)
        }
        render()
    }

    /// Failed messages the operator gives up on (one, or all), with their files.
    func discardFailed(_ only: String? = nil) {
        notice = nil
        box.discardFailed(only)
        render()
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

    /// Puts a picked, dropped or pasted file in the composer to go out with the next Send —
    /// or says at once why it can't go (a kind the server refuses, or over 25 MB).
    func attach(url: URL) {
        guard !aiMode else { return }
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey, .isDirectoryKey])
            guard values.isDirectory != true else { return refuse(.notAllowed) }
            if (values.fileSize ?? 0) > SendableFile.maxBytes { return refuse(.tooLarge) }
            let data = try Data(contentsOf: url)
            take(SendableFile.prepare(name: url.lastPathComponent, type: values.contentType, data: data))
        } catch {
            Log.error("pick file", error)
            notice = Notice(severity: .error, message: app.strings["attachmentFailed"])
        }
    }

    func attach(name: String, mime: String, data: Data) {
        guard !aiMode else { return }
        take(SendableFile.check(name: name, mime: mime, data: data))
    }

    private func take(_ outcome: SendableFile.Outcome) {
        if case .ready(let name, let mime, let data) = outcome { pendingFile = (name, mime, data) } else { refuse(outcome) }
    }

    private func refuse(_ outcome: SendableFile.Outcome) {
        notice = Notice(severity: .error, message: app.strings[outcome == .tooLarge ? "fileTooLarge" : "fileTypeNotAllowed"])
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
