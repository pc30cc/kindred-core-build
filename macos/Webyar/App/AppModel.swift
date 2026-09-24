import AppKit
import Observation
import SwiftUI

/// A place in the sidebar.
enum Route: Hashable, Sendable {
    case inbox(InboxFilter)
    case channel(String)
    case colleagues
    case contacts
    case visitors
    case calls
    case email

    var isInbox: Bool {
        switch self {
        case .inbox, .channel: return true
        default: return false
        }
    }
}

/// The app's one set of services and its signed-in state: settings, the API,
/// translations, realtime, presence, notifications and updates — the Windows
/// app's `AppHost` and the session half of its `MainWindow`, in one
/// observable object that every view reads from the environment.
@MainActor
@Observable
final class AppModel {
    enum Phase { case launching, signedOut, signedIn }

    static let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"

    // MARK: Services

    var settings: AppSettings
    private(set) var strings: Strings
    @ObservationIgnored let client: ApiClient
    @ObservationIgnored let api: WebyarAPI
    @ObservationIgnored let notifier = Notifier()
    let updates = UpdateService()
    @ObservationIgnored private(set) var engagement: EngagementService!
    private(set) var config = DesktopConfig.defaults

    // MARK: Session

    private(set) var phase: Phase = .launching
    var user: User?
    private(set) var account: Account?
    private(set) var workspaces: [Workspace] = []
    private(set) var workspace: Workspace?
    private(set) var plan = WorkspacePlan.loading
    private(set) var presence: PresenceService?
    private(set) var callQueue: CallQueueWatcher?
    private(set) var realtimeConnected = false
    @ObservationIgnored private(set) var realtime: InboxRealtime?

    /// Every realtime event.
    @ObservationIgnored let inboxEvents = Signal<InboxEvent>()
    /// Every nudge on the visitors channel.
    @ObservationIgnored let visitorEvents = Signal<JSONValue>()

    // MARK: Shell state

    var route: Route = .inbox(.open)
    /// A conversation to open once the inbox shows it (from a notification, a contact, a visitor).
    var pendingConversation: String?
    /// The conversation on screen right now.
    var visibleConversationId: String?
    /// The call center should select (or answer) this call when it appears.
    var pendingCall: (id: String, answer: Bool)?
    private(set) var isForeground = true
    /// SwiftUI's openSettings, handed over by the window (macOS 14 has no selector for it).
    @ObservationIgnored var showSettings: (() -> Void)?

    private(set) var unread = 0
    private(set) var counts = SidebarCounts()
    private(set) var channels: [String] = []
    var visitorsOnline = 0
    private(set) var notificationsBlocked = false

    /// The call ringing in the banner, if any.
    private(set) var ringing: QueueEntry?
    @ObservationIgnored private var ringSince = Date()
    @ObservationIgnored private var ringTimer: Timer?
    /// The server treats a 45 s ring as missed.
    private let ringFor: TimeInterval = 45

    @ObservationIgnored private var countsPoller: Poller?
    @ObservationIgnored private var planPoller: Poller?
    @ObservationIgnored private var platformTimer: Timer?
    @ObservationIgnored private var background: BackgroundNotifier?
    @ObservationIgnored private var channelsLoaded = false

    init() {
        let settings = AppSettings.load()
        self.settings = settings
        strings = Strings(settings.resolvedLanguage)
        Typeface.persian = settings.resolvedLanguage == .fa
        let origin = settings.apiOrigin.flatMap(URL.init(string:))
        #if DEBUG
        if DebugTools.sample {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [SampleBackend.self]
            client = ApiClient(store: MemorySessionStore("sample"), origin: origin, appVersion: Self.version, session: URLSession(configuration: config))
        } else {
            client = ApiClient(store: KeychainSessionStore(), origin: origin, appVersion: Self.version)
        }
        #else
        client = ApiClient(store: KeychainSessionStore(), origin: origin, appVersion: Self.version)
        #endif
        api = WebyarAPI(client: client)
        AttachmentStore.shared.api = api
        engagement = EngagementService(app: self)
        client.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.signedOut() }
        }
        notifier.onOpen = { [weak self] args in self?.open(from: args) }
    }

    // MARK: Launch

    func start() async {
        notifier.register()
        FileCache.trim()
        Log.write("launch \(Self.version)")
        await refreshPlatform()
        platformTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
            Task { await self?.refreshPlatform() }
        }
        guard client.hasSession else {
            phase = .signedOut
            return
        }
        do {
            user = try await api.currentUser()
            await enter()
        } catch let e as ApiError where e.failure == .unauthorized {
            phase = .signedOut
        } catch {
            // Offline at launch: keep the session and show the shell, which retries on its own.
            Log.error("restore session", error)
            await enter()
        }
    }

    /// Asks the platform where it lives and what it wants of desktop apps; keeps the last good answers.
    func refreshPlatform() async {
        await client.refreshOrigin()
        let origin = client.origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if settings.apiOrigin != origin {
            settings.apiOrigin = origin
            saveSettings()
        }
        if let c = await DesktopConfig.fetch(client) { config = c }
        updates.configure(config.update)
    }

    func signIn(email: String, password: String, remember: Bool) async throws {
        user = try await client.login(email: email, password: password)
        if remember { SavedLogin.write(email: email, password: password) } else { SavedLogin.forget() }
        await enter()
    }

    /// After a sign-in or a restored session: pick the workspace and open the shell.
    func enter() async {
        do {
            workspaces = try await api.workspaces()
            Log.write("workspaces: \(workspaces.count)")
        } catch let e as ApiError where e.failure != .unauthorized {
            Log.error("workspaces", e)
        } catch {
            return
        }
        workspace = workspaces.first { $0.id == settings.workspaceId } ?? workspaces.first
            ?? settings.workspaceId.map { Workspace(id: $0, name: "") }
        if let ws = workspace, ws.id != settings.workspaceId {
            settings.workspaceId = ws.id
            saveSettings()
        }
        await openWorkspace()
    }

    /// Starts the chosen workspace: its plan first (briefly, so the sidebar does
    /// not show and then hide sections), then realtime, presence and the shell.
    private func openWorkspace() async {
        resetPlan()
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadPlan() }
            group.addTask { try? await Task.sleep(nanoseconds: 5_000_000_000) }
            await group.next()
            group.cancelAll()
        }
        startRealtime()
        await startPresence()
        startShell()
        phase = .signedIn
        engagement.start()
        engagement.refresh()
    }

    /// Moves to another of the operator's workspaces, as the web's workspace menu does.
    func switchWorkspace(_ ws: Workspace) async {
        guard ws.id != workspace?.id else { return }
        stopShell()
        stopPresence()
        workspace = ws
        settings.workspaceId = ws.id
        saveSettings()
        unread = 0
        notifier.setBadge(0)
        route = .inbox(.open)
        phase = .launching
        await openWorkspace()
    }

    /// Opening the workspace menu: bring the list up to date while it shows.
    func refreshWorkspaces() async {
        guard let fresh = try? await api.workspaces(), !fresh.isEmpty else { return }
        if fresh.map(\.id) != workspaces.map(\.id) || fresh != workspaces { workspaces = fresh }
    }

    #if DEBUG
    func debugSignOut() { client.discardSession(); signedOut() }
    #endif

    func signOut() async {
        do {
            try await client.logout()
        } catch {
            // Offline: forget the session here anyway; the server lets it lapse.
            Log.error("logout", error)
            client.discardSession()
        }
        signedOut()
    }

    /// The server no longer knows this session (or the operator signed out).
    func signedOut() {
        guard phase != .signedOut else { return }
        stopShell()
        stopPresence()
        realtime?.stop()
        realtime = nil
        realtimeConnected = false
        engagement.stop()
        user = nil
        account = nil
        unread = 0
        notifier.setBadge(0)
        route = .inbox(.open)
        phase = .signedOut
    }

    // MARK: Plan

    private func resetPlan() {
        plan = .loading
        members = nil
        profiles = [:]
        channelsLoaded = false
        channels = []
        counts = SidebarCounts()
    }

    /// Fetches the plan again. The super admin can switch a feature at any
    /// time; a failure keeps the last good snapshot, and only a first failure
    /// falls back to "show all".
    func loadPlan() async {
        guard let ws = workspace else { return }
        let next: WorkspacePlan
        do {
            next = try await api.plan(workspaceId: ws.id)
        } catch let e as ApiError where e.failure != .unauthorized {
            Log.error("plan", e)
            if plan.state == .loaded { return }
            next = .failed
        } catch {
            return
        }
        guard workspace?.id == ws.id else { return }
        plan = next
        // If the page on show just went away, back to the inbox.
        if !isAllowed(route) { route = .inbox(.open) }
    }

    func isAllowed(_ r: Route) -> Bool {
        switch r {
        case .contacts: return plan.contacts
        case .visitors: return plan.visitors
        case .calls: return plan.callCenter
        case .email: return plan.emailInbox
        case .colleagues: return plan.teamChat
        case .channel: return plan.isAdmin
        case .inbox(.ai): return plan.aiQueue(automated: counts.automated)
        case .inbox(.needsHuman): return plan.needsHumanQueue
        case .inbox: return true
        }
    }

    // MARK: Realtime, presence

    func pollInterval(_ normal: TimeInterval) -> TimeInterval {
        realtimeConnected ? TimeInterval(config.pollWithRealtimeSeconds) : normal
    }

    /// The platform's normal list poll, relaxed while realtime is up.
    var listInterval: TimeInterval { pollInterval(TimeInterval(config.pollIntervalSeconds)) }

    private func startRealtime() {
        realtime?.stop()
        realtime = nil
        realtimeConnected = false
        guard let ws = workspace else { return }
        let rt = InboxRealtime(api: api, workspaceId: ws.id, allowed: { [weak self] in self?.config.realtimeEnabled ?? false })
        rt.onEvent = { [weak self] e in self?.inboxEvents.send(e) }
        rt.onVisitorEvent = { [weak self] v in self?.visitorEvents.send(v) }
        rt.onConnectionChanged = { [weak self] up in self?.realtimeConnected = up }
        rt.onPresenceJoined = { [weak self] in self?.presence?.kick() }
        realtime = rt
        rt.start()
    }

    private func startPresence() async {
        stopPresence()
        do {
            account = try await api.account()
        } catch {
            Log.error("account", error)
        }
        guard let ws = workspace else { return }
        let p = PresenceService(app: self, workspaceId: ws.id)
        presence = p
        p.start()
        let q = CallQueueWatcher(app: self, workspaceId: ws.id)
        q.onRinging = { [weak self] entry in self?.ring(entry) }
        callQueue = q
        q.start()
    }

    private func stopPresence() {
        presence?.stop()
        presence = nil
        callQueue?.stop()
        callQueue = nil
        stopRinging()
    }

    // MARK: Shell pollers

    private func startShell() {
        guard let ws = workspace else { return }
        countsPoller = Poller("sidebar counts", interval: { 15 }) { [weak self] in try await self?.loadSidebar(ws.id) }
        countsPoller?.start()
        // The super admin can change the plan at any time; pick it up without a restart.
        planPoller = Poller("plan", interval: { 180 }) { [weak self] in
            try await Task.sleep(nanoseconds: 180 * 1_000_000_000)
            await self?.loadPlan()
        }
        planPoller?.start()
        let bg = BackgroundNotifier(app: self, workspaceId: ws.id)
        bg.onUnread = { [weak self] n in
            self?.unread = n
            self?.notifier.setBadge(n)
        }
        background = bg
        bg.start()
        Task { await refreshNotificationPermission() }
    }

    private func stopShell() {
        countsPoller?.stop()
        countsPoller = nil
        planPoller?.stop()
        planPoller = nil
        background?.stop()
        background = nil
    }

    private func loadSidebar(_ workspaceId: String) async throws {
        counts = try await api.sidebarCounts(workspaceId: workspaceId)
        // "Other inboxes" is for owners and admins only, as on the web.
        guard !channelsLoaded, plan.isAdmin else { return }
        channelsLoaded = true
        do {
            channels = try await api.pluginInboxes(workspaceId: workspaceId)
        } catch let e as ApiError where [401, 403, 404].contains(e.status ?? 0) {
            // Everyone else simply has no "Other inboxes".
        }
    }

    func kickBackground() { background?.kick() }

    // MARK: Opening things

    /// Opens a conversation in the inbox, from anywhere.
    func openConversation(_ id: String) {
        pendingConversation = id
        if !route.isInbox { route = .inbox(.open) }
    }

    /// Shows a section by name: inbox, contacts, visitors, calls, colleagues.
    func openPage(_ page: String?) {
        switch page {
        case "contacts": route = .contacts
        case "visitors": route = .visitors
        case "calls": route = .calls
        case "colleagues": route = .colleagues
        case "email": route = .email
        case "settings": showSettings?()
        default: route = .inbox(.open)
        }
    }

    func openCall(_ id: String, answer: Bool) {
        if ringing?.callSessionId == id { stopRinging() }
        pendingCall = (id, answer)
        route = .calls
    }

    /// A notification was clicked.
    func open(from args: [String: String]) {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first { $0.identifier?.rawValue.hasPrefix("main") == true || $0.isMainWindow }?.makeKeyAndOrderFront(nil)
        if let conversation = args["conversation"] {
            openConversation(conversation)
        } else if args["page"] == "calls", let call = args["call"] {
            openCall(call, answer: false)
        } else if let page = args["page"] {
            openPage(page)
        }
    }

    // MARK: Incoming call banner

    private func ring(_ entry: QueueEntry) {
        guard ringing == nil else { return }
        ringing = entry
        ringSince = Date()
        if settings.notificationSound { Chime.play() }
        ringTimer?.invalidate()
        ringTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] t in
            Task { @MainActor in
                guard let self else { t.invalidate(); return }
                // Keep ringing like a phone until someone acts, then fall silent but leave the banner up.
                if self.ringing == nil || Date().timeIntervalSince(self.ringSince) > self.ringFor { t.invalidate(); return }
                if self.settings.notificationSound && !CallCoordinator.shared.isBusy { Chime.play() }
            }
        }
    }

    /// The caller hung up, or a colleague answered: the banner goes with the call.
    func syncRinging() {
        guard let r = ringing, let q = callQueue else { return }
        if !q.queue.contains(where: { $0.callSessionId == r.callSessionId }) {
            stopRinging()
            let now = Date()
            if let next = q.queue.first(where: { $0.createdAt.map { now.timeIntervalSince($0) < ringFor } ?? false }) { ring(next) }
        }
    }

    #if DEBUG
    /// A sample call in the banner, for DebugTools.
    func debugRing() {
        ring(QueueEntry(id: "q-debug", callSessionId: "cs-debug", channel: "voice", createdAt: Date(),
                        callSession: CallSession(id: "cs-debug", callType: "voice", visitorName: "Ayşe Yılmaz", visitorEmail: "ayse@example.com.tr", pageTitle: "Pricing — Webyar")))
    }
    #endif

    func stopRinging() {
        ringTimer?.invalidate()
        ringTimer = nil
        ringing = nil
    }

    func rejectRinging() async {
        guard let entry = ringing, let ws = workspace else { return }
        ringTimer?.invalidate()
        do {
            try await api.rejectCall(workspaceId: ws.id, callId: entry.callSessionId)
        } catch {
            Log.error("reject call", error)
        }
        stopRinging()
        callQueue?.kick()
    }

    // MARK: Window

    func setForeground(_ on: Bool) {
        isForeground = on
        if on { presence?.noteInteraction() }
    }

    func noteInteraction() { presence?.noteInteraction() }

    // MARK: Settings

    func saveSettings() { settings.save() }

    func setLanguage(_ language: Language) {
        settings.language = language.code
        saveSettings()
        strings = Strings(language)
        Typeface.persian = language == .fa
        engagement.refresh()
        background?.kick()
    }

    func setAppearance(_ appearance: Appearance) {
        settings.appearance = appearance
        saveSettings()
        applyAppearance()
    }

    func applyAppearance() {
        switch settings.appearance {
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        case .system: NSApp.appearance = nil
        }
    }

    // MARK: People

    @ObservationIgnored private var members: [WorkspaceMember]?
    @ObservationIgnored private var membersAt = Date.distantPast
    @ObservationIgnored private var membersLoading = false
    /// Bumped when the member list arrives, so names drawn from it refresh.
    private(set) var membersVersion = 0

    /// The workspace's people, cached for ten minutes: names for "assigned to" and the transfer menu.
    func loadMembers() async throws -> [WorkspaceMember] {
        guard let ws = workspace else { return [] }
        if let members, Date().timeIntervalSince(membersAt) < 600 { return members }
        let list = try await api.members(workspaceId: ws.id)
        guard workspace?.id == ws.id else { return list }
        members = list
        membersAt = Date()
        membersVersion += 1
        return list
    }

    /// A colleague's name from the cache, or empty when it is not loaded yet.
    func memberName(_ userId: String) -> String {
        _ = membersVersion
        if members == nil, workspace != nil, !membersLoading {
            membersLoading = true
            Task {
                _ = try? await loadMembers()
                membersLoading = false
            }
        }
        return members?.first { $0.userId == userId }?.displayName ?? ""
    }

    /// Who "assigned to" names: nobody, you, or a colleague.
    func assigneeName(_ userId: String?, youKey: String = "assignedToYou") -> String {
        guard let userId else { return strings["unassigned"] }
        if userId == user?.id { return strings[youKey] }
        return memberName(userId)
    }

    @ObservationIgnored private var profiles: [String: VisitorProfile] = [:]
    @ObservationIgnored private var profilesAt = Date.distantPast

    /// Adds each visitor's OS, country and city to a page of conversations,
    /// as the web inbox does (one batched call). Known profiles are reused;
    /// the whole set is refreshed every two minutes.
    func withVisitorProfiles(_ list: [Conversation]) async -> [Conversation] {
        guard let ws = workspace, !list.isEmpty else { return list }
        let stale = Date().timeIntervalSince(profilesAt) > 120
        let wanted = list.map(\.id).filter { stale || profiles[$0] == nil }
        if !wanted.isEmpty {
            let got = await api.visitorProfiles(workspaceId: ws.id, conversationIds: wanted)
            profiles.merge(got) { _, b in b }
            if stale { profilesAt = Date() }
        }
        return list.map { c in
            guard let p = profiles[c.id] else { return c }
            var c = c
            c.visitorOs = p.device?.os
            c.visitorDevice = p.device?.device
            c.visitorCountryCode = p.geo?.countryCode
            c.visitorCountryName = p.geo?.country
            c.visitorCity = p.geo?.city
            c.visitorRegion = p.geo?.region
            return c
        }
    }

    // MARK: Me

    var myName: String {
        if let n = account?.profile?.fullName, !n.isEmpty { return n }
        if let n = user?.fullName, !n.isEmpty { return n }
        return user?.email ?? strings["account"]
    }

    var myState: String { presence?.state ?? PresenceState.offline }

    func presenceLabel(_ state: String) -> String {
        switch state {
        case PresenceState.active: return strings["presenceActive"]
        case PresenceState.away: return strings["presenceAway"]
        case PresenceState.disconnected: return strings["presenceDisconnected"]
        default: return strings["presenceOffline"]
        }
    }

    func setInvisible(_ invisible: Bool) async -> String? {
        guard let presence, presence.isInvisible != invisible else { return nil }
        do {
            try await presence.setInvisible(invisible)
            return nil
        } catch {
            Log.error("set status", error)
            return ErrorText.of(error, strings)
        }
    }

    func refreshNotificationPermission() async {
        let allowed = await notifier.refreshAuthorization()
        notificationsBlocked = settings.notifications && !allowed
    }
}
