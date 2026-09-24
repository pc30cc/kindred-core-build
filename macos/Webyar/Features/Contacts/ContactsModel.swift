import Foundation
import Observation

/// A contact row, as the web contacts table draws it: the display name
/// ("Visitor from Tehran · AB12" for the anonymous) seeds the avatar, which
/// shows the visitor's OS and country from the network profile.
struct ContactItem: Identifiable, Hashable {
    let contact: Contact
    let profile: VisitorProfile?
    let name: String
    /// "Tehran, Iran" — the web's location column.
    let location: String

    init(_ c: Contact, profile: VisitorProfile?, _ s: Strings) {
        contact = c
        self.profile = profile
        name = Display.visitorName(name: c.name, code: c.visitorCode ?? c.metaString("anon_code"), fallbackId: c.id,
                                   city: profile?.geo?.city, region: profile?.geo?.region, countryCode: profile?.geo?.countryCode, s)
        let parts: [String] = [profile?.geo?.city, profile?.geo?.country]
            .compactMap { $0 }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        location = parts.joined(separator: s.isRightToLeft ? "، " : ", ")
    }

    var id: String { contact.id }
    var email: String? { contact.email }
    var avatarUrl: String? { contact.avatarUrl }
    var os: String? { profile?.device?.os }
    var countryCode: String? { profile?.geo?.countryCode }
    var subtitle: String { contact.email ?? contact.phone ?? contact.company ?? "" }

    func matches(_ q: String) -> Bool {
        if q.isEmpty { return true }
        let c = contact
        return name.localizedCaseInsensitiveContains(q)
            || (c.email?.localizedCaseInsensitiveContains(q) ?? false)
            || (c.phone?.localizedCaseInsensitiveContains(q) ?? false)
            || (c.visitorCode?.localizedCaseInsensitiveContains(q) ?? false)
            || (c.company?.localizedCaseInsensitiveContains(q) ?? false)
    }
}

/// The profile's sections, as the Windows SelectorBar lists them.
enum ContactTab: String, CaseIterable, Identifiable, Hashable {
    case overview, chats, calls, notes
    var id: String { rawValue }
}

/// Everyone who has talked to the workspace, searchable, and each one as a
/// profile — the web's contact page: details, their conversations, their
/// calls, notes and tags (the Windows app's ContactsPage).
@MainActor
@Observable
final class ContactsModel {
    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var listTask: Task<Void, Never>?
    @ObservationIgnored private var detailTask: Task<Void, Never>?
    @ObservationIgnored private var listGeneration = 0
    @ObservationIgnored private var detailGeneration = 0
    /// Contacts and their network profiles, kept so a language change can relabel without a reload.
    @ObservationIgnored private var raw: [(Contact, VisitorProfile?)] = []
    @ObservationIgnored private var loadedWorkspace: String?
    @ObservationIgnored private var launchContactHandled = false

    private(set) var all: [ContactItem] = []
    private(set) var loading = true
    private(set) var error: String?
    var search = ""

    // The contact on show.
    private(set) var selectedId: String?
    private(set) var shown: ContactItem?
    /// The full record once /api/contacts/:id answers; the list's copy until then.
    private(set) var detail: Contact?
    /// nil while loading.
    private(set) var chats: [ContactConversation]?
    private(set) var calls: [ContactCall]?
    private(set) var detailLoading = false
    private(set) var detailError: String?
    var tab: ContactTab = .overview

    init(app: AppModel) {
        self.app = app
    }

    /// Loads on the first look at the page, and again each time it is shown
    /// (Windows reloads on every navigation) or the workspace changes.
    func start() {
        let ws = app.workspace?.id
        if ws != loadedWorkspace {
            loadedWorkspace = ws
            clearSelection()
            all = []
            raw = []
            loading = true
        }
        reload()
        // A profile left half-loaded when the page was last hidden picks up where it stopped.
        if let item = shown, calls == nil, detailError == nil {
            detailTask?.cancel()
            detailGeneration += 1
            let gen = detailGeneration
            detailLoading = true
            detailTask = Task { [weak self] in await self?.loadDetail(item, gen) }
        }
    }

    func stop() {
        listTask?.cancel()
        listTask = nil
        detailTask?.cancel()
        detailTask = nil
        listGeneration += 1
        detailGeneration += 1
    }

    func reload() {
        listTask?.cancel()
        listGeneration += 1
        let gen = listGeneration
        listTask = Task { [weak self] in await self?.load(gen) }
    }

    /// The list on show: the search, at most 500 rows, like Windows.
    var visible: [ContactItem] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty { return Array(all.prefix(500)) }
        return Array(all.lazy.filter { $0.matches(q) }.prefix(500))
    }

    /// Names depend on the language ("Visitor from …"); rebuilt when it changes.
    func relabel() {
        let s = app.strings
        all = raw.map { ContactItem($0.0, profile: $0.1, s) }
        if let id = selectedId, let item = all.first(where: { $0.id == id }) { shown = item }
    }

    private func load(_ gen: Int) async {
        guard let ws = app.workspace else {
            loading = false
            return
        }
        do {
            let contacts = try await app.api.contacts(workspaceId: ws.id)
            guard gen == listGeneration else { return }
            // Like the web table, rows wait for the network profiles, so the
            // avatars appear once, with the OS and flag, instead of changing.
            var profiles = await app.api.contactProfiles(workspaceId: ws.id, contactIds: contacts.map(\.id))
            guard gen == listGeneration else { return }
            // Many anonymous widget contacts have no session linked back to them, so the
            // server finds no device; the session the widget recorded on the contact
            // (metadata.session_id) still knows it.
            let orphans = contacts.filter { profiles[$0.id]?.device?.os == nil }
            let sessionOf = Dictionary(orphans.compactMap { c in c.metaString("session_id").map { (c.id, $0) } }, uniquingKeysWith: { a, _ in a })
            if !sessionOf.isEmpty {
                let bySession = await app.api.sessionProfiles(workspaceId: ws.id, sessionIds: Array(Set(sessionOf.values)))
                guard gen == listGeneration else { return }
                for (contactId, sessionId) in sessionOf {
                    if let p = bySession[sessionId], p.device?.os != nil || profiles[contactId] == nil { profiles[contactId] = p }
                }
            }
            #if DEBUG
            Log.write("[contacts] devices \(contacts.filter { profiles[$0.id]?.device?.os != nil }.count) of \(contacts.count); \(orphans.count) needed the session fallback")
            #endif
            let sorted: [Contact] = contacts.sorted { Self.stamp($0) > Self.stamp($1) }
            raw = sorted.map { c -> (Contact, VisitorProfile?) in (c, profiles[c.id]) }
            relabel()
            error = nil
            loading = false
            openLaunchContact()
        } catch {
            guard gen == listGeneration else { return }
            if error is CancellationError { return }
            Log.error("contacts", error)
            if all.isEmpty { self.error = ErrorText.of(error, app.strings) }
            loading = false
        }
    }

    /// Newest first: the last update, else when the contact was created.
    private static func stamp(_ c: Contact) -> Date {
        c.updatedAt ?? c.createdAt ?? Date.distantPast
    }

    /// `Webyar --page=contacts --contact=<id>` opens straight on that profile.
    private func openLaunchContact() {
        guard !launchContactHandled else { return }
        launchContactHandled = true
        let prefix = "--contact="
        guard let arg = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(prefix) }) else { return }
        let wanted = String(arg.dropFirst(prefix.count))
        if all.contains(where: { $0.id == wanted }) { select(wanted) }
    }

    // MARK: Selection

    private func clearSelection() {
        detailTask?.cancel()
        detailGeneration += 1
        selectedId = nil
        shown = nil
        detail = nil
        chats = nil
        calls = nil
        detailLoading = false
        detailError = nil
    }

    func select(_ id: String?) {
        guard let id, id != selectedId, let item = all.first(where: { $0.id == id }) else { return }
        detailTask?.cancel()
        detailGeneration += 1
        let gen = detailGeneration
        selectedId = id
        shown = item
        detail = item.contact
        chats = nil
        calls = nil
        detailError = nil
        detailLoading = true
        detailTask = Task { [weak self] in await self?.loadDetail(item, gen) }
    }

    private func loadDetail(_ item: ContactItem, _ gen: Int) async {
        guard let ws = app.workspace else { return }
        let id = item.id
        do {
            async let full = app.api.contact(id)
            async let chatList = app.api.contactConversations(id)
            async let callList = app.api.contactCalls(workspaceId: ws.id, contactId: id)
            let fetched: Contact? = try await full
            guard gen == detailGeneration else { return }
            detail = fetched ?? item.contact
            let c = try await chatList
            guard gen == detailGeneration else { return }
            chats = c
            let k = await callList
            guard gen == detailGeneration else { return }
            calls = k
            detailLoading = false
        } catch {
            guard gen == detailGeneration else { return }
            if error is CancellationError { return }
            Log.error("contact detail", error)
            detailError = "\(app.strings["contactLoadFailed"]) — \(ErrorText.of(error, app.strings))"
            detailLoading = false
        }
    }

    // MARK: Actions

    /// The newest conversation, for "Open conversation" in the header.
    func openLatest() {
        if let latest = chats?.first { app.openConversation(latest.id) }
    }

    func open(_ conversationId: String) {
        app.openConversation(conversationId)
    }
}
