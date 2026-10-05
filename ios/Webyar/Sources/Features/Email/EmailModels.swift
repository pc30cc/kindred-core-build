import Foundation
import Observation

// The mailbox's state, the same rules as the Android app's
// `EmailInboxViewModel`, `EmailThreadViewModel` and `EmailComposeViewModel`.

/// What an email screen failed with, in the operator's language.
private func emailErrorText(_ error: Error, language: Language) -> String {
    (error as? APIError)?.text(language) ?? Str.offlineBody(language)
}

/// Whether a failure is "no mailbox connected" rather than a fault. The
/// server says so two ways depending on where in the stack the request
/// stopped — a 409 status, or a 400 whose body names the reason.
private func isNotConnected(_ error: Error) -> Bool {
    guard case .server(let status, let message)? = error as? APIError else { return false }
    return status == 409 || (message ?? "").contains("email_not_connected")
}

private func isUnauthorized(_ error: Error) -> Bool {
    if case .unauthorized? = error as? APIError { return true }
    return false
}

enum EmailListState: Equatable, Sendable {
    case loading
    case loaded([EmailThreadSummary])
    case failed(String)

    var threads: [EmailThreadSummary]? {
        if case .loaded(let threads) = self { return threads }
        return nil
    }
}

/// The mailbox.
///
/// A different screen from the chat inbox rather than another queue inside
/// it, deliberately: these are email threads with subjects, recipients and
/// quoted trails, not conversations with a visitor.
///
/// It also keeps the workspace's mailboxes and their unread counts — a Gmail
/// and a Yahoo can both be connected — for the inbox's strip and menu as much
/// as for this screen, and follows them live: a change signal (the inbox
/// channel's `email_mailbox_changed`, or an email push) re-reads the counts
/// and asks the server what changed since the list's cursor. Signals and
/// answers carry ids only; the mail itself is read when it is shown.
@MainActor
@Observable
final class EmailInboxModel {
    static let signalDebounce: TimeInterval = 1.5
    static let recountDelay: TimeInterval = 2
    static let bodyCacheSize = 40

    private(set) var state: EmailListState = .loading
    /// Whose mailbox this is — the address of the one on screen.
    private(set) var address: String?
    /// Every connected mailbox of the workspace, with its unread count.
    private(set) var mailboxes: [EmailMailbox] = []
    /// The mailbox on screen (`gmail`, `yahoo`); nil is the server's default.
    private(set) var provider: String?
    /// Unread threads across the workspace's mailboxes: the inbox's email count.
    private(set) var unread = 0
    /// The workspace has the module but no mailbox connected yet: a thing to
    /// explain rather than an error to retry.
    private(set) var notConnected = false
    var query = "" {
        didSet { if query != oldValue { republish() } }
    }
    private(set) var refreshing = false
    /// Everything, what is unread, or what is starred — inside `folder`.
    private(set) var filter: EmailListFilter = .all
    /// The folder on screen (`inbox`, `sent`, `spam`, `label:…`).
    private(set) var folder = EmailMailFolder.inbox
    /// The folder menu of the mailbox on screen, with its counts.
    private(set) var folders: [EmailMailFolder] = []
    /// The list is being read again in the background.
    private(set) var syncing = false
    private(set) var loadingMore = false
    /// Threads whose messages changed, for an open thread to read itself
    /// again: a new value each time, nil inside meaning "any of them".
    private(set) var threadChange = ThreadChange(id: 0, threads: [])

    struct ThreadChange: Equatable, Sendable {
        let id: Int
        let threads: Set<String>?
    }

    /// How many mails went from this phone: a new number each time, for the
    /// screen under the composer to say «Sent».
    private(set) var sentCount = 0

    var language: Language = .en
    @ObservationIgnored var onUnauthorized: (@MainActor () async -> Void)?

    var hasMore: Bool { nextBefore != nil }

    /// The folder on screen, from the menu.
    var shownFolder: EmailMailFolder? { folders.first { $0.id == folder } }
    /// The mailboxes' labels by id (`Label_12` → «Clients»), for the pills on a row.
    var labelNames: [String: String] {
        var names: [String: String] = [:]
        for folder in folders where folder.isLabel {
            if let name = folder.name { names[String(folder.id.dropFirst("label:".count))] = name }
        }
        return names
    }

    @ObservationIgnored private let api: any EmailAPI
    @ObservationIgnored private var workspaceID: String?
    @ObservationIgnored private var tracked: String?
    @ObservationIgnored private var loaded: [EmailThreadSummary] = []
    @ObservationIgnored private var nextBefore: String?
    @ObservationIgnored private var cursor: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var mailboxGeneration = 0
    @ObservationIgnored private var folderGeneration = 0
    @ObservationIgnored private var signalTask: Task<Void, Never>?
    @ObservationIgnored private var recountTask: Task<Void, Never>?
    @ObservationIgnored private var pendingProviders = Set<String?>()
    @ObservationIgnored private var staleThreads = Set<String>()
    @ObservationIgnored private var allStale = false
    /// Threads already read on this phone, kept while their content is
    /// unchanged so reopening one asks the server nothing. Memory only.
    @ObservationIgnored private var bodies: [String: (version: String, response: EmailThreadResponse)] = [:]
    @ObservationIgnored private var bodyOrder: [String] = []

    init(api: any EmailAPI = Backend.current) {
        self.api = api
    }

    // MARK: Mailboxes

    /// Counts the workspace's mailboxes without loading a list — for the
    /// inbox's strip, which shows the email count before the mailbox is ever
    /// opened. Cheap to call again; only a new workspace starts over.
    func track(_ workspaceID: String?) async {
        guard let workspaceID, tracked != workspaceID else { return }
        tracked = workspaceID
        mailboxes = []
        unread = 0
        await refreshMailboxes()
    }

    /// Loads the list of `workspaceID`'s mailbox — `provider`'s, or the one
    /// on screen, or the first — and keeps it.
    func bind(_ workspaceID: String, provider: String? = nil) async {
        let sameWorkspace = self.workspaceID == workspaceID
        if sameWorkspace, provider == nil || provider == self.provider { return }
        if !sameWorkspace {
            self.workspaceID = workspaceID
            query = ""
            // The last workspace's setup state and cached mail are not this one's.
            notConnected = false
            bodies = [:]
            bodyOrder = []
        }
        self.provider = provider ?? (sameWorkspace ? self.provider : mailboxes.first?.provider)
        publishAddress()
        // Another mailbox opens on its inbox, with its own menu.
        folder = EmailMailFolder.inbox
        filter = .all
        folders = []
        loaded = []
        nextBefore = nil
        cursor = nil
        async let list: Void = load()
        async let menu: Void = refreshFolders()
        async let counts: Void = track(workspaceID)
        _ = await (list, menu, counts)
    }

    /// Shows another of the workspace's mailboxes.
    func selectMailbox(_ provider: String) async {
        guard let workspace = workspaceID ?? tracked else { return }
        await bind(workspace, provider: provider)
    }

    func selectFilter(_ filter: EmailListFilter) async {
        guard self.filter != filter else { return }
        self.filter = filter
        await load()
    }

    /// Shows another folder of the mailbox — from the menu — with everything in it.
    func selectFolder(_ id: String) async {
        guard folder != id else { return }
        folder = id
        filter = .all
        loaded = []
        nextBefore = nil
        await load()
    }

    /// The menu of the mailbox on screen, read again: when it opens, on a
    /// refresh, and after a change signal. A folder no longer there (a label
    /// deleted in Gmail) sends the list back to the inbox.
    func refreshFolders() async {
        guard let workspace = workspaceID else { return }
        let shown = provider
        folderGeneration += 1
        let mine = folderGeneration
        let list = try? await api.emailFolders(workspaceID: workspace, mailbox: shown)
        guard mine == folderGeneration, workspace == workspaceID, shown == provider else { return }
        guard let list else {
            // Not read just now: the menu still has the inbox, rather than a
            // loader that never ends.
            if folders.isEmpty { folders = EmailMailFolder.fallback }
            return
        }
        folders = list
        if !list.contains(where: { $0.id == folder }) { await selectFolder(EmailMailFolder.inbox) }
    }

    /// The mailboxes and their counts, read again: on the way in, when the
    /// app comes back to the front, and after a change signal.
    func refreshMailboxes() async {
        guard let workspace = tracked else { return }
        mailboxGeneration += 1
        let mine = mailboxGeneration
        do {
            let list = try await api.emailMailboxes(workspaceID: workspace)
            guard mine == mailboxGeneration, tracked == workspace else { return }
            mailboxes = list
            unread = list.reduce(0) { $0 + ($1.unread ?? 0) }
            if workspaceID == workspace {
                if provider == nil, let first = list.first {
                    // Nil was the server's default, which is the first of
                    // these; its menu is read again under its own name.
                    provider = first.provider
                    await refreshFolders()
                } else if let shown = provider, let first = list.first, !list.contains(where: { $0.provider == shown }) {
                    // The one on screen was disconnected: the next one, from the top.
                    provider = first.provider
                    folder = EmailMailFolder.inbox
                    loaded = []
                    nextBefore = nil
                    cursor = nil
                    async let list: Void = load()
                    async let menu: Void = refreshFolders()
                    _ = await (list, menu)
                }
            }
            publishAddress()
        } catch {
            if isUnauthorized(error) { await onUnauthorized?() }
        }
    }

    // MARK: The list

    func refresh() async {
        // Nothing to refresh before a workspace is bound — and a spinner
        // raised here would have nothing to lower it.
        guard workspaceID != nil else { return }
        refreshing = true
        async let counts: Void = refreshMailboxes()
        async let menu: Void = refreshFolders()
        async let list: Void = load(showSkeleton: false)
        _ = await (counts, menu, list)
    }

    func retry() async {
        await load()
    }

    /// The next page, when the list has been scrolled to its end.
    func loadMore() async {
        guard let workspace = workspaceID, let before = nextBefore, !loadingMore else { return }
        let mine = generation
        loadingMore = true
        defer { loadingMore = false }
        guard let page = try? await api.emailThreadsPage(
            workspaceID: workspace, filter: filter, before: before, mailbox: provider, folder: folder
        ), mine == generation else { return }
        let seen = Set(loaded.map(\.id))
        loaded += page.threads.filter { !seen.contains($0.id) }
        nextBefore = page.nextBefore
        publish()
    }

    func load(showSkeleton: Bool = true, keepTail: Bool = false) async {
        guard let workspace = workspaceID else { return }
        if showSkeleton { state = .loading }
        generation += 1
        let mine = generation
        let filter = self.filter
        let box = folder
        let shown = provider
        syncing = true
        do {
            let page = try await api.emailThreadsPage(
                workspaceID: workspace, filter: filter, before: nil, mailbox: shown, folder: box
            )
            // A folder switched meanwhile has its own load on the way.
            guard mine == generation else { return }
            // A refresh of the first page keeps the pages already scrolled
            // below it rather than dropping the reader back to the top.
            let oldest = page.threads.last?.lastMessageAt
            let fresh = Set(page.threads.map(\.id))
            let tail: [EmailThreadSummary]
            if keepTail, let oldest {
                tail = loaded.filter { !fresh.contains($0.id) && ($0.lastMessageAt.map { $0 < oldest } ?? false) }
            } else {
                tail = []
            }
            loaded = page.threads + tail
            if tail.isEmpty { nextBefore = page.nextBefore }
            if (filter == .all && box == EmailMailFolder.inbox) || cursor == nil { cursor = page.historyId ?? cursor }
            notConnected = false
            publish()
        } catch {
            guard mine == generation else { return }
            if isUnauthorized(error) {
                await onUnauthorized?()
            } else if isNotConnected(error) {
                // The mailbox has never been connected, or no longer is. Not
                // a failure — a setup step; nothing read from it stays here.
                notConnected = true
                loaded = []
                nextBefore = nil
                cursor = nil
                bodies = [:]
                bodyOrder = []
                publish()
            } else if showSkeleton || loaded.isEmpty {
                state = .failed(emailErrorText(error, language: language))
            }
        }
        guard mine == generation else { return }
        refreshing = false
        syncing = false
    }

    // MARK: Rows

    /// Starred or not, on the row, optimistically — the star flips under the
    /// thumb and the request follows.
    func toggleStar(_ threadID: String) async {
        guard let workspace = workspaceID, let current = loaded.first(where: { $0.id == threadID }) else { return }
        let next = current.isStarred != true
        update(threadID) { $0.isStarred = next }
        do {
            try await api.setEmailThreadStarred(workspaceID: workspace, threadID: threadID, starred: next, mailbox: provider)
        } catch {
            update(threadID) { $0.isStarred = !next }
        }
    }

    /// Read or unread, from the row.
    func toggleRead(_ threadID: String) async {
        guard let current = loaded.first(where: { $0.id == threadID }) else { return }
        await setRead(threadID, read: current.isRead != true)
    }

    /// Read or unread, said to the server from here rather than from the
    /// thread: "Mark unread" is chosen inside a thread that closes at the
    /// same moment. The row and the count change at once, and change back if
    /// the server refuses.
    func setRead(_ threadID: String, read: Bool) async {
        guard let workspace = workspaceID else { return }
        let row = loaded.first { $0.id == threadID }
        let before = row?.isRead
        let flips = row != nil && (row?.isRead == true) != read
        update(threadID) { $0.isRead = read }
        if flips { adjustUnread(read ? -1 : 1) }
        do {
            try await api.setEmailThreadRead(workspaceID: workspace, threadID: threadID, isRead: read, mailbox: provider)
            if flips { recountOutsideInbox() }
        } catch {
            guard workspace == workspaceID, row != nil else { return }
            update(threadID) { $0.isRead = before }
            if flips { adjustUnread(read ? 1 : -1) }
        }
    }

    /// The thread's star changed inside it: the row follows.
    func setStarredLocally(_ threadID: String, starred: Bool) {
        update(threadID) { $0.isStarred = starred }
    }

    /// Unbolds the row as its thread opens rather than at the next refresh,
    /// and takes it off the count. Only the row: opening the thread is what
    /// tells the server it was read.
    func markReadLocally(_ threadID: String) {
        let row = loaded.first { $0.id == threadID }
        update(threadID) { $0.isRead = true }
        if let row, row.isRead != true {
            adjustUnread(-1)
            recountOutsideInbox()
        }
    }

    func thread(_ id: String) -> EmailThreadSummary? {
        loaded.first { $0.id == id }
    }

    private func update(_ threadID: String, _ change: (inout EmailThreadSummary) -> Void) {
        guard let index = loaded.firstIndex(where: { $0.id == threadID }) else { return }
        change(&loaded[index])
        republish()
    }

    // MARK: Signals

    /// A mailbox changed. Signals come in bursts — Gmail's own, then the push
    /// beside it — so they wait a moment and are answered once.
    func onSignal(_ signal: EmailSignal) {
        guard signal.workspaceID == tracked else { return }
        pendingProviders.insert(signal.provider)
        signalTask?.cancel()
        signalTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.signalDebounce * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            await self.answerSignals(for: signal.workspaceID)
        }
    }

    /// The signals waiting out the debounce, answered: the counts, the menu,
    /// and what changed in the list on screen.
    func answerSignals(for workspaceID: String) async {
        let providers = pendingProviders
        pendingProviders = []
        async let counts: Void = refreshMailboxes()
        async let menu: Void = refreshFolders()
        _ = await (counts, menu)
        let shown = provider
        if self.workspaceID == workspaceID, providers.contains(nil) || shown == nil || providers.contains(shown) {
            await checkChanges()
        }
    }

    /// What moved since the first page was read, by id; the first page again
    /// if anything did. A mailbox with no cursor (Yahoo) simply reads the
    /// first page again.
    func checkChanges() async {
        guard let workspace = workspaceID else { return }
        let shown = provider
        let since = cursor
        var changes: EmailChanges?
        if let since {
            changes = try? await api.emailChanges(workspaceID: workspace, since: since, mailbox: shown)
        }
        guard workspace == workspaceID, shown == provider else { return }
        if let changes {
            if let next = changes.historyId { cursor = next }
            if !changes.reset, changes.threadIds.isEmpty { return }
            let content = changes.reset ? nil : Set(changes.contentThreadIds ?? changes.threadIds)
            forget(content)
            markStale(content)
            threadChange = ThreadChange(id: threadChange.id + 1, threads: content)
        } else {
            forget(nil)
            markStale(nil)
            threadChange = ThreadChange(id: threadChange.id + 1, threads: nil)
        }
        await load(showSkeleton: false, keepTail: true)
    }

    // MARK: Threads already read

    /// The thread as last read, if its content has not changed since.
    func cachedThread(_ threadID: String, provider: String?, version: String?, folder: String? = nil) -> EmailThreadResponse? {
        guard let version, let entry = bodies[bodyKey(provider, threadID, folder)], entry.version == version else { return nil }
        return entry.response
    }

    /// Kept per folder too: Spam or Drafts shows a thread with other messages than the inbox does.
    func rememberThread(_ response: EmailThreadResponse, provider: String?, folder: String? = nil) {
        let key = bodyKey(provider, response.thread.id, folder)
        bodies[key] = (response.thread.version, response)
        bodyOrder.removeAll { $0 == key }
        bodyOrder.append(key)
        while bodyOrder.count > Self.bodyCacheSize {
            bodies[bodyOrder.removeFirst()] = nil
        }
    }

    /// `threadID` changed from this phone — a reply sent on it, or marked
    /// unread: its kept copy is dropped, and its screen reads it again.
    func noteChanged(_ threadID: String?) {
        guard let threadID else { return }
        forget([threadID])
        markStale([threadID])
    }

    /// A mail went: the thread it answered is read again when it is back on
    /// screen, and the list too.
    func noteSent(answering threadID: String?) async {
        sentCount += 1
        noteChanged(threadID)
        await refresh()
    }

    /// Whether `threadID` changed since its screen last read it; asking clears it.
    func consumeStale(_ threadID: String) -> Bool {
        let stale = allStale || staleThreads.contains(threadID)
        allStale = false
        staleThreads.remove(threadID)
        return stale
    }

    private func markStale(_ threadIDs: Set<String>?) {
        if let threadIDs { staleThreads.formUnion(threadIDs) } else { allStale = true }
    }

    private func forget(_ threadIDs: Set<String>?) {
        guard let threadIDs else {
            bodies = [:]
            bodyOrder = []
            return
        }
        let gone = bodies.keys.filter { key in threadIDs.contains { key.hasSuffix("|\($0)") } }
        for key in gone { bodies[key] = nil }
        bodyOrder.removeAll { gone.contains($0) }
    }

    private func bodyKey(_ provider: String?, _ threadID: String, _ folder: String?) -> String {
        "\(provider ?? self.provider ?? "-")|\(folder ?? EmailMailFolder.inbox)|\(threadID)"
    }

    // MARK: Counts

    /// A row read or unread here moves the count of the folder on screen, and
    /// — only when that folder is the inbox — the mailbox's own count, which
    /// is its inbox's. Elsewhere the same thread may or may not be in the
    /// inbox: `recountOutsideInbox` asks.
    private func adjustUnread(_ delta: Int) {
        folders = folders.map { entry in
            guard entry.id == folder, let count = entry.unread else { return entry }
            var copy = entry
            copy.unread = max(0, count + delta)
            return copy
        }
        guard folder == EmailMailFolder.inbox, let shown = provider ?? mailboxes.first?.provider else { return }
        mailboxes = mailboxes.map { box in
            guard box.provider == shown, let count = box.unread else { return box }
            var copy = box
            copy.unread = max(0, count + delta)
            return copy
        }
        unread = mailboxes.reduce(0) { $0 + ($1.unread ?? 0) }
    }

    private func recountOutsideInbox() {
        guard folder != EmailMailFolder.inbox else { return }
        recountTask?.cancel()
        recountTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.recountDelay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            async let counts: Void = self.refreshMailboxes()
            async let menu: Void = self.refreshFolders()
            _ = await (counts, menu)
        }
    }

    private func publishAddress() {
        address = (mailboxes.first { $0.provider == provider } ?? mailboxes.first)?.address
    }

    /// The list on screen drawn again after a change made here. Only a list
    /// already shown: while the mailbox is still being read, redrawing would
    /// put "no mail" where the loader is.
    private func republish() {
        if case .loaded = state { publish() }
    }

    /// Filtered here rather than on the server, the same way the chat inbox
    /// filters its own list: this searches what is on screen.
    private func publish() {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else {
            state = .loaded(loaded)
            return
        }
        state = .loaded(loaded.filter { thread in
            let haystack = [thread.subject, thread.lastMessageSnippet].compactMap { $0 } + (thread.participants ?? []).map(\.email)
            return haystack.contains { $0.lowercased().contains(needle) }
        })
    }
}

// MARK: - One thread

enum EmailThreadState: Equatable, Sendable {
    case loading
    case loaded([EmailMessageView])
    case failed(String)
}

/// One thread: the trail, read once, and its star.
@MainActor
@Observable
final class EmailThreadModel {
    private(set) var state: EmailThreadState = .loading
    private(set) var thread: EmailThreadSummary?
    var language: Language = .en
    @ObservationIgnored var onUnauthorized: (@MainActor () async -> Void)?

    @ObservationIgnored private let api: any EmailAPI
    @ObservationIgnored private var workspaceID: String?
    @ObservationIgnored private var threadID: String?
    @ObservationIgnored private var provider: String?
    @ObservationIgnored private var folder: String?
    @ObservationIgnored private var remember: (@MainActor (EmailThreadResponse) -> Void)?

    init(api: any EmailAPI = Backend.current) {
        self.api = api
    }

    var isStarred: Bool { thread?.isStarred == true }

    var messages: [EmailMessageView] {
        if case .loaded(let messages) = state { return messages }
        return []
    }

    /// Shows `threadID`. With `cached` — the thread as this phone last read
    /// it, its content unchanged since — nothing is asked of the server but
    /// the read receipt, if it was unread.
    func open(
        workspaceID: String,
        threadID: String,
        known: EmailThreadSummary?,
        mailbox: String?,
        cached: EmailThreadResponse?,
        folder: String?,
        remember: @escaping @MainActor (EmailThreadResponse) -> Void
    ) async {
        if self.workspaceID == workspaceID, self.threadID == threadID, provider == mailbox, self.folder == folder { return }
        self.workspaceID = workspaceID
        self.threadID = threadID
        provider = mailbox
        self.folder = folder
        self.remember = remember
        // The summary the list already has, so the subject is on screen
        // before the trail arrives.
        thread = known
        if let cached {
            var summary = cached.thread
            summary.isRead = true
            summary.isStarred = known?.isStarred ?? cached.thread.isStarred
            thread = summary
            state = .loaded(cached.messages)
            if known?.isRead != true {
                try? await api.setEmailThreadRead(workspaceID: workspaceID, threadID: threadID, isRead: true, mailbox: mailbox)
            }
            return
        }
        state = .loading
        await load()
    }

    func retry() async {
        state = .loading
        await load()
    }

    /// Read again without a spinner — a reply just sent, or new mail in the thread.
    func reloadQuietly() async {
        if case .loaded = state { await load() }
    }

    private func load() async {
        guard let workspace = workspaceID, let id = threadID else { return }
        let mailbox = provider
        do {
            let response = try await api.emailThread(workspaceID: workspace, threadID: id, mailbox: mailbox, folder: folder)
            guard workspace == workspaceID, id == threadID else { return }
            thread = response.thread
            state = .loaded(response.messages)
            remember?(response)
            // Opening a thread is what reading it means.
            if response.thread.isRead != true {
                try? await api.setEmailThreadRead(workspaceID: workspace, threadID: id, isRead: true, mailbox: mailbox)
            }
        } catch {
            if isUnauthorized(error) {
                await onUnauthorized?()
                return
            }
            if case .loaded = state { return }
            state = .failed(emailErrorText(error, language: language))
        }
    }

    /// Starred, optimistically: the star flips under the thumb and the
    /// request follows.
    func toggleStar() async {
        guard let workspace = workspaceID, var current = thread else { return }
        let next = current.isStarred != true
        current.isStarred = next
        thread = current
        try? await api.setEmailThreadStarred(workspaceID: workspace, threadID: current.id, starred: next, mailbox: provider)
    }
}

// MARK: - Writing

/// How a reply is addressed.
enum EmailReplyMode: String, Hashable, Sendable {
    case reply, replyAll, forward
}

/// A file on its way into a mail: uploading, ready, or refused.
struct ComposeAttachment: Identifiable, Equatable, Sendable {
    let id: String
    let filename: String
    let sizeBytes: Int
    var staged: StagedEmailAttachment?
    var failed = false

    var uploading: Bool { staged == nil && !failed }
}

/// The typed parts of a mail, compared to tell whether anything was written.
struct ComposeFields: Equatable, Sendable {
    var to = ""
    var cc = ""
    var bcc = ""
    var subject = ""
    var body = ""

    var trimmed: ComposeFields {
        ComposeFields(
            to: to.trimmingCharacters(in: .whitespacesAndNewlines), cc: cc.trimmingCharacters(in: .whitespacesAndNewlines),
            bcc: bcc.trimmingCharacters(in: .whitespacesAndNewlines),
            subject: subject.trimmingCharacters(in: .whitespacesAndNewlines),
            body: body.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }
}

/// What a reply, a reply-to-all or a forward starts out with.
struct EmailPrefill: Equatable, Sendable {
    let threadID: String?
    let to: [String]
    let cc: [String]
    let subject: String
    let body: String
}

/// The composer: a new mail, or an answer to a thread.
///
/// Addresses are typed as text and split on commas, the way every mail client
/// takes them, and checked before anything leaves — a mistyped address is
/// said now rather than after a round trip. Files upload as they are picked,
/// so Send only waits for the mail itself.
@MainActor
@Observable
final class EmailComposeModel {
    var fields = ComposeFields() {
        didSet { if fields != oldValue { error = nil } }
    }
    var showCopies = false
    private(set) var attachments: [ComposeAttachment] = []
    private(set) var sending = false
    var error: String?
    private(set) var sent = false
    /// Filled in once the thread (when there is one) has been read.
    private(set) var ready = false
    /// What the fields held when the form became ready.
    private(set) var initial = ComposeFields()
    var language: Language = .en

    /// Anything the operator would lose by leaving: a field changed from how
    /// it started, or a file.
    var touched: Bool { fields.trimmed != initial.trimmed || !attachments.isEmpty }

    @ObservationIgnored private let api: any EmailAPI
    @ObservationIgnored private var workspaceID: String?
    @ObservationIgnored private var threadID: String?
    @ObservationIgnored private var provider: String?
    @ObservationIgnored private var started = false
    @ObservationIgnored private let makeID: () -> String

    init(api: any EmailAPI = Backend.current, makeID: @escaping () -> String = { UUID().uuidString }) {
        self.api = api
        self.makeID = makeID
    }

    /// `mailbox` is the workspace's own address (left out of a reply's To
    /// and Cc); `provider` the mailbox the mail goes from.
    func start(workspaceID: String, sourceThreadID: String?, mode: EmailReplyMode?, mailbox: String?, provider: String?) async {
        guard !started else { return }
        started = true
        self.workspaceID = workspaceID
        self.provider = provider
        guard let sourceThreadID, let mode else {
            ready = true
            return
        }
        // A reply belongs to its thread whether or not the thread could be
        // read: it must not go out as a new conversation because of a failed read.
        if mode != .forward { threadID = sourceThreadID }
        do {
            let response = try await api.emailThread(workspaceID: workspaceID, threadID: sourceThreadID, mailbox: provider, folder: nil)
            let prefill = Self.prefill(mode, thread: response.thread, messages: response.messages, mailbox: mailbox, language: language)
            threadID = prefill.threadID
            fields = ComposeFields(
                to: prefill.to.joined(separator: ", "),
                cc: prefill.cc.joined(separator: ", "),
                bcc: "",
                subject: prefill.subject,
                body: prefill.body
            )
            showCopies = !prefill.cc.isEmpty
            initial = fields
            ready = true
        } catch {
            ready = true
            self.error = emailErrorText(error, language: language)
        }
    }

    func attach(data: Data, filename: String, contentType: String) async {
        guard let workspace = workspaceID else { return }
        let entry = ComposeAttachment(id: makeID(), filename: filename, sizeBytes: data.count)
        attachments.append(entry)
        do {
            let staged = try await api.stageEmailAttachment(
                workspaceID: workspace, data: data, filename: filename, contentType: contentType, mailbox: provider
            )
            replace(entry.id) { $0.staged = staged }
        } catch {
            replace(entry.id) { $0.failed = true }
            self.error = EmailStr.uploadFailed(language)
        }
    }

    func removeAttachment(_ id: String) {
        attachments.removeAll { $0.id == id }
    }

    private func replace(_ id: String, _ change: (inout ComposeAttachment) -> Void) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        change(&attachments[index])
    }

    /// What would stop the mail going, said before it is sent; nil when it can go.
    func problem() -> String? {
        let l = language
        let to = EmailAddressing.list(fields.to)
        let cc = EmailAddressing.list(fields.cc)
        let bcc = EmailAddressing.list(fields.bcc)
        let bad = (to + cc + bcc).filter { !EmailAddressing.isValid($0) }
        if !bad.isEmpty { return EmailStr.invalidAddresses(l, bad.joined(separator: ", ")) }
        if to.isEmpty { return EmailStr.needsRecipient(l) }
        if fields.subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return EmailStr.needsSubject(l) }
        if attachments.contains(where: \.uploading) { return EmailStr.uploading(l) }
        // A file whose upload failed is still on screen, in red, and the
        // mail very likely says "attached": sending anyway would drop it
        // without a word.
        if attachments.contains(where: \.failed) { return EmailStr.uploadFailed(l) }
        return nil
    }

    func send() async {
        guard let workspace = workspaceID, !sending else { return }
        if let problem = problem() {
            error = problem
            return
        }
        sending = true
        error = nil
        defer { sending = false }
        let body = fields.body.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await api.sendEmailDraft(
                workspaceID: workspace,
                draft: EmailDraft(
                    threadID: threadID,
                    to: EmailAddressing.list(fields.to),
                    cc: EmailAddressing.list(fields.cc),
                    bcc: EmailAddressing.list(fields.bcc),
                    subject: fields.subject.trimmingCharacters(in: .whitespacesAndNewlines),
                    // The server needs a body; a mail of attachments alone still says something.
                    body: body.isEmpty ? " " : body,
                    attachments: attachments.compactMap(\.staged)
                ),
                mailbox: provider
            )
            sent = true
        } catch {
            self.error = emailErrorText(error, language: language)
        }
    }

    private static let re = try! NSRegularExpression(pattern: "^(re|پاسخ|ynt|yanıt)\\s*:", options: .caseInsensitive)
    private static let fwd = try! NSRegularExpression(pattern: "^(fwd?|ارسال|ilt)\\s*:", options: .caseInsensitive)

    private static func starts(_ pattern: NSRegularExpression, _ text: String) -> Bool {
        pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// Who a reply goes to and what it is called.
    ///
    /// Reply is the last person who wrote in; Reply all adds everyone else on
    /// that mail, less the mailbox itself; Forward starts a new thread
    /// addressed to nobody, with the mail it forwards set out underneath.
    static func prefill(
        _ mode: EmailReplyMode,
        thread: EmailThreadSummary,
        messages: [EmailMessageView],
        mailbox: String?,
        language: Language
    ) -> EmailPrefill {
        func isMailbox(_ address: String) -> Bool { mailbox.map { EmailAddressing.same(address, $0) } ?? false }
        let subject = (thread.subject ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let last = messages.last
        let lastInbound = messages.last { !$0.isOutbound }

        let sender = lastInbound?.fromAddress.map(EmailAddressing.address).flatMap { $0.isEmpty ? nil : $0 }
        let fallback = (thread.participants ?? [])
            .map { EmailAddressing.address($0.email) }
            .filter { !$0.isEmpty && !isMailbox($0) }
        let replyTo = sender.map { [$0] } ?? Array(fallback.prefix(1))
        let reSubject = starts(re, subject) ? subject : "Re: \(subject)".trimmingCharacters(in: .whitespaces)

        switch mode {
        case .reply:
            return EmailPrefill(threadID: thread.id, to: replyTo, cc: [], subject: reSubject, body: "")
        case .replyAll:
            var seen = Set<String>()
            let others = ((last?.toAddresses ?? []) + (last?.ccAddresses ?? []))
                .map { EmailAddressing.address($0.email) }
                .filter { !$0.isEmpty && !isMailbox($0) }
                .filter { other in !replyTo.contains { EmailAddressing.same($0, other) } }
                .filter { seen.insert($0.lowercased()).inserted }
            return EmailPrefill(threadID: thread.id, to: replyTo, cc: others, subject: reSubject, body: "")
        case .forward:
            var body = ""
            if let original = last {
                body += "\n\n" + EmailStr.forwardedHeader(language) + "\n"
                body += "\(EmailStr.from(language)): \(original.fromAddress ?? "")\n"
                if let at = original.sentAt {
                    body += "\(EmailStr.date(language)): \(Format.dayHeader(at, locale: language.locale)) "
                        + "\(Format.bubbleTime(at, locale: language.locale))\n"
                }
                body += "\(EmailStr.subject(language)): \(subject)\n"
                let to = (original.toAddresses ?? []).map(\.email).joined(separator: ", ")
                if !to.isEmpty { body += "\(EmailStr.to(language)): \(to)\n" }
                body += "\n" + original.displayBody
            }
            let fwdSubject = starts(fwd, subject) ? subject : "Fwd: \(subject)".trimmingCharacters(in: .whitespaces)
            return EmailPrefill(threadID: nil, to: [], cc: [], subject: fwdSubject, body: body)
        }
    }
}

// MARK: - From the inbox

/// One way into the mail from the chat inbox's list of every inbox: the
/// mailbox, or one per mailbox when a Gmail and a Yahoo are both connected —
/// each with its own count, the address beside the name to tell them apart.
struct EmailEntry: Equatable, Sendable {
    /// Nil for the workspace's one mailbox, whichever it is.
    let provider: String?
    let label: String
    let unread: Int

    static func entries(_ language: Language, mailboxes: [EmailMailbox], unread: Int) -> [EmailEntry] {
        guard mailboxes.count > 1 else {
            return [EmailEntry(provider: mailboxes.first?.provider, label: Str.emailInbox(language), unread: unread)]
        }
        return mailboxes.map { box in
            // The address isolated left to right inside a Persian label.
            let address = box.address
                .flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : "\u{2066}\($0)\u{2069}" }
                ?? box.provider
            return EmailEntry(provider: box.provider, label: "\(Str.emailInbox(language)) · \(address)", unread: box.unread ?? 0)
        }
    }
}
