import AppKit
import Foundation
import Observation
import UniformTypeIdentifiers

/// The internal inbox: operator-to-operator chat — the Windows app's
/// ColleaguesPage, as a model. The team with presence and last message; the
/// thread with one colleague — text, photos, voice notes and files, grouped
/// by day and sender — and a composer with files, emoji and voice recording,
/// gated by the plan like the visitor composer.
@MainActor
@Observable
final class ColleaguesModel {
    static let maxUpload = 25 * 1024 * 1024

    struct Notice: Equatable {
        var message: String
        /// The microphone is blocked: offer System Settings beside the message.
        var micSettings = false
    }

    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var listPoller: Poller?
    @ObservationIgnored private var threadPoller: Poller?
    @ObservationIgnored private var events: Signal<InboxEvent>.Token?
    /// Messages still on their way stay at the end until the server has them.
    @ObservationIgnored private var outbox: [ChatRow] = []
    @ObservationIgnored private var me: String?
    @ObservationIgnored private var workspaceId: String?

    // The team
    private(set) var colleagues: [Colleague] = []
    private(set) var loading = true
    private(set) var loaded = false
    var search = ""

    // The thread
    private(set) var peer: Colleague?
    var peerId: String? { peer?.userId }
    private(set) var rows: [ChatRow] = []
    /// Bumped each time this operator sends, so the thread scrolls to the bottom.
    private(set) var sentCount = 0
    private(set) var threadLoading = false
    var notice: Notice?

    // Composer
    var draft = ""
    /// Unsent text per colleague, kept while switching between them.
    @ObservationIgnored private var drafts: [String: String] = [:]
    var pendingFile: (name: String, mime: String, data: Data)?
    let recorder = VoiceRecorder()

    init(app: AppModel) {
        self.app = app
    }

    // MARK: Lifecycle

    /// The page came on screen: the team every 15 s, the open thread every
    /// 5 s, and both at once on any realtime event.
    func start() {
        if workspaceId != app.workspace?.id {
            reset()
            workspaceId = app.workspace?.id
        }
        if listPoller == nil {
            listPoller = Poller("colleagues", interval: { 15 }) { [weak self] in try await self?.loadList() }
            listPoller?.start()
        }
        if events == nil {
            events = app.inboxEvents.subscribe { [weak self] _ in
                self?.listPoller?.kick()
                self?.threadPoller?.kick()
            }
        }
        if let id = peer?.userId, threadPoller == nil { startThread(id) }
    }

    /// The page left the screen: nothing polls, and a recording is dropped.
    func suspend() {
        listPoller?.stop()
        listPoller = nil
        threadPoller?.stop()
        threadPoller = nil
        events?.cancelNow()
        events = nil
        if recorder.isRecording { recorder.cancel() }
    }

    func stop() {
        suspend()
    }

    func refresh() {
        listPoller?.kick()
        threadPoller?.kick()
    }

    private func reset() {
        colleagues = []
        loading = true
        loaded = false
        peer = nil
        rows = []
        outbox = []
        notice = nil
        draft = ""
        pendingFile = nil
        me = nil
    }

    // MARK: The team

    private func loadList() async throws {
        guard let ws = app.workspace else { return }
        defer { loading = false }
        let r = try await app.api.colleagues(workspaceId: ws.id)
        guard ws.id == app.workspace?.id else { return }
        me = r.me ?? app.user?.id
        let list = r.colleagues ?? []
        if list != colleagues { colleagues = list }
        loaded = true
        if let p = peer, let fresh = list.first(where: { $0.userId == p.userId }), fresh != p { peer = fresh }
    }

    /// active, away, disconnected or offline — the team presence the shell already follows.
    func presence(of userId: String) -> String {
        app.presence?.teamStates[userId]?.effective ?? PresenceState.offline
    }

    var onlineCount: Int {
        colleagues.filter { presence(of: $0.userId) == PresenceState.active }.count
    }

    /// Unread first, then who is active, then by name; narrowed by the search box.
    var visible: [Colleague] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let states = app.presence?.teamStates ?? [:]
        let filtered = colleagues.filter { q.isEmpty || $0.displayName.localizedCaseInsensitiveContains(q) }
        return filtered.sorted { a, b in
            let ua = (a.unread ?? 0) > 0
            let ub = (b.unread ?? 0) > 0
            if ua != ub { return ua }
            let aa = (states[a.userId]?.effective ?? PresenceState.offline) == PresenceState.active
            let ab = (states[b.userId]?.effective ?? PresenceState.offline) == PresenceState.active
            if aa != ab { return aa }
            return a.displayName.localizedCompare(b.displayName) == .orderedAscending
        }
    }

    /// The line under a colleague's name: the last message ("You: …" when it
    /// was mine), a sentence for a file, else their role or email.
    static func preview(_ c: Colleague, _ s: Strings) -> String {
        let last = c.lastMessage
        var body = Display.oneLine(last?.body)
        if body.isEmpty, let kind = last?.attachmentKind {
            body = Display.attachmentPreview(kind: kind, isMe: last?.outgoing == true, senderName: c.displayName, s)
        }
        if body.isEmpty { return c.role ?? c.email ?? "" }
        return last?.outgoing == true ? "\(s["you"]): \(body)" : body
    }

    static func roleLabel(_ role: String?, _ s: Strings) -> String {
        switch role {
        case "owner": return s["roleOwner"]
        case "admin": return s["roleAdmin"]
        case "agent", "operator": return s["roleAgent"]
        case nil, "": return ""
        default: return role ?? ""
        }
    }

    // MARK: Selection

    func select(_ id: String?) {
        guard let id, id != peer?.userId, let c = colleagues.first(where: { $0.userId == id }) else { return }
        // Each colleague keeps their own half-written message.
        if let old = peer?.userId {
            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            drafts[old] = text.isEmpty ? nil : draft
        }
        peer = c
        notice = nil
        rows = []
        outbox = []
        pendingFile = nil
        draft = drafts[id] ?? ""
        if recorder.isRecording { recorder.cancel() }
        startThread(id)
    }

    private func startThread(_ id: String) {
        threadPoller?.stop()
        threadLoading = true
        threadPoller = Poller("team-thread", interval: { 5 }) { [weak self] in try await self?.loadThread(id) }
        threadPoller?.start()
    }

    func mail() {
        guard let mail = peer?.email, !mail.isEmpty, let url = URL(string: "mailto:" + mail) else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: The thread

    private func loadThread(_ id: String) async throws {
        guard let ws = app.workspace else { return }
        defer { if id == peer?.userId { threadLoading = false } }
        let t = try await app.api.teamThread(workspaceId: ws.id, peerId: id)
        guard id == peer?.userId else { return }
        let mine = t.me ?? me ?? app.user?.id
        let s = app.strings
        let cal = Calendar.current
        var wanted: [ChatRow] = []
        var day: Date?
        let sorted = (t.messages ?? []).sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
        for m in sorted {
            let at = m.createdAt ?? Date()
            if day.map({ !cal.isDate($0, inSameDayAs: at) }) ?? true {
                day = at
                wanted.append(ChatRow(id: "day:\(Int(cal.startOfDay(for: at).timeIntervalSince1970))", side: .day, body: Display.dayLabel(at, s)))
            }
            wanted.append(Self.row(m, me: mine, s))
        }
        // The avatar and the time only on the last bubble of each run.
        ChatModel.group(&wanted)
        wanted.append(contentsOf: outbox)
        if wanted != rows { rows = wanted }

        if let i = colleagues.firstIndex(where: { $0.userId == id }), (colleagues[i].unread ?? 0) > 0 {
            do {
                try await app.api.markTeamRead(workspaceId: ws.id, peerId: id)
                if let j = colleagues.firstIndex(where: { $0.userId == id }) { colleagues[j].unread = 0 }
                listPoller?.kick()
            } catch {
                Log.error("team read", error)
            }
        }
    }

    private static func row(_ m: TeamMessage, me: String?, _ s: Strings) -> ChatRow {
        let outgoing = me != nil && m.senderId == me
        var r = ChatRow(id: m.id, side: outgoing ? .outgoing : .incoming, body: m.body ?? "")
        r.createdAt = m.createdAt
        r.senderId = m.senderId
        var time = m.createdAt.map { Display.clockTime($0, s.language) } ?? ""
        if outgoing && m.readAt != nil { time += " · " + s["seen"] }
        r.time = time
        if let a = m.attachment { r.attachments = [AttachmentInfo(a, s)] }
        return r
    }

    // MARK: Sending

    var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pendingFile != nil }

    func send() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let file = pendingFile
        guard !body.isEmpty || file != nil, let to = peer?.userId, let ws = app.workspace else { return }
        sentCount += 1
        let s = app.strings
        draft = ""
        pendingFile = nil
        var row = ChatRow(id: "local:" + UUID().uuidString, side: .outgoing, body: body)
        row.createdAt = Date()
        row.time = s["sending"]
        row.pending = true
        row.senderId = me ?? app.user?.id
        if let file { row.attachments = [AttachmentInfo.local(name: file.name, mime: file.mime, data: file.data, s)] }
        outbox.append(row)
        rows.append(row)
        let sent = row
        let workspaceId = ws.id
        Task { await deliver(sent, to: to, workspaceId: workspaceId, body: body, file: file) }
    }

    private func deliver(_ row: ChatRow, to peerId: String, workspaceId: String, body: String, file: (name: String, mime: String, data: Data)?) async {
        do {
            var attachmentId: String?
            if let file {
                let server = try await app.api.uploadAttachment(workspaceId: workspaceId, conversationId: nil, fileName: file.name, mimeType: file.mime, data: file.data)
                attachmentId = server
                if let local = row.attachments.first?.id { AttachmentStore.shared.alias(local, server) }
            }
            try await app.api.sendTeamMessage(workspaceId: workspaceId, recipientId: peerId, body: body, attachmentId: attachmentId)
            outbox.removeAll { $0.id == row.id }
            threadPoller?.kick()
            listPoller?.kick()
        } catch {
            Log.error("team send", error)
            outbox.removeAll { $0.id == row.id }
            rows.removeAll { $0.id == row.id }
            // The text and the file go back into the box to try again — only that colleague's box,
            // and never over something already being typed.
            let s = app.strings
            if peer?.userId == peerId {
                if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft = body } else if !body.isEmpty { draft = body + "\n" + draft }
                if let file, pendingFile == nil { pendingFile = file }
                notice = Notice(message: "\(s["sendFailed"]) — \(ErrorText.of(error, s))")
            } else {
                drafts[peerId] = [body, drafts[peerId]].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
                notice = Notice(message: "\(s["sendFailed"]) — \(ErrorText.of(error, s))")
            }
        }
    }

    // MARK: Files

    /// Puts a picked or dropped file in the composer to go out with the next Send.
    func attach(url: URL) {
        let s = app.strings
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
            if (values.fileSize ?? 0) > Self.maxUpload {
                notice = Notice(message: s["fileTooLarge"])
                return
            }
            let data = try Data(contentsOf: url)
            let name = url.lastPathComponent
            let mime = values.contentType?.preferredMIMEType ?? Mime.of(name)
            attach(name: name, mime: mime, data: data)
        } catch {
            Log.error("team pick file", error)
            notice = Notice(message: s["attachmentFailed"])
        }
    }

    func attach(name: String, mime: String, data: Data) {
        guard data.count <= Self.maxUpload else {
            notice = Notice(message: app.strings["fileTooLarge"])
            return
        }
        pendingFile = (name, mime, data)
    }

    func clearPendingFile() {
        pendingFile = nil
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
                Log.error("team voice record", error)
                let denied = (error as? VoiceRecorder.Failure) == .denied
                notice = Notice(message: app.strings[denied ? "micBlocked" : "micFailed"], micSettings: true)
            }
        }
    }

    func stopRecording(keep: Bool) {
        guard recorder.isRecording else { return }
        if !keep {
            recorder.cancel()
            return
        }
        guard let (data, length) = recorder.stop() else {
            notice = Notice(message: app.strings["micFailed"])
            return
        }
        // A tap on the mic by mistake is not a message.
        guard length >= 1, data.count >= 1024 else { return }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        attach(name: "voice-note-\(f.string(from: Date())).m4a", mime: "audio/mp4", data: data)
    }

    func openMicrophoneSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
            NSWorkspace.shared.open(url)
        }
    }
}
