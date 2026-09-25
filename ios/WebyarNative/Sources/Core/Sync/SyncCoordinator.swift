import Foundation
import Observation

/// Something that should make a screen read again — or show at once.
enum SyncEvent: Sendable, Equatable {
    /// A message arrived over realtime. `message` is the row when the
    /// envelope carried one that could be read, shown before the read that
    /// fills it in.
    case message(conversationID: String, message: Message?)
    /// A conversation changed (status, assignee, seen, tags…). Nil when the
    /// event did not say which.
    case conversationChanged(conversationID: String?)
    /// A push notification for a conversation arrived while the app was open,
    /// or was tapped. Push may be late, grouped or dropped, so it only ever
    /// starts a read; it is never taken as the message itself.
    case push(conversationID: String, messageID: String?)
    /// Back in front of the operator, or realtime back after a gap: events may
    /// have been missed. A cheap catch-up — a delta for an open thread, a
    /// revalidated list.
    case resync
    /// The saved copy was cleared or replaced: threads read whole.
    case reconcile
}

/// Where the local-first pieces meet: the store and the lists of the
/// account and workspace being worked in, realtime, and the app's lifecycle.
///
/// Screens never talk to SQLite or to the socket. They read the saved copy
/// through this, render it at once, and listen to `events()` for the moments
/// that should make them read again:
///
///     saved copy → screen → realtime / push / foreground → delta → merge
///
/// Its lifecycle rules are iOS's:
/// - **Active**: realtime connects; a catch-up read runs on return.
/// - **Background**: realtime disconnects at once. Nothing keeps a socket or
///   a timer alive; APNs is what reaches the operator there.
/// - **Inactive** (Control Centre, the app switcher, a system alert):
///   nothing changes — it is usually over in a second, and tearing a socket
///   down for it would cost a reconnect every time a notification is pulled
///   down.
@MainActor
@Observable
final class SyncCoordinator {
    static let shared = SyncCoordinator()

    /// Realtime is connected: screens relax their polling to a safety net.
    private(set) var realtimeConnected = false
    /// The scene is active.
    private(set) var isForeground = true
    /// Bumped on every change of account or workspace, so an answer that
    /// belongs to the previous one can be recognised and dropped.
    private(set) var scopeGeneration = 0

    @ObservationIgnored private(set) var scope: LocalStore.Scope?
    @ObservationIgnored private var stores: [LocalStore.Scope: LocalStore] = [:]
    @ObservationIgnored private(set) var lists: ConversationLists?
    @ObservationIgnored private var realtime: InboxRealtime?
    @ObservationIgnored private var continuations: [UUID: AsyncStream<SyncEvent>.Continuation] = [:]
    @ObservationIgnored private let api: any WebyarAPI
    /// False for the sample backend: nothing of a screenshot run is kept.
    @ObservationIgnored private let persistent: Bool
    @ObservationIgnored private let storeRoot: URL?
    @ObservationIgnored private let startsRealtime: Bool
    @ObservationIgnored private var upkeep: Task<Void, Never>?
    @ObservationIgnored private var attachmentScopeHandOver: Task<Void, Never>?
    @ObservationIgnored private var backgroundedAt: Date?

    init(
        api: any WebyarAPI = Backend.current,
        persistent: Bool = !Backend.isSample,
        storeRoot: URL? = nil,
        startsRealtime: Bool = true
    ) {
        self.api = api
        self.persistent = persistent
        self.storeRoot = storeRoot
        self.startsRealtime = startsRealtime
    }

    // MARK: - Events

    /// Every event from now on, until the listener stops listening — which a
    /// SwiftUI `.task` does on its own when its view goes away.
    func events() -> AsyncStream<SyncEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: SyncEvent.self, bufferingPolicy: .bufferingNewest(32))
        continuations[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.continuations[id] = nil }
        }
        return stream
    }

    func emit(_ event: SyncEvent) {
        for continuation in continuations.values { continuation.yield(event) }
    }

    var listenerCount: Int { continuations.count }

    // MARK: - Scope

    /// Who is signed in and where. Called by `AppState` the moment either
    /// changes, before anything is drawn for the new one.
    func sessionChanged(userID: String?, workspaceID: String?) {
        let next = userID.flatMap { user in workspaceID.map { LocalStore.Scope(userID: user, workspaceID: $0) } }
        guard next != scope else { return }
        let previous = scope
        stopRealtime()
        scope = next
        scopeGeneration += 1
        VisitorIntelCache.shared.use(workspaceID: next?.workspaceID)
        // In order: a sign-out and a sign-in a moment apart must reach the
        // attachment store in that order, never the other way round.
        let attachmentScope = next, previousHandOver = attachmentScopeHandOver
        attachmentScopeHandOver = Task {
            await previousHandOver?.value
            await AttachmentStore.shared.setScope(attachmentScope)
        }
        if previous?.userID != next?.userID {
            // Nothing decoded for one account is on hand for the next.
            ImageCache.shared.clearMemory()
            AttachmentPreviews.clear()
            closeStores()
        }
        guard let next else {
            lists = nil
            return
        }
        let workspaceID = next.workspaceID
        lists = ConversationLists(
            workspaceID: workspaceID,
            store: { [weak self] in self?.store(for: workspaceID) },
            fetch: { [api] filter, etag in
                try await api.conversations(workspaceID: workspaceID, filter: filter, etag: etag)
            }
        )
        if isForeground { startRealtime() }
        scheduleUpkeep()
    }

    /// The saved copy for `workspaceID`, if that is the workspace open now —
    /// never another's, whatever is open by the time a caller asks.
    func store(for workspaceID: String) -> LocalStore? {
        guard persistent, let scope, scope.workspaceID == workspaceID else { return nil }
        if let open = stores[scope] { return open }
        let store = LocalStore(scope: scope, root: storeRoot)
        stores[scope] = store
        return store
    }

    func lists(for workspaceID: String) -> ConversationLists? {
        guard let lists, lists.workspaceID == workspaceID else { return nil }
        return lists
    }

    private func closeStores() {
        let open = Array(stores.values)
        stores = [:]
        Task.detached(priority: .utility) {
            for store in open { await store.close() }
        }
    }

    // MARK: - Signing out

    /// The session ended. Memory of it goes at once; the saved copy on disk
    /// goes too when the operator chose to leave (`purge`), and stays for the
    /// same account's next sign-in when the session merely expired — it is
    /// in that account's own folder, and no other account can read it.
    func endSession(userID: String?, purge: Bool) async {
        sessionChanged(userID: nil, workspaceID: nil)
        await AttachmentStore.shared.clearMemory()
        ImageCache.shared.clearMemory()
        AttachmentPreviews.clear()
        VisitorIntelCache.shared.clear()
        guard purge, persistent, let userID else { return }
        let root = storeRoot
        await Task.detached(priority: .utility) {
            LocalStore.removeUser(userID, root: root)
        }.value
        await AttachmentDiskCache.shared.removeUser(userID)
    }

    // MARK: - Lifecycle

    func appBecameActive() {
        guard !isForeground || backgroundedAt != nil else { return }
        isForeground = true
        let wasAway = backgroundedAt != nil
        backgroundedAt = nil
        guard scope != nil else { return }
        startRealtime()
        if wasAway {
            lists?.invalidate()
            emit(.resync)
        }
    }

    func appEnteredBackground() {
        isForeground = false
        backgroundedAt = Date()
        // No socket behind the operator's back: APNs is the way in from here.
        stopRealtime()
        upkeep?.cancel()
    }

    // MARK: - Push

    /// A notification for a conversation arrived while the app is open, or
    /// was tapped. It starts a read of that conversation and a revalidation
    /// of the list — nothing is reloaded whole because of it.
    func pushArrived(workspaceID: String?, conversationID: String, messageID: String?) {
        if let workspaceID, workspaceID != scope?.workspaceID { return }
        lists?.invalidate()
        emit(.push(conversationID: conversationID, messageID: messageID))
    }

    // MARK: - Finding one conversation

    /// A conversation the open list may not have — a notification's. This
    /// session's lists first, then the saved copy, and only then one targeted
    /// read of that conversation (never every queue in turn).
    func conversation(id: String, workspaceID: String) async -> Conversation? {
        if let hit = lists(for: workspaceID)?.conversation(id: id) { return hit }
        if let saved = await store(for: workspaceID)?.conversation(id), saved.workspaceId == workspaceID { return saved }
        let generation = scopeGeneration
        guard let fetched = try? await api.conversation(id: id, workspaceID: workspaceID),
              fetched.workspaceId == workspaceID,
              generation == scopeGeneration
        else { return nil }
        await store(for: workspaceID)?.saveConversation(fetched)
        return fetched
    }

    // MARK: - Realtime

    private func startRealtime() {
        guard startsRealtime, realtime == nil, let scope else { return }
        let connection = InboxRealtime(api: api, workspaceID: scope.workspaceID)
        connection.onEvent = { [weak self] event in self?.handle(event, from: scope.workspaceID) }
        connection.onConnectionChanged = { [weak self] up in
            guard let self, self.scope == scope else { return }
            self.realtimeConnected = up
            if up {
                // Events published before this socket was up were never seen:
                // one catch-up read covers them, first connection included.
                self.lists?.invalidate()
                self.emit(.resync)
            }
        }
        realtime = connection
        connection.start()
    }

    private func stopRealtime() {
        realtime?.onEvent = nil
        realtime?.onConnectionChanged = nil
        realtime?.stop()
        realtime = nil
        realtimeConnected = false
    }

    private func handle(_ event: RealtimeEvent, from workspaceID: String) {
        guard scope?.workspaceID == workspaceID, !event.needsNoRead else { return }
        // Before anyone reads again: no list read before this is handed out as current.
        lists?.invalidate()
        if event.isMessage, let conversationID = event.conversationID {
            emit(.message(conversationID: conversationID, message: event.message))
        } else {
            emit(.conversationChanged(conversationID: event.conversationID))
        }
    }

    // MARK: - Upkeep

    /// Pruning the store and trimming the files: off the main thread, at
    /// utility priority, a few seconds after the screen is up — never on the
    /// way to the first frame. Compaction waits for a phone not saving power.
    private func scheduleUpkeep() {
        guard persistent, let scope else { return }
        upkeep?.cancel()
        let store = store(for: scope.workspaceID)
        upkeep = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
            await store?.prune(allowVacuum: !lowPower)
            await AttachmentDiskCache.shared.trim()
        }
    }

    // MARK: - Clearing

    /// Settings → Storage → Clear: the saved messages, lists, files and
    /// pictures on this phone. Not the server, not the session, not a
    /// preference. What is on screen stays, and is read again.
    func clearCache() async {
        let keep = scope.flatMap { stores[$0] }
        let root = storeRoot
        await Task.detached(priority: .userInitiated) {
            LocalStore.removeAll(except: keep?.url, root: root)
        }.value
        await keep?.reset()
        await AttachmentDiskCache.shared.removeAll()
        await AttachmentStore.shared.clearMemory()
        ImageCache.shared.clearAll()
        AttachmentPreviews.clear()
        VisitorIntelCache.shared.clear()
        lists?.forget()
        emit(.reconcile)
    }

    /// What Settings shows: the saved conversations, the files, and the
    /// pictures, measured on disk.
    func storageUsage() async -> StorageUsage {
        let root = storeRoot
        let messages = await Task.detached(priority: .utility) { LocalStore.measure(root: root) }.value
        let files = await AttachmentDiskCache.shared.size()
        let pictures = Int64(ImageCache.shared.diskBytes)
        return StorageUsage(messages: messages, files: files, pictures: pictures)
    }
}

struct StorageUsage: Sendable, Equatable {
    var messages: Int64
    var files: Int64
    var pictures: Int64
    var total: Int64 { messages + files + pictures }
}
