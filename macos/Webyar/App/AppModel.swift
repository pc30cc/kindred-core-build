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
    /// Super Admin → macOS app: the last answer kept on this Mac until the platform is asked again.
    private(set) var config = (AppModel.isSample ? nil : MacAppConfig.cached()) ?? .defaults
    /// The platform is being asked right now (the maintenance card's "Try again").
    private(set) var checkingPlatform = false

    // MARK: Session

    private(set) var phase: Phase = .launching
    var user: User?
    private(set) var account: Account?
    private(set) var workspaces: [Workspace] = []
    private(set) var workspace: Workspace?
    /// The workspace's plan as the server sent it.
    private(set) var workspacePlan = WorkspacePlan.loading
    /// What this operator may see: the plan, less what the platform switched off for the Mac app.
    var plan: WorkspacePlan { workspacePlan }
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
    /// A call a colleague handed to this operator, waiting for them to join it.
    private(set) var handedCall: CallSession?
    private(set) var joiningHandedCall = false
    private(set) var handedCallError: String?
    @ObservationIgnored private var handedSeen = Set<String>()
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
        // No permission prompt for notifications the platform does not allow.
        notifier.register(askPermission: config.system.notifications)
        FileCache.trim()
        Log.write("launch \(Self.version)")
        await refreshPlatform()
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

    /// Asks the platform where it lives and what it wants of the Mac app; keeps the last good answers.
    func refreshPlatform() async {
        checkingPlatform = true
        defer { checkingPlatform = false }
        await client.refreshOrigin()
        let origin = client.origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if settings.apiOrigin != origin {
            settings.apiOrigin = origin
            saveSettings()
        }
        if let fetched = await MacAppConfig.fetch(client) {
            // Sample mode shares this Mac's defaults with the real app: keep nothing of its make-believe platform.
            if !Self.isSample { MacAppConfig.remember(fetched.raw) }
            applyPlatform(fetched.config, live: true)
            applyFirstLaunchDefaults()
        } else {
            applyPlatform(config, live: false)
        }
        schedulePlatformRefresh()
    }

    /// `live`: the platform answered just now, rather than this being the answer remembered from before.
    private func applyPlatform(_ next: MacAppConfig, live: Bool) {
        if next != config { config = next }
        updates.configure(config.update, live: live)
        applySystemIntegration()
        // A section the platform just switched off: back to the inbox, and no ringing for a desk that is gone.
        if !isAllowed(route) { route = .inbox(.open) }
        if !plan.callCenter { stopRinging() }
    }

    /// Hourly; every minute while maintenance is on, so the notice clears promptly.
    private func schedulePlatformRefresh() {
        let every: TimeInterval = config.maintenance.enabled ? 60 : 3600
        if let t = platformTimer, t.isValid, t.timeInterval == every { return }
        platformTimer?.invalidate()
        platformTimer = Timer.scheduledTimer(withTimeInterval: every, repeats: true) { [weak self] _ in
            Task { await self?.refreshPlatform() }
        }
    }

    /// What the platform lets the app do on this Mac, applied to what is already there.
    private func applySystemIntegration() {
        let system = config.system
        updateBadge()
        if system.notifications {
            if !notifier.asked { notifier.register() }
        } else {
            notifier.clearDelivered()
            notificationsBlocked = false
        }
        // Not allowed to open at login: take back a login item registered earlier.
        if !system.launchAtLogin, !Self.isSample, LoginItem.isEnabled { LoginItem.set(false) }
    }

    /// Super Admin's defaults for a first launch: once, from the platform's
    /// first answer, and only on a Mac with no saved settings of its own.
    private func applyFirstLaunchDefaults() {
        guard !settings.platformDefaultsApplied else { return }
        let first = config.firstLaunch
        settings.platformDefaultsApplied = true
        settings.appearance = first.appearance
        settings.closeToMenuBar = first.closeToMenuBar
        saveSettings()
        applyAppearance()
        // "system" leaves the language to follow the Mac, as it already does.
        if let language = first.language, language != strings.language { setLanguage(language) }
        if first.launchAtLogin, config.system.launchAtLogin, !Self.isSample, !LoginItem.isEnabled { LoginItem.set(true) }
        Log.write("first-launch defaults applied")
    }

    /// Sample mode shares this Mac's login items and defaults with the real app: leave them alone there.
    static var isSample: Bool {
        #if DEBUG
        return DebugTools.sample
        #else
        return false
        #endif
    }

    // MARK: Platform switches

    /// Closing the window keeps the app running: the operator's choice, when there is a menu bar item to run in.
    var closesToMenuBar: Bool { config.system.menuBarExtra && settings.closeToMenuBar }

    var showsMenuBarItem: Bool { config.system.menuBarExtra && settings.menuBarItem }

    /// Mac notifications: the operator's choice, when the platform allows them at all.
    var showsNotifications: Bool { config.system.notifications && settings.notifications }

    /// The Dock badge follows the unread count, unless the platform turned it off.
    func updateBadge() {
        notifier.setBadge(config.system.dockBadge ? unread : 0)
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
        updateBadge()
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
        updateBadge()
        route = .inbox(.open)
        phase = .signedOut
    }

    // MARK: Plan

    private func resetPlan() {
        workspacePlan = .loading
        members = nil
        profiles = [:]
        sessionProfiles = [:]
        sessionProfilesAsked = []
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
            if workspacePlan.state == .loaded { return }
            next = .failed
        } catch {
            return
        }
        guard workspace?.id == ws.id else { return }
        workspacePlan = next
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
        q.onActiveCalls = { [weak self] calls in self?.noticeHandedCalls(calls) }
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
            self?.updateBadge()
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
        // No desk, no calls: nothing to ring for.
        guard ringing == nil, plan.callCenter else { return }
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

    // MARK: Calls handed over by a colleague

    /// A transfer leaves the call assigned to this operator and live, with the colleague
    /// still in the room until this operator joins; the banner offers to join it.
    private func noticeHandedCalls(_ calls: [CallSession]) {
        guard let me = user?.id else { return }
        let mine = calls.filter { c in
            c.assignedAgentId == me && c.transferFromAgentId != nil && c.transferFromAgentId != me
                && CallCoordinator.shared.activeCallId != c.id
        }
        // Over, or joined from somewhere else: the banner goes.
        if let h = handedCall, !mine.contains(where: { $0.id == h.id }) {
            handedCall = nil
            handedCallError = nil
        }
        guard handedCall == nil, let fresh = mine.first(where: { !handedSeen.contains($0.id) }) else { return }
        handedSeen.insert(fresh.id)
        Log.write("[calls] handed over \(fresh.id)")
        handedCall = fresh
        handedCallError = nil
        if settings.notificationSound { Chime.play() }
        if showsNotifications, !isForeground {
            let from = fresh.transferFromAgentId.map { memberName($0) } ?? ""
            notifier.show(title: strings["callHandedTitle"], body: from.isEmpty ? CallNames.caller(fresh, fallbackId: fresh.id, strings) : strings.get("callHandedFrom", "name", from),
                          silent: true, arguments: ["page": "calls"])
        }
    }

    /// Joins the handed-over call: the desk's accept gives this operator a token for the same room.
    func joinHandedCall() async {
        guard let c = handedCall, let ws = workspace, !joiningHandedCall else { return }
        if CallCoordinator.shared.isBusy {
            handedCallError = strings["ccOnCall"]
            return
        }
        joiningHandedCall = true
        handedCallError = nil
        defer { joiningHandedCall = false }
        do {
            let accept = try await api.acceptCall(workspaceId: ws.id, callId: c.id)
            guard accept.connect?.supported == true else {
                handedCallError = strings["ccAcceptedNoMediaHint"]
                return
            }
            handedCall = nil
            CallCoordinator.shared.joinAccepted(app: self, accept: accept, call: c, callId: c.id)
        } catch {
            Log.error("join handed call", error)
            handedCallError = ErrorText.of(error, strings)
        }
    }

    func dismissHandedCall() {
        handedCall = nil
        handedCallError = nil
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
        // A choice of the operator's own: the platform's first-launch default no longer applies.
        settings.platformDefaultsApplied = true
        saveSettings()
        Self.forgetSplitFrames()
        strings = Strings(language)
        Typeface.persian = language == .fa
        engagement.refresh()
        background?.kick()
    }

    /// Column frames AppKit saved for the split view. Forgotten at launch and
    /// before the shell is rebuilt for another language: frames saved in one
    /// direction lay the columns out wrongly in the other.
    static func forgetSplitFrames() {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("NSSplitView Subview Frames") {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    func setAppearance(_ appearance: Appearance) {
        settings.appearance = appearance
        settings.platformDefaultsApplied = true
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

    // MARK: Callers' devices

    /// A caller's OS and country by visitor session, for the call center's faces;
    /// a session in `sessionProfilesAsked` but not here has none to give.
    private(set) var sessionProfiles: [String: VisitorProfile] = [:]
    private(set) var sessionProfilesAsked: Set<String> = []
    @ObservationIgnored private var sessionProfilesWanted: Set<String> = []
    @ObservationIgnored private var sessionProfilesTask: Task<Void, Never>?

    /// Asks for a caller's device once; the faces on screen in the same moment go in one call, as the web desk does.
    func wantSessionProfile(_ sessionId: String?) {
        guard let id = sessionId, !id.isEmpty, !sessionProfilesAsked.contains(id) else { return }
        sessionProfilesWanted.insert(id)
        guard sessionProfilesTask == nil else { return }
        sessionProfilesTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            await self?.loadSessionProfiles()
        }
    }

    private func loadSessionProfiles() async {
        defer { sessionProfilesTask = nil }
        let ids = Array(sessionProfilesWanted)
        sessionProfilesWanted = []
        guard let ws = workspace, !ids.isEmpty else { return }
        let got = await api.sessionProfiles(workspaceId: ws.id, sessionIds: ids)
        sessionProfiles.merge(got) { _, b in b }
        sessionProfilesAsked.formUnion(ids)
        // Asked for while this batch was out.
        if !sessionProfilesWanted.isEmpty {
            sessionProfilesTask = Task { [weak self] in await self?.loadSessionProfiles() }
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

    /// The operator's state as a line: the state, and why when the schedule keeps them offline.
    var myStatusLine: String {
        var parts = [presenceLabel(myState)]
        if let reason = presence?.offScheduleReason {
            parts.append(strings[reason == "day_disabled" ? "presenceDayOff" : "presenceOutsideSchedule"])
        } else if presence?.isInvisible == true {
            parts.append(strings["statusInvisible"])
        }
        return parts.joined(separator: " · ")
    }

    /// Turns the weekly schedule off, so visitors see the operator whenever they are not invisible.
    func turnScheduleOff() async -> String? {
        guard let presence else { return nil }
        do {
            try await presence.setScheduleEnabled(false)
            return nil
        } catch {
            Log.error("schedule off", error)
            return ErrorText.of(error, strings)
        }
    }

    func refreshNotificationPermission() async {
        let allowed = await notifier.refreshAuthorization()
        notificationsBlocked = showsNotifications && !allowed
    }
}
