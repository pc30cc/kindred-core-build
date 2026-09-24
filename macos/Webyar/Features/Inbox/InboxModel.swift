import Foundation
import Observation

/// The conversation list for the queue or channel picked in the sidebar,
/// and the open conversation beside it — the Windows app's InboxPage.
@MainActor
@Observable
final class InboxModel {
    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var poller: Poller?
    @ObservationIgnored private var events: Signal<InboxEvent>.Token?
    @ObservationIgnored private var generation = 0

    private(set) var filter: InboxFilter = .open
    private(set) var channel: String?
    private(set) var conversations: [Conversation] = []
    private(set) var loading = true
    private(set) var error: String?
    var search = ""

    /// The open conversation's thread; replaced when another one is picked.
    private(set) var chat: ChatModel?
    var selectedId: String? { chat?.id }

    init(app: AppModel) {
        self.app = app
    }

    func start() {
        guard poller == nil else { return }
        poller = Poller("inbox", interval: { [weak self] in self?.app.listInterval ?? 15 }) { [weak self] in try await self?.load() }
        poller?.start()
        events = app.inboxEvents.subscribe { [weak self] _ in self?.poller?.kick() }
    }

    func stop() {
        poller?.stop()
        poller = nil
        events?.cancelNow()
        chat?.close()
    }

    func refresh() { poller?.kick() }

    /// Switches to one of the inboxes in the sidebar: a queue/status,
    /// optionally narrowed to one channel ("Other inboxes"), as the web does.
    func show(_ route: Route) {
        start()
        let (f, ch): (InboxFilter, String?) = {
            switch route {
            case .inbox(let f): return (f, nil)
            case .channel(let key): return (.open, key)
            default: return (.open, nil)
            }
        }()
        guard f != filter || ch != channel else { return }
        filter = f
        channel = ch
        generation += 1
        conversations = []
        loading = true
        error = nil
        poller?.kick()
    }

    var title: String {
        let s = app.strings
        if let channel { return Display.channelLabel(channel, s) }
        switch filter {
        case .ai: return s["navInboxAi"]
        case .needsHuman: return s["navInboxNeedsHuman"]
        case .pending: return s["navInboxPending"]
        case .resolved: return s["navInboxResolved"]
        case .spam: return s["navInboxSpam"]
        case .open: return s["navInboxOpen"]
        }
    }

    /// The list on show: the loaded page, narrowed by the search box.
    var visible: [Conversation] {
        let q = search.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return conversations }
        let s = app.strings
        return conversations.filter { c in
            Display.conversationName(c, s).localizedCaseInsensitiveContains(q)
                || Display.preview(c.lastMessage, s).localizedCaseInsensitiveContains(q)
                || (c.contacts?.email?.localizedCaseInsensitiveContains(q) ?? false)
        }
    }

    var unreadConversations: Int { conversations.filter { ($0.unreadCount ?? 0) > 0 }.count }

    private func load() async throws {
        guard let ws = app.workspace else { return }
        let gen = generation
        defer { if gen == generation { loading = false } }
        do {
            var list = try await app.api.conversations(workspaceId: ws.id, filter: filter)
            guard gen == generation else { return } // the inbox changed while this was loading
            list = await app.withVisitorProfiles(list)
            guard gen == generation else { return }
            apply(list)
            error = nil
        } catch let e as ApiError where e.failure != .unauthorized {
            error = ErrorText.of(e, app.strings)
            throw e
        }
    }

    private func apply(_ list: [Conversation]) {
        conversations = list
            .filter { channel == nil || $0.channelKey == channel }
            .sorted { ($0.lastActivity ?? .distantPast) > ($1.lastActivity ?? .distantPast) }
        if let chat, let c = conversations.first(where: { $0.id == chat.id }) { chat.update(c) }
        if let pending = app.pendingConversation {
            app.pendingConversation = nil
            open(pending)
        }
    }

    // MARK: Selection

    func select(_ id: String?) {
        guard let id else { return }
        guard id != chat?.id else { return }
        if let c = conversations.first(where: { $0.id == id }) {
            openChat(id: id, conversation: c)
        } else {
            open(id)
        }
    }

    /// Opens a conversation, e.g. from a notification, even when it is not in the current list.
    func open(_ id: String) {
        if let c = conversations.first(where: { $0.id == id }) {
            openChat(id: id, conversation: c)
            return
        }
        openChat(id: id, conversation: nil)
        Task { await find(id) }
    }

    private func openChat(id: String, conversation: Conversation?) {
        chat?.close()
        let model = ChatModel(app: app, id: id, conversation: conversation)
        model.onChanged = { [weak self] in
            self?.poller?.kick()
            self?.app.kickBackground()
        }
        chat = model
        app.visibleConversationId = id
        model.start()
    }

    /// A conversation outside the list on show (a notification, another queue):
    /// the queues are searched for it so the header, the AI state and the
    /// actions are right, not just the messages.
    private func find(_ id: String) async {
        guard let ws = app.workspace else { return }
        for f in [InboxFilter.ai, .open, .pending, .resolved, .spam] {
            do {
                let list = try await app.api.conversations(workspaceId: ws.id, filter: f)
                guard let hit = list.first(where: { $0.id == id }) else { continue }
                guard chat?.id == id else { return }
                let enriched = await app.withVisitorProfiles([hit])
                if chat?.id == id { chat?.update(enriched[0]) }
                return
            } catch {
                Log.error("find conversation", error)
                return
            }
        }
    }
}
