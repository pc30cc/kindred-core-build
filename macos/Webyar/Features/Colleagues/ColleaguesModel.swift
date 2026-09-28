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
    struct Notice: Equatable {
        var message: String
        /// The microphone is blocked: offer System Settings beside the message.
        var micSettings = false
    }

    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var listPoller: Poller?
    @ObservationIgnored private var threadPoller: Poller?
    @ObservationIgnored private var events: Signal<InboxEvent>.Token?
    @ObservationIgnored private var teamEvents: Signal<TeamEvent>.Token?
    @ObservationIgnored private var requests: Signal<String>.Token?
    /// Messages still on their way stay at the end until the server has them.
    @ObservationIgnored private var outbox: [ChatRow] = []
    /// Sent messages stay on show until a read brings them: per row, the number of sends when it went
    /// and the newest message the thread had before it.
    @ObservationIgnored private var sentOn: [String: (count: Int, after: Date?)] = [:]
    @ObservationIgnored private var sends = 0
    /// The newest message the server has sent for the open thread.
    @ObservationIgnored private var newestServerAt: Date?
    /// Each colleague's last delivery: the next waits for it, so messages arrive in the order they were sent.
    @ObservationIgnored private var sending: [String: Task<Void, Never>] = [:]
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
    /// The file waiting in each other colleague's box, kept like their text.
    @ObservationIgnored private var files: [String: (name: String, mime: String, data: Data)] = [:]
    let recorder = VoiceRecorder()

    init(app: AppModel) {
        self.app = app
        // At the length cap the note goes into the card, whatever the view is doing.
        recorder.onLimit = { [weak self] in self?.stopRecording(keep: true) }
    }

    // MARK: Lifecycle

    /// The page came on screen. Team chat is pushed on the operator's own
    /// realtime channel: a message or a read refreshes the team, and the open
    /// thread when it is about that colleague. The polling covers for it —
    /// every 15 s for the team and 5 s for the thread without that channel,
    /// far less often with it.
    func start() {
        if workspaceId != app.workspace?.id {
            reset()
            workspaceId = app.workspace?.id
        }
        if listPoller == nil {
            listPoller = Poller("colleagues", interval: { [weak self] in self?.app.teamRealtime == true ? 60 : 15 }) { [weak self] in
                try await self?.loadList()
            }
            listPoller?.start()
        }
        if teamEvents == nil {
            teamEvents = app.teamEvents.subscribe { [weak self] e in
                guard let self else { return }
                self.listPoller?.kick()
                if let peer = self.peer?.userId, e.peer(me: self.me ?? self.app.user?.id) == peer { self.threadPoller?.kick() }
            }
        }
        if requests == nil {
            requests = app.colleagueRequests.subscribe { [weak self] _ in self?.openPending() }
        }
        if events == nil {
            // Back after a realtime gap: read everything again.
            events = app.inboxEvents.subscribe { [weak self] e in
                guard e.isReconcile else { return }
                self?.listPoller?.kick()
                self?.threadPoller?.kick()
            }
        }
        if let id = peer?.userId, threadPoller == nil { startThread(id) }
        app.visibleColleagueId = peer?.userId
        openPending()
    }

    /// A notification asked for this colleague: open them once the team is known.
    private func openPending() {
        guard let want = app.pendingColleague, colleagues.contains(where: { $0.userId == want }) else { return }
        app.pendingColleague = nil
        select(want)
    }

    /// The page left the screen: nothing polls, and a recording is dropped.
    func suspend() {
        listPoller?.stop()
        listPoller = nil
        threadPoller?.stop()
        threadPoller = nil
        events?.cancelNow()
        events = nil
        teamEvents?.cancelNow()
        teamEvents = nil
        requests?.cancelNow()
        requests = nil
        if app.visibleColleagueId == peer?.userId { app.visibleColleagueId = nil }
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
        sentOn = [:]
        newestServerAt = nil
        notice = nil
        draft = ""
        pendingFile = nil
        files = [:]
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
        openPending()
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
            files[old] = pendingFile
        }
        peer = c
        app.visibleColleagueId = id
        notice = nil
        rows = []
        outbox = []
        sentOn = [:]
        newestServerAt = nil
        pendingFile = files.removeValue(forKey: id)
        draft = drafts[id] ?? ""
        if recorder.isRecording { recorder.cancel() }
        startThread(id)
    }

    private func startThread(_ id: String) {
        threadPoller?.stop()
        threadLoading = true
        threadPoller = Poller("team-thread", interval: { [weak self] in self?.app.teamRealtime == true ? 30 : 5 }) { [weak self] in
            try await self?.loadThread(id)
        }
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
        let mark = sends
        let t = try await app.api.teamThread(workspaceId: ws.id, peerId: id)
        guard id == peer?.userId else { return }
        let mine = t.me ?? me ?? app.user?.id
        let s = app.strings
        let cal = Calendar.current
        var wanted: [ChatRow] = []
        var day: Date?
        let sorted = (t.messages ?? []).sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
        settleOutbox(sorted, me: mine, readBegan: mark)
        newestServerAt = sorted.last?.createdAt ?? newestServerAt
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

        // Read only while the thread is really in front of the operator: the page stays loaded behind
        // other pages and other apps, and "Seen" there would be untrue (and silence the notification).
        guard app.isForeground, app.route == .colleagues, app.visibleColleagueId == id else { return }
        if let i = colleagues.firstIndex(where: { $0.userId == id }), (colleagues[i].unread ?? 0) > 0 {
            do {
                try await app.api.markTeamRead(workspaceId: ws.id, peerId: id)
                if let j = colleagues.firstIndex(where: { $0.userId == id }) { colleagues[j].unread = 0 }
                listPoller?.kick()
                // The Colleagues badge and the Dock follow at once.
                app.kickTeam()
            } catch {
                Log.error("team read", error)
            }
        }
    }

    /// Lets go of sent messages the server has: sent before this read began, or found in it — mine,
    /// the same text and file, and newer than anything the thread had when it went.
    private func settleOutbox(_ messages: [TeamMessage], me: String?, readBegan mark: Int) {
        guard !sentOn.isEmpty else { return }
        var unclaimed = messages.filter { me != nil && $0.senderId == me }
        var gone: Set<String> = []
        for r in outbox {
            guard let sent = sentOn[r.id] else { continue }
            if sent.count <= mark {
                gone.insert(r.id)
            } else if let after = sent.after, let i = unclaimed.firstIndex(where: { m in
                (m.createdAt ?? .distantPast) > after && (m.body ?? "") == r.body && (m.attachment != nil) == !r.attachments.isEmpty
            }) {
                unclaimed.remove(at: i)
                gone.insert(r.id)
            }
        }
        guard !gone.isEmpty else { return }
        outbox.removeAll { gone.contains($0.id) }
        for id in gone { sentOn[id] = nil }
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
        let after = newestServerAt
        let workspaceId = ws.id
        // One at a time per colleague: a line typed after a big file does not arrive first.
        let previous = sending[to]
        sending[to] = Task { [self] in
            await previous?.value
            await deliver(sent, to: to, workspaceId: workspaceId, body: body, file: file, after: after)
        }
    }

    private func deliver(_ row: ChatRow, to peerId: String, workspaceId: String, body: String, file: (name: String, mime: String, data: Data)?,
                         after: Date?) async {
        do {
            var attachmentId: String?
            if let file {
                let server = try await app.api.uploadAttachment(workspaceId: workspaceId, conversationId: nil, fileName: file.name, mimeType: file.mime, data: file.data)
                attachmentId = server
                if let local = row.attachments.first?.id { AttachmentStore.shared.alias(local, server) }
            }
            try await app.api.sendTeamMessage(workspaceId: workspaceId, recipientId: peerId, body: body, attachmentId: attachmentId)
            // Kept on show, no longer pending, until a read brings the server's copy: it never blinks out.
            if let i = outbox.firstIndex(where: { $0.id == row.id }) {
                outbox[i].pending = false
                outbox[i].time = Display.clockTime(row.createdAt ?? Date(), app.strings.language)
                sends += 1
                sentOn[row.id] = (count: sends, after: after)
                if let j = rows.firstIndex(where: { $0.id == row.id }) { rows[j] = outbox[i] }
            }
            threadPoller?.kick()
            listPoller?.kick()
        } catch {
            Log.error("team send", error)
            outbox.removeAll { $0.id == row.id }
            rows.removeAll { $0.id == row.id }
            // The bubble is gone; its bytes are in `file`, back in the box below.
            for a in row.attachments { AttachmentStore.shared.forget(a.id) }
            // The text and the file go back into the box to try again — only that colleague's box,
            // and never over something already being typed.
            let s = app.strings
            var message = "\(s["sendFailed"]) — \(ErrorText.of(error, s))"
            if peer?.userId == peerId {
                if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft = body } else if !body.isEmpty { draft = body + "\n" + draft }
                if let file {
                    if pendingFile == nil { pendingFile = file } else { message += " " + s.get("sendFailedFileNotKept", "name", file.name) }
                }
            } else {
                drafts[peerId] = [body, drafts[peerId]].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
                if let file {
                    if files[peerId] == nil { files[peerId] = file } else { message += " " + s.get("sendFailedFileNotKept", "name", file.name) }
                }
            }
            notice = Notice(message: message)
        }
    }

    // MARK: Files

    /// Puts a picked, dropped or pasted file in the composer to go out with the next Send —
    /// or says at once why it can't go (a kind the server refuses, or over 25 MB).
    func attach(url: URL) {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey, .isDirectoryKey])
            guard values.isDirectory != true else { return refuse(.notAllowed) }
            if (values.fileSize ?? 0) > SendableFile.maxBytes { return refuse(.tooLarge) }
            let data = try Data(contentsOf: url)
            take(SendableFile.prepare(name: url.lastPathComponent, type: values.contentType, data: data))
        } catch {
            Log.error("team pick file", error)
            notice = Notice(message: app.strings["attachmentFailed"])
        }
    }

    func attach(name: String, mime: String, data: Data) {
        take(SendableFile.check(name: name, mime: mime, data: data))
    }

    private func take(_ outcome: SendableFile.Outcome) {
        if case .ready(let name, let mime, let data) = outcome { pendingFile = (name, mime, data) } else { refuse(outcome) }
    }

    private func refuse(_ outcome: SendableFile.Outcome) {
        notice = Notice(message: app.strings[outcome == .tooLarge ? "fileTooLarge" : "fileTypeNotAllowed"])
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
