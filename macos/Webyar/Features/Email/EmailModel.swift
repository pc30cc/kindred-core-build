import AppKit
import Foundation
import Observation

/// A file picked for an outgoing email, uploaded (staged) as soon as it is added.
struct OutgoingAttachment: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var mime: String
    var size: Int64
    var staged: StagedEmailAttachment?
    var failed = false

    static func == (a: OutgoingAttachment, b: OutgoingAttachment) -> Bool {
        a.id == b.id && a.staged == b.staged && a.failed == b.failed
    }
}

/// How a reply goes out.
enum ReplyMode: String, CaseIterable, Identifiable {
    case reply, replyAll, forward
    var id: String { rawValue }
}

/// The workspace mailbox (the web console's email inbox, and the Windows
/// app's EmailPage): folders, search and pages of threads on the left; the
/// open thread with reply, reply all and forward on the right; a window to
/// write a new email.
@MainActor
@Observable
final class EmailModel {
    static let maxAttachment: Int64 = 25 * 1024 * 1024

    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var poller: Poller?
    @ObservationIgnored private var generation = 0

    private(set) var threads: [EmailThreadSummary] = []
    private(set) var nextBefore: String?
    private(set) var loading = true
    private(set) var loadingMore = false
    private(set) var error: String?
    private(set) var connection: MailboxConnection?
    private(set) var connectionChecked = false

    var folder: EmailFolder = .all {
        didSet { if folder != oldValue { reload() } }
    }
    var search = ""
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var appliedSearch: String?

    // The open thread
    private(set) var selectedId: String?
    private(set) var detail: EmailThreadDetail?
    private(set) var detailLoading = false
    private(set) var detailError: String?

    // The reply box under the open thread
    var replyMode: ReplyMode = .reply
    var replyText = ""
    var replyAttachments: [OutgoingAttachment] = []
    private(set) var sending = false
    var notice: (severity: Banner.Severity, message: String)?

    // A new email
    var composing = false

    init(app: AppModel) { self.app = app }

    func start() {
        guard poller == nil else { return }
        // A mailbox is not a chat: a minute between looks is plenty, and ⌘R is there.
        poller = Poller("email", interval: { 60 }) { [weak self] in try await self?.load() }
        poller?.start()
        Task { await checkConnection() }
    }

    func stop() {
        poller?.stop()
        poller = nil
        searchTask?.cancel()
    }

    func refresh() { poller?.kick() }

    private func reload() {
        generation += 1
        threads = []
        nextBefore = nil
        loading = true
        error = nil
        poller?.kick()
    }

    /// Searches as the operator types, a moment after they stop.
    func searchChanged() {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled, let self else { return }
            let q = self.search.trimmingCharacters(in: .whitespaces)
            if q != (self.appliedSearch ?? "") { self.reload() }
        }
    }

    private func checkConnection() async {
        guard let ws = app.workspace else { return }
        connection = await app.api.mailboxConnection(workspaceId: ws.id)
        connectionChecked = true
    }

    private func load() async throws {
        guard let ws = app.workspace else { return }
        let gen = generation
        let q = search.trimmingCharacters(in: .whitespaces)
        defer { if gen == generation { loading = false } }
        do {
            let page = try await app.api.emailThreads(workspaceId: ws.id, folder: folder, search: q)
            guard gen == generation else { return }
            appliedSearch = q
            // Keep any older pages already loaded below the fresh first page.
            let fresh = page.threads ?? []
            let freshIds = Set(fresh.map(\.id))
            let older = threads.dropFirst(fresh.count).filter { !freshIds.contains($0.id) }
            threads = sorted(fresh + older)
            if nextBefore == nil || threads.count <= fresh.count { nextBefore = page.nextBefore }
            error = nil
        } catch let e as ApiError where e.failure != .unauthorized {
            // 409: no mailbox connected — shown as its own empty state, not an error.
            if e.status == 409 {
                connection = MailboxConnection(connected: false)
                threads = []
                error = nil
                return
            }
            error = ErrorText.of(e, app.strings)
            throw e
        }
    }

    func loadMore() {
        guard let ws = app.workspace, let before = nextBefore, !loadingMore else { return }
        loadingMore = true
        let gen = generation
        Task {
            defer { loadingMore = false }
            do {
                let page = try await app.api.emailThreads(workspaceId: ws.id, folder: folder, search: appliedSearch, before: before)
                guard gen == generation else { return }
                let known = Set(threads.map(\.id))
                threads = sorted(threads + (page.threads ?? []).filter { !known.contains($0.id) })
                nextBefore = page.nextBefore
            } catch {
                Log.error("email more", error)
            }
        }
    }

    private func sorted(_ list: [EmailThreadSummary]) -> [EmailThreadSummary] {
        list.sorted { ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast) }
    }

    var unreadCount: Int { threads.filter(\.unread).count }

    var notConnected: Bool { connectionChecked && connection?.connected != true && threads.isEmpty && (appliedSearch ?? "").isEmpty }

    // MARK: Reading

    func select(_ id: String?) {
        guard let id, id != selectedId else { return }
        selectedId = id
        detail = nil
        detailError = nil
        replyText = ""
        replyAttachments = []
        replyMode = .reply
        notice = nil
        Task { await openThread(id, markRead: true) }
    }

    private func openThread(_ id: String, markRead: Bool) async {
        guard let ws = app.workspace else { return }
        detailLoading = true
        defer { if selectedId == id { detailLoading = false } }
        do {
            let d = try await app.api.emailThread(workspaceId: ws.id, threadId: id)
            guard selectedId == id else { return }
            detail = d
            if markRead, threads.first(where: { $0.id == id })?.unread == true {
                try? await app.api.setEmailRead(workspaceId: ws.id, threadId: id, isRead: true)
                patch(id) { $0.isRead = true }
            }
        } catch {
            Log.error("email thread", error)
            if selectedId == id { detailError = ErrorText.of(error, app.strings) }
        }
    }

    var selected: EmailThreadSummary? { threads.first { $0.id == selectedId } ?? detail?.thread }

    private func patch(_ id: String, _ change: (inout EmailThreadSummary) -> Void) {
        if let i = threads.firstIndex(where: { $0.id == id }) { change(&threads[i]) }
        if var t = detail?.thread, t.id == id {
            change(&t)
            detail?.thread = t
        }
    }

    func toggleStar(_ id: String) {
        guard let ws = app.workspace else { return }
        let starred = !(threads.first { $0.id == id }?.starred ?? detail?.thread?.starred ?? false)
        patch(id) { $0.isStarred = starred }
        Task {
            do {
                try await app.api.setEmailStarred(workspaceId: ws.id, threadId: id, starred: starred)
                if folder == .starred && !starred { threads.removeAll { $0.id == id } }
            } catch {
                Log.error("email star", error)
                patch(id) { $0.isStarred = !starred }
            }
        }
    }

    func setRead(_ id: String, _ isRead: Bool) {
        guard let ws = app.workspace else { return }
        patch(id) { $0.isRead = isRead }
        if !isRead && selectedId == id {
            // As on Windows: marking the open thread unread closes it.
            selectedId = nil
            detail = nil
        }
        Task {
            do {
                try await app.api.setEmailRead(workspaceId: ws.id, threadId: id, isRead: isRead)
            } catch {
                Log.error("email read", error)
                patch(id) { $0.isRead = !isRead }
            }
        }
    }

    // MARK: Replying

    private var myAddress: String? { (connection?.emailAddress ?? app.user?.email)?.lowercased() }

    /// Who a reply goes to: the other side of the thread (everyone for reply all).
    func replyRecipients(_ mode: ReplyMode) -> (to: [EmailAddress], cc: [EmailAddress]) {
        guard let d = detail else { return ([], []) }
        let me = myAddress
        let messages = (d.messages ?? []).sorted { ($0.sentAt ?? .distantPast) < ($1.sentAt ?? .distantPast) }
        func notMe(_ a: EmailAddress) -> Bool { a.email.lowercased() != me && !a.email.isEmpty }
        func unique(_ list: [EmailAddress]) -> [EmailAddress] {
            var seen = Set<String>()
            return list.filter { seen.insert($0.id).inserted }
        }
        switch mode {
        case .forward:
            return ([], [])
        case .reply:
            if let last = messages.last(where: { !$0.isOutbound }) { return ([last.from].filter(notMe), []) }
            if let last = messages.last { return (unique(last.to.filter(notMe)), []) }
            return (unique((d.thread?.participants ?? []).filter(notMe)), [])
        case .replyAll:
            guard let last = messages.last else { return (unique((d.thread?.participants ?? []).filter(notMe)), []) }
            let to = unique(([last.isOutbound ? nil : last.from].compactMap { $0 } + last.to).filter(notMe))
            let cc = unique(last.cc.filter(notMe)).filter { c in !to.contains(where: { $0.id == c.id }) }
            return (to, cc)
        }
    }

    func subject(for mode: ReplyMode) -> String {
        let base = (detail?.thread?.subject ?? selected?.subject ?? "").trimmingCharacters(in: .whitespaces)
        let prefix = mode == .forward ? "Fwd:" : "Re:"
        if base.lowercased().hasPrefix(prefix.lowercased()) { return base }
        return base.isEmpty ? prefix : "\(prefix) \(base)"
    }

    /// The original, quoted under a forward.
    func forwardedText() -> String {
        guard let last = (detail?.messages ?? []).max(by: { ($0.sentAt ?? .distantPast) < ($1.sentAt ?? .distantPast) }) else { return "" }
        let s = app.strings
        let body = last.textBody ?? EmailHTML.plainText(last.htmlBody ?? "")
        var lines = ["", "", "---------- \(s["emailForwarded"]) ----------",
                     "\(s["emailFrom"]): \(last.fromAddress ?? "")"]
        if let at = last.sentAt { lines.append("\(s["emailDate"]): \(Display.dateTime(at, s))") }
        lines.append("\(s["emailSubject"]): \(detail?.thread?.subject ?? "")")
        let to = last.to.map(\.email).joined(separator: ", ")
        if !to.isEmpty { lines.append("\(s["emailTo"]): \(to)") }
        lines.append("")
        lines.append(body)
        return lines.joined(separator: "\n")
    }

    func sendReply(to: [EmailAddress], cc: [EmailAddress], bcc: [EmailAddress]) {
        guard let ws = app.workspace, let threadId = detail?.thread?.id ?? selectedId else { return }
        let s = app.strings
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        let mode = replyMode
        guard !text.isEmpty, !to.isEmpty, !sending, replyAttachments.allSatisfy({ $0.staged != nil }) else { return }
        sending = true
        let body = mode == .forward ? text + forwardedText() : text
        let staged = replyAttachments.compactMap(\.staged)
        Task {
            defer { sending = false }
            do {
                // A forward starts a new conversation with its new recipient.
                try await app.api.sendEmail(workspaceId: ws.id, threadId: mode == .forward ? nil : threadId,
                                            to: to.map(\.email), cc: cc.map(\.email), bcc: bcc.map(\.email),
                                            subject: subject(for: mode), body: body, attachments: staged)
                replyText = ""
                replyAttachments = []
                notice = (.success, s["emailSent"])
                await openThread(threadId, markRead: false)
                poller?.kick()
            } catch {
                Log.error("email reply", error)
                notice = (.error, "\(s["emailSendFailed"]) — \(ErrorText.of(error, s))")
            }
        }
    }

    /// A new email from the compose window. Returns nil when it went, else the words of the failure.
    func sendNew(to: [EmailAddress], cc: [EmailAddress], bcc: [EmailAddress], subject: String, body: String, attachments: [StagedEmailAttachment]) async -> String? {
        guard let ws = app.workspace else { return app.strings["offlineBody"] }
        do {
            try await app.api.sendEmail(workspaceId: ws.id, threadId: nil, to: to.map(\.email), cc: cc.map(\.email), bcc: bcc.map(\.email),
                                        subject: subject, body: body, attachments: attachments)
            poller?.kick()
            return nil
        } catch {
            Log.error("email send", error)
            return "\(app.strings["emailSendFailed"]) — \(ErrorText.of(error, app.strings))"
        }
    }

    // MARK: Attachments

    /// Reads and stages a file; the list shows it at once and marks it when it is ready (or failed).
    func stage(_ url: URL, into list: @escaping (OutgoingAttachment?, UUID?) -> Void) {
        guard let ws = app.workspace else { return }
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            notice = (.error, app.strings["attachmentFailed"])
            return
        }
        guard Int64(data.count) <= Self.maxAttachment else {
            notice = (.error, app.strings["fileTooLarge"])
            return
        }
        let name = url.lastPathComponent
        let mime = Mime.of(name)
        let item = OutgoingAttachment(name: name, mime: mime, size: Int64(data.count))
        list(item, nil)
        let id = item.id
        Task {
            var done = item
            do {
                done.staged = try await app.api.stageEmailAttachment(workspaceId: ws.id, filename: name, contentType: mime, data: data)
            } catch {
                Log.error("email attachment", error)
                done.failed = true
            }
            list(done, id)
        }
    }

    func stageReply(_ url: URL) {
        stage(url) { [weak self] item, replacing in
            guard let self, let item else { return }
            if let replacing, let i = self.replyAttachments.firstIndex(where: { $0.id == replacing }) {
                self.replyAttachments[i] = item
            } else if replacing == nil {
                self.replyAttachments.append(item)
            }
        }
    }

    /// Opens (or saves) a file from a message.
    func openAttachment(_ a: EmailAttachmentView, save: Bool = false) {
        Task {
            do {
                let data = try await app.api.emailAttachmentData(a)
                let name = (a.filename?.isEmpty == false ? a.filename! : "attachment").components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "_")
                if save {
                    let panel = NSSavePanel()
                    panel.nameFieldStringValue = name
                    if panel.runModal() == .OK, let url = panel.url { try data.write(to: url) }
                    return
                }
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Webyar/mail-\(a.id)", isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let file = dir.appendingPathComponent(name)
                try data.write(to: file)
                NSWorkspace.shared.open(file)
            } catch {
                Log.error("email attachment open", error)
                notice = (.error, ErrorText.of(error, app.strings))
            }
        }
    }
}
