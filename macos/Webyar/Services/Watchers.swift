import Foundation
import Observation

/// The operator's own presence, worked out the way the web console does:
/// visitors see them online unless they switched to invisible
/// (`force_offline`) or are outside their schedule; teammates see active /
/// away / disconnected / offline, from being subscribed to the operators
/// channel and from a heartbeat every two minutes saying whether they
/// touched the app.
@MainActor
@Observable
final class PresenceService {
    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private let workspaceId: String
    @ObservationIgnored private var heartbeat: Poller?
    @ObservationIgnored private var team: Poller?
    @ObservationIgnored private var interacted = true
    @ObservationIgnored private var lastWhy = ""

    /// What visitors see, from the server's own rules.
    private(set) var availability: Availability?
    /// What teammates see: active, away, disconnected or offline.
    private(set) var state = PresenceState.offline
    /// Everyone's state by user id, for colleague and assignee avatars.
    private(set) var teamStates: [String: TeamPresence] = [:]

    var isInvisible: Bool { availability?.prefs.forceOffline == true }

    init(app: AppModel, workspaceId: String) {
        self.app = app
        self.workspaceId = workspaceId
    }

    func start() {
        heartbeat = Poller("heartbeat", interval: { 120 }) { [weak self] in try await self?.beat() }
        heartbeat?.start()
        team = Poller("team presence", interval: { 10 }) { [weak self] in try await self?.refresh() }
        team?.start()
    }

    func stop() {
        heartbeat?.stop()
        team?.stop()
    }

    func kick() { team?.kick() }

    /// A key, a click or the window coming forward: the operator is at the desk.
    func noteInteraction() { interacted = true }

    func setInvisible(_ invisible: Bool) async throws {
        availability = try await app.api.setForceOffline(invisible)
        team?.kick()
    }

    /// Why visitors (and so teammates) see this operator offline though they are not
    /// invisible: outside their hours, or a day off in their weekly schedule.
    var offScheduleReason: String? {
        guard !isInvisible, let status = availability?.status, !status.isOnline else { return nil }
        return status.reason == "outside_schedule" || status.reason == "day_disabled" ? status.reason : nil
    }

    func setScheduleEnabled(_ on: Bool) async throws {
        availability = try await app.api.setScheduleEnabled(on)
        team?.kick()
    }

    private func beat() async throws {
        let did = interacted
        interacted = false
        try await app.api.heartbeat(workspaceId: workspaceId, interacted: did)
    }

    private func refresh() async throws {
        do {
            availability = try await app.api.availability(locale: app.strings.language.code)
        } catch let e as ApiError where e.failure != .transport && e.failure != .unauthorized {
            Log.error("availability", e)
        }
        let list = try await app.api.teamPresence(workspaceId: workspaceId)
        var map: [String: TeamPresence] = [:]
        for p in list where map[p.userId] == nil { map[p.userId] = p }
        teamStates = map
        let me = app.user.flatMap { map[$0.id] }
        let next = me?.effective ?? (availability?.status.isOnline == true ? PresenceState.active : PresenceState.offline)
        let why = "reason=\(me?.reason ?? "-") visitors=\(availability?.status.state ?? "-")/\(availability?.status.reason ?? "-") connected=\(me?.connected.map(String.init) ?? "-") listed=\(me != nil)"
        if next != state || why != lastWhy {
            // Why this operator reads as they do, once per change: the server's rules decide it.
            Log.write("[presence] me \(next) \(why)")
            lastWhy = why
        }
        state = next
    }
}

/// Keeps an eye on the call center's waiting line while the app runs, so a
/// call is never missed on another page: the sidebar badge, the in-app
/// ringing banner with the web desk's chime, and a notification when the
/// window is not in front. Realtime carries no call-center events, so this
/// polls at the web desk's own pace.
@MainActor
@Observable
final class CallQueueWatcher {
    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private let workspaceId: String
    @ObservationIgnored private var known = Set<String>()
    @ObservationIgnored private var poller: Poller?
    @ObservationIgnored private var primed = false
    @ObservationIgnored private var disabled = false
    @ObservationIgnored private var polls = 0

    /// The waiting line, newest poll; the call center page reads it too.
    private(set) var queue: [QueueEntry] = []

    /// Called for each call that newly joins the line.
    @ObservationIgnored var onRinging: ((QueueEntry) -> Void)?
    /// Called with the calls under way, every other poll: one a colleague handed to
    /// this operator has left the line long ago, so the line alone never shows it.
    @ObservationIgnored var onActiveCalls: (([CallSession]) -> Void)?

    init(app: AppModel, workspaceId: String) {
        self.app = app
        self.workspaceId = workspaceId
    }

    func start() {
        // The web desk refetches the queue every 5 s; a ring lasts at most 45 s.
        poller = Poller("call queue", interval: { 4 }) { [weak self] in try await self?.poll() }
        poller?.start()
    }

    func stop() { poller?.stop() }
    func kick() { poller?.kick() }

    private func poll() async throws {
        guard !disabled else { return }
        // The desk is off (the plan still loading, or the platform switched calls off):
        // nothing waits, and whatever is waiting when it comes back is learnt, not rung.
        guard app.plan.callCenter else {
            if !queue.isEmpty { queue = [] }
            known = []
            primed = false
            return
        }
        let list: [QueueEntry]
        do {
            list = try await app.api.callQueue(workspaceId: workspaceId)
        } catch let e as ApiError where e.status == 403 || e.status == 404 {
            // No call center on this plan or for this role: stop asking.
            Log.write("[calls] queue unavailable (\(e.status ?? 0)), watcher off")
            disabled = true
            queue = []
            return
        }
        polls += 1
        if polls % 2 == 1, let onActiveCalls {
            // Best-effort: the line is what matters here, so a failure is only logged.
            do { onActiveCalls(try await app.api.activeCalls(workspaceId: workspaceId)) } catch { Log.error("active calls", error) }
        }
        let fresh = list.filter { !known.contains($0.callSessionId) }
        known = Set(list.map(\.callSessionId))
        queue = list
        // The first poll only learns what is already waiting, as the web desk does.
        if primed {
            for f in fresh {
                Log.write("[calls] ringing \(f.callSessionId)")
                onRinging?(f)
            }
            if let first = fresh.first { announce(first) }
        } else {
            Log.write("[calls] watching queue, \(list.count) waiting")
        }
        primed = true
    }

    private func announce(_ entry: QueueEntry) {
        guard app.showsNotifications, !app.isForeground else { return }
        let s = app.strings
        app.notifier.show(title: s["incomingCallTitle"], body: s.get("incomingCallBody", "name", CallNames.caller(entry, s)),
                          silent: true, arguments: ["page": "calls", "call": entry.callSessionId])
    }
}

/// How the desk names a caller: their name, email or phone, else "Visitor · code".
enum CallNames {
    static func caller(_ q: QueueEntry, _ s: Strings) -> String {
        caller(q.callSession, fallbackId: q.contactId ?? q.visitorSessionId ?? q.callSessionId, s)
    }

    static func caller(_ c: CallSession?, fallbackId: String?, _ s: Strings) -> String {
        if let n = c?.visitorName, !n.isEmpty { return n }
        if let e = c?.visitorEmail, !e.isEmpty { return e }
        if let p = c?.visitorPhone, !p.isEmpty { return p }
        return Display.visitorName(name: nil, code: nil, fallbackId: fallbackId, city: nil, region: nil, countryCode: nil, s)
    }
}

/// Keeps an eye on the open queue whether or not the window is showing — it
/// can be closed to the menu bar — and raises a notification for each new
/// visitor message the operator's own preferences allow. Runs at once on
/// every realtime event, otherwise on the platform's poll interval.
@MainActor
final class BackgroundNotifier {
    private unowned let app: AppModel
    private let workspaceId: String
    private var rules = NotificationRules()
    private var poller: Poller?
    private var prefs: NotificationPrefs?
    private var prefsAt = Date.distantPast
    private var token: Signal<InboxEvent>.Token?

    /// Unread visitor messages across the open queue, after every check.
    var onUnread: ((Int) -> Void)?

    init(app: AppModel, workspaceId: String) {
        self.app = app
        self.workspaceId = workspaceId
    }

    func start() {
        poller = Poller("notifier", interval: { [weak self] in self?.app.pollInterval(Double(self?.app.config.pollIntervalSeconds ?? 15)) ?? 15 }) { [weak self] in
            try await self?.tick()
        }
        poller?.start()
        token = app.inboxEvents.subscribe { [weak self] e in if e.isMessage { self?.poller?.kick() } }
    }

    func stop() {
        poller?.stop()
        token?.cancelNow()
    }

    func kick() { poller?.kick() }

    private func tick() async throws {
        let open = try await app.api.conversations(workspaceId: workspaceId, filter: .open)
        onUnread?(open.reduce(0) { $0 + max(0, $1.unreadCount ?? 0) })

        let fresh = rules.fresh(open)
        guard !fresh.isEmpty, app.showsNotifications else { return }
        let prefs = await currentPrefs()
        guard NotificationRules.allowed(prefs) else { return }

        let s = app.strings
        for c in fresh.prefix(3) {
            guard NotificationRules.inScope(prefs, c, me: app.user?.id) else { continue }
            if c.id == app.visibleConversationId && app.isForeground { continue }
            let name = Display.contactName(c.contacts, s, fallbackId: c.contactId ?? c.id)
            let body = prefs.pushPreview ? Display.preview(c.lastMessage, s) : s["newMessage"]
            app.notifier.show(title: s.get("newMessageFrom", "name", name), body: body.isEmpty ? s["newMessage"] : body,
                              silent: !(prefs.playSound && app.settings.notificationSound),
                              arguments: ["conversation": c.id, "workspace": workspaceId])
        }
    }

    private func currentPrefs() async -> NotificationPrefs {
        if let prefs, Date().timeIntervalSince(prefsAt) < 300 { return prefs }
        do {
            prefs = try await app.api.notificationPrefs()
            prefsAt = Date()
        } catch {
            // Keep the last answer rather than going quiet or noisy on a blip.
        }
        return prefs ?? NotificationPrefs()
    }
}

/// What Super Admin shows the desktop app: ads and announcements for the
/// workspace's plan (refreshed every few minutes), and the heartbeat that
/// counts this copy as running and brings broadcasts back.
@MainActor
@Observable
final class EngagementService {
    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private let sessionId = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    @ObservationIgnored private var loops: [Task<Void, Never>] = []

    private(set) var campaigns: [DesktopCampaign] = []
    /// Live broadcasts shown as banners until closed (newest last, at most three).
    var broadcasts: [DesktopBroadcast] = []

    init(app: AppModel) { self.app = app }

    func start() {
        guard loops.isEmpty else { return }
        loops.append(Task { [weak self] in
            while !Task.isCancelled {
                await self?.loadCampaigns()
                try? await Task.sleep(nanoseconds: 300 * 1_000_000_000)
            }
        })
        loops.append(Task { [weak self] in await self?.heartbeatLoop() })
    }

    func stop() {
        loops.forEach { $0.cancel() }
        loops = []
        if app.user != nil {
            let id = sessionId
            Task { try? await app.api.desktopGoodbye(sessionId: id) }
        }
    }

    /// A new workspace or language: fetch again at once.
    func refresh() { Task { await loadCampaigns() } }

    var announcements: [DesktopCampaign] { campaigns.filter { $0.isAnnouncement && !dismissed($0) } }

    /// The ad for a placement (inbox_list, colleagues_list, contacts_list, chat_empty, settings), or nil.
    func ad(for placement: String) -> DesktopCampaign? {
        campaigns.filter { !$0.isAnnouncement && $0.shows(placement) && !dismissed($0) }
            .max { ($0.priority ?? 0) < ($1.priority ?? 0) }
    }

    func dismiss(_ c: DesktopCampaign) {
        guard c.dismissible else { return }
        if !app.settings.dismissedCampaigns.contains(c.id) { app.settings.dismissedCampaigns.append(c.id) }
        if app.settings.dismissedCampaigns.count > 200 { app.settings.dismissedCampaigns.removeFirst(app.settings.dismissedCampaigns.count - 200) }
        app.saveSettings()
    }

    private func dismissed(_ c: DesktopCampaign) -> Bool { c.dismissible && app.settings.dismissedCampaigns.contains(c.id) }

    private func loadCampaigns() async {
        guard let ws = app.workspace, app.user != nil else { campaigns = []; return }
        let list = await app.api.desktopCampaigns(workspaceId: ws.id, locale: app.strings.language.code, platform: "macos")
        if list != campaigns { campaigns = list }
    }

    private func heartbeatLoop() async {
        var interval: Double = 45
        while !Task.isCancelled {
            if app.user != nil {
                do {
                    let seq = app.settings.lastBroadcastSeq
                    let beat = try await app.api.desktopHeartbeat(sessionId: sessionId, workspaceId: app.workspace?.id, version: AppModel.version, afterSeq: seq)
                    if let i = beat.intervalSeconds, i > 10, i < 600 { interval = Double(i) }
                    let fresh = (beat.broadcasts ?? []).sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
                    let latest = fresh.last?.seq ?? beat.latestSeq
                    if let latest, latest != seq {
                        app.settings.lastBroadcastSeq = latest
                        app.saveSettings()
                    }
                    // The first check-in only learns where the queue stands: no replay.
                    if seq != nil { for b in fresh { receive(b) } }
                } catch is CancellationError {
                    return
                } catch {
                    if !error.isTransport { Log.error("heartbeat", error) }
                }
            }
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
    }

    /// A notice Super Admin sent to every open app: a notification and a banner.
    private func receive(_ b: DesktopBroadcast) {
        broadcasts.append(b)
        if broadcasts.count > 3 { broadcasts.removeFirst() }
        if app.showsNotifications {
            app.notifier.show(title: b.title, body: b.body ?? "", silent: !app.settings.notificationSound, arguments: [:])
        }
    }
}
