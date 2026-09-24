import Foundation
import Observation
import SwiftUI

/// The web console's call center "Live Desk" (the Windows app's
/// CallCenterPage): the waiting line with live wait clocks and SLA colours,
/// one-click answer or decline, the caller's context, the call's timeline,
/// earlier calls and notes, plus the call log. Answering hands the room to
/// the in-call window straight away.
@MainActor
@Observable
final class CallCenterModel {
    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var overviewPoller: Poller?
    @ObservationIgnored private var detailPoller: Poller?
    @ObservationIgnored private var clockTask: Task<Void, Never>?
    @ObservationIgnored private var viewers = 0
    @ObservationIgnored private var lastActiveCallId: String?

    // MARK: Desk state

    /// The call log instead of the waiting line.
    private(set) var showHistory = false
    /// "all", "voice" or "video".
    var channel = "all"
    /// Newest first instead of priority, then longest waiting.
    private(set) var newestFirst = false
    var search = ""

    /// The clock the wait timers read; it moves every second while the page is on screen.
    private(set) var now = Date()
    private(set) var overview: CallCenterOverview?
    /// "available", "away", or nil when neither (the menu then asks to set it).
    private(set) var availability: String?

    /// The call log, and the pool earlier calls from the same visitor are found in.
    private(set) var recent: [CallSession] = []
    private(set) var historyLoaded = false
    private(set) var historyLoading = false

    // MARK: The call picked

    private(set) var selectedId: String?
    private(set) var selectedCall: CallSession?
    @ObservationIgnored private var selectedEntry: QueueEntry?
    private(set) var events: [CallEvent]?
    private(set) var notes: [CallNote]?
    private(set) var previous: [CallSession]?
    private(set) var previousLoading = false
    /// The call this operator answered from here and has not hung up yet.
    private(set) var onCallId: String?

    private(set) var accepting = false
    private(set) var rejecting = false
    private(set) var ending = false
    private(set) var addingNote = false
    var noteDraft = ""
    var notice: CallDeskNotice?
    /// Bumped to move the keyboard into the notes box (wrap-up).
    private(set) var focusNoteRequest = 0
    /// Bumped with the call to scroll the list to.
    private(set) var scrollRequest: String?

    #if DEBUG
    /// The call center on screen, for the debug command file.
    nonisolated(unsafe) static weak var debugCurrent: CallCenterModel?
    /// As if the in-call window had just hung up the call picked.
    func debugDeskCallEnded() { if let id = selectedId { deskCallEnded(id) } }
    #endif

    init(app: AppModel) {
        #if DEBUG
        defer { Self.debugCurrent = self }
        #endif
        self.app = app
    }

    // MARK: Lifecycle

    /// A view of the page came on screen; the first one starts the desk.
    func appear() {
        viewers += 1
        start()
    }

    /// A view of the page went away; the desk stops when none is left.
    func disappear() {
        viewers = max(0, viewers - 1)
        if viewers == 0 { stop() }
    }

    private func start() {
        guard overviewPoller == nil else { return }
        app.callQueue?.kick()
        // Call-center state has no realtime feed to the app, so poll at the web desk's pace always.
        overviewPoller = Poller("call overview", interval: { 5 }) { [weak self] in try await self?.loadOverview() }
        overviewPoller?.start()
        now = Date()
        lastActiveCallId = CallCoordinator.shared.activeCallId
        clockTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.tick()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        if let id = selectedId { startDetailPolling(id) }
        Task { await loadAvailability() }
    }

    func stop() {
        viewers = 0
        overviewPoller?.stop()
        overviewPoller = nil
        detailPoller?.stop()
        detailPoller = nil
        clockTask?.cancel()
        clockTask = nil
    }

    func refresh() {
        app.callQueue?.kick()
        overviewPoller?.kick()
        detailPoller?.kick()
    }

    /// Every second: the wait clocks, the longest wait and the SLA count; and
    /// whether the in-call window has just hung up a call answered here.
    private func tick() {
        now = Date()
        let active: String? = CallCoordinator.shared.activeCallId
        if let last = lastActiveCallId, active != last { deskCallEnded(last) }
        lastActiveCallId = active
    }

    // MARK: The waiting line

    /// The line in rank order: priority first, then who came first.
    var ranked: [CallDeskItem] {
        let s = app.strings
        let entries = app.callQueue?.queue ?? []
        let ordered = entries.sorted { a, b in
            let pa = a.priority ?? 0, pb = b.priority ?? 0
            if pa != pb { return pa > pb }
            return (a.createdAt ?? .distantFuture) < (b.createdAt ?? .distantFuture)
        }
        var out: [CallDeskItem] = []
        for (i, e) in ordered.enumerated() {
            out.append(CallDeskItem(entry: e, rank: i + 1, name: CallNames.caller(e, s)))
        }
        return out
    }

    /// The line on show: narrowed by the search box and the channel, in the order picked.
    var visibleQueue: [CallDeskItem] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let list = ranked.filter { $0.matches(q, channel) }
        let fallback = Date()
        if newestFirst {
            return list.sorted { $0.since(fallback) > $1.since(fallback) }
        }
        return list.sorted { a, b in
            let pa = a.entry.priority ?? 0, pb = b.entry.priority ?? 0
            if pa != pb { return pa > pb }
            return a.since(fallback) < b.since(fallback)
        }
    }

    var waitingCount: Int { app.callQueue?.queue.count ?? 0 }

    func queueItem(_ id: String) -> CallDeskItem? {
        ranked.first { $0.id == id }
    }

    func isQueued(_ id: String) -> Bool {
        app.callQueue?.queue.contains { $0.callSessionId == id } ?? false
    }

    /// The longest wait in the line, in seconds.
    var longestWait: TimeInterval {
        (app.callQueue?.queue ?? []).map { now.timeIntervalSince(CallDeskItem.since($0, now)) }.max() ?? 0
    }

    /// Calls waiting longer than the web desk's three-minute SLA.
    var slaBreached: Int {
        (app.callQueue?.queue ?? []).filter { now.timeIntervalSince(CallDeskItem.since($0, now)) > 180 }.count
    }

    // MARK: The call log

    /// The log on show, narrowed by the search box (name, email, phone) and the channel.
    var visibleHistory: [CallSession] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return recent.filter { c in
            let text = q.isEmpty || [c.visitorName, c.visitorEmail, c.visitorPhone].contains { $0?.localizedCaseInsensitiveContains(q) == true }
            let kind = channel == "all" || (channel == "video") == c.isVideo
            return text && kind
        }
    }

    // MARK: Tabs, sort

    func setShowHistory(_ on: Bool) {
        guard on != showHistory else { return }
        showHistory = on
        if on { Task { await reloadHistory() } }
    }

    func toggleSort() {
        newestFirst.toggle()
    }

    // MARK: Loading

    private func loadOverview() async throws {
        guard let ws = app.workspace else { return }
        overview = try await app.api.callOverview(workspaceId: ws.id)
        if showHistory { try await loadHistory() }
    }

    private func loadHistory() async throws {
        guard let ws = app.workspace else { return }
        recent = try await app.api.callHistory(workspaceId: ws.id, limit: 50)
        historyLoaded = true
    }

    private func reloadHistory() async {
        historyLoading = true
        defer { historyLoading = false }
        do {
            try await loadHistory()
        } catch {
            Log.error("call history", error)
        }
    }

    /// Service state for the masthead chip; nil until the first overview.
    var serviceReady: Bool? {
        guard let overview else { return nil }
        return overview.provider?.ready != false
    }

    // MARK: My availability for calls

    private func loadAvailability() async {
        guard let ws = app.workspace else { return }
        do {
            let agents = try await app.api.agentCallStatuses(workspaceId: ws.id)
            let mine = agents.first { $0.userId == app.user?.id }?.status ?? "offline"
            availability = (mine == "available" || mine == "away") ? mine : nil
        } catch {
            Log.error("agent status", error)
        }
    }

    func setAvailability(_ status: String) {
        guard let ws = app.workspace, status != availability else { return }
        availability = status
        Task {
            do {
                try await app.api.setAgentCallStatus(workspaceId: ws.id, status: status)
            } catch {
                Log.error("set agent status", error)
                showNotice(ErrorText.of(error, app.strings))
                await loadAvailability()
            }
        }
    }

    // MARK: Selection

    /// A row was picked in whichever list is on show.
    func select(_ id: String?) {
        guard let id, id != selectedId else { return }
        if showHistory {
            guard let c = recent.first(where: { $0.id == id }) else { return }
            open(id: id, call: c, entry: nil)
        } else {
            guard let item = queueItem(id) else { return }
            open(id: id, call: item.entry.callSession, entry: item.entry)
        }
    }

    private func open(id: String, call: CallSession?, entry: QueueEntry?) {
        if id != selectedId {
            events = nil
            notes = nil
            notice = nil
            noteDraft = ""
        }
        selectedId = id
        selectedCall = call
        selectedEntry = entry
        startDetailPolling(id)
        Task { await loadPrevious(call) }
    }

    /// Opened from the ringing banner or a notification: shows that call on the
    /// live desk; false when it has already left the line.
    @discardableResult
    func show(callId: String) -> Bool {
        if showHistory { showHistory = false }
        guard let item = queueItem(callId) else {
            showNotice(app.strings["callTakenElsewhere"], severity: .info)
            return false
        }
        if !visibleQueue.contains(where: { $0.id == callId }) {
            search = ""
            channel = "all"
        }
        if selectedId == callId {
            selectedCall = item.entry.callSession ?? selectedCall
            selectedEntry = item.entry
        } else {
            open(id: callId, call: item.entry.callSession, entry: item.entry)
        }
        scrollRequest = callId
        return true
    }

    /// `app.pendingCall`: select it, and answer it straight from the banner
    /// through the same path as the Accept button.
    func handlePending(id: String, answer: Bool) {
        if show(callId: id), answer {
            Task { await accept() }
        }
    }

    private func startDetailPolling(_ callId: String) {
        detailPoller?.stop()
        guard overviewPoller != nil else { detailPoller = nil; return }
        detailPoller = Poller("call detail", interval: { 4 }) { [weak self] in try await self?.loadDetail(callId) }
        detailPoller?.start()
    }

    private func loadDetail(_ callId: String) async throws {
        guard let ws = app.workspace, callId == selectedId else { return }
        let detail = try await app.api.callDetail(workspaceId: ws.id, callId: callId)
        guard callId == selectedId else { return }
        selectedCall = detail.call
        events = detail.events ?? []
        let list = try await app.api.callNotes(workspaceId: ws.id, callId: callId)
        if callId == selectedId { notes = list }
    }

    /// Up to eight earlier calls from the same visitor, matched as the web desk does.
    private func loadPrevious(_ call: CallSession?) async {
        previous = nil
        previousLoading = false
        guard let call, let ws = app.workspace else { return }
        previousLoading = true
        defer { if selectedId == call.id { previousLoading = false } }
        do {
            if recent.isEmpty { recent = try await app.api.callHistory(workspaceId: ws.id, limit: 100) }
            guard selectedId == call.id else { return }
            let earlier = recent.filter { c in
                guard c.id != call.id else { return false }
                if let v = call.visitorSessionId, c.visitorSessionId == v { return true }
                if let e = call.visitorEmail, !e.isEmpty, let ce = c.visitorEmail, ce.caseInsensitiveCompare(e) == .orderedSame { return true }
                if let p = call.visitorPhone, !p.isEmpty, c.visitorPhone == p { return true }
                return false
            }
            previous = Array(earlier.prefix(8))
        } catch {
            Log.error("previous calls", error)
            if selectedId == call.id { previous = [] }
        }
    }

    // MARK: What the detail shows

    /// The call as the detail shows it: the queue's copy while it waits, else the latest detail.
    var shownCall: CallSession? {
        guard let id = selectedId else { return nil }
        if let item = queueItem(id) { return item.entry.callSession ?? Self.session(for: item.entry) }
        if let selectedCall { return selectedCall }
        return selectedEntry.map { Self.session(for: $0) }
    }

    /// Whether the picked call is still in the waiting line.
    var selectedIsWaiting: Bool {
        guard let id = selectedId else { return false }
        return isQueued(id)
    }

    var shownName: String {
        guard let id = selectedId else { return "" }
        if let item = queueItem(id) { return item.name }
        guard let c = shownCall else { return "" }
        return CallNames.caller(c, fallbackId: c.contactId ?? c.visitorSessionId ?? c.id, app.strings)
    }

    /// Video or voice: the line's channel while it waits, else the session's type.
    var shownIsVideo: Bool {
        guard let id = selectedId else { return false }
        if let item = queueItem(id) { return item.entry.isVideo }
        if let selectedCall { return selectedCall.isVideo }
        return selectedEntry?.isVideo ?? false
    }

    /// How long the picked call has been waiting, in seconds.
    var selectedWait: TimeInterval {
        guard let id = selectedId, let item = queueItem(id) else { return 0 }
        return max(0, now.timeIntervalSince(item.since(now)))
    }

    func isOnCall(_ c: CallSession) -> Bool {
        onCallId == c.id || (c.state == "active" && c.assignedAgentId != nil && c.assignedAgentId == app.user?.id)
    }

    /// A queue entry without its session, as a bare session.
    static func session(for e: QueueEntry) -> CallSession {
        CallSession(id: e.callSessionId, callType: e.channel, createdAt: e.createdAt, visitorSessionId: e.visitorSessionId, contactId: e.contactId)
    }

    // MARK: Actions

    func accept() async {
        guard let id = selectedId, let ws = app.workspace, let item = queueItem(id) else { return }
        let s = app.strings
        if CallCoordinator.shared.isBusy {
            showNotice(s["ccOnCall"])
            return
        }
        accepting = true
        defer { accepting = false }
        do {
            let accept = try await app.api.acceptCall(workspaceId: ws.id, callId: id)
            onCallId = id
            if accept.connect?.supported != true {
                showNotice("\(s["ccAcceptedNoMedia"]) — \(s["ccAcceptedNoMediaHint"])", severity: .warning)
            } else {
                var call = item.entry.callSession ?? Self.session(for: item.entry)
                if item.entry.isVideo { call.callType = "video" }
                CallCoordinator.shared.joinAccepted(app: app, accept: accept, call: call, callId: id)
            }
            app.callQueue?.kick()
            detailPoller?.kick()
        } catch {
            Log.error("accept call", error)
            showNotice("\(s["ccAcceptFailed"]) — \(ErrorText.of(error, s))")
        }
    }

    func reject() async {
        guard let id = selectedId, let ws = app.workspace else { return }
        let s = app.strings
        rejecting = true
        defer { rejecting = false }
        do {
            try await app.api.rejectCall(workspaceId: ws.id, callId: id)
            app.callQueue?.kick()
        } catch {
            Log.error("reject call", error)
            showNotice("\(s["ccRejectFailed"]) — \(ErrorText.of(error, s))")
        }
    }

    func end() async {
        guard let id = selectedId, let ws = app.workspace else { return }
        let s = app.strings
        ending = true
        defer { ending = false }
        do {
            try await app.api.endCall(workspaceId: ws.id, callId: id)
            onCallId = nil
            app.callQueue?.kick()
            detailPoller?.kick()
        } catch {
            Log.error("end call", error)
            showNotice("\(s["ccEndFailed"]) — \(ErrorText.of(error, s))")
        }
    }

    func addNote() async {
        let text = noteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let id = selectedId, let ws = app.workspace else { return }
        addingNote = true
        defer { addingNote = false }
        do {
            try await app.api.addCallNote(workspaceId: ws.id, callId: id, note: text)
            if selectedId == id { noteDraft = "" }
            detailPoller?.kick()
        } catch {
            Log.error("call note", error)
            showNotice(ErrorText.of(error, app.strings))
        }
    }

    /// After the in-call window closes: wrap-up — the notes box is right there.
    private func deskCallEnded(_ callId: String) {
        if onCallId == callId { onCallId = nil }
        guard callId == selectedId else { return }
        let s = app.strings
        notice = CallDeskNotice(severity: .info, title: s["ccWrapUp"], message: s["ccWrapUpHint"])
        detailPoller?.kick()
        focusNoteRequest += 1
    }

    private func showNotice(_ message: String, severity: Banner.Severity = .error) {
        notice = CallDeskNotice(severity: severity, title: nil, message: message)
    }
}

/// The strip over the call picked: the Windows desk's InfoBar.
struct CallDeskNotice: Equatable {
    var severity: Banner.Severity
    var title: String?
    var message: String
}

/// A call waiting in the line, with its rank and the name the desk gives the caller.
struct CallDeskItem: Identifiable, Equatable {
    let entry: QueueEntry
    let rank: Int
    let name: String

    var id: String { entry.callSessionId }

    /// When the call came in.
    func since(_ fallback: Date) -> Date { Self.since(entry, fallback) }

    static func since(_ e: QueueEntry, _ fallback: Date) -> Date {
        e.createdAt ?? e.callSession?.createdAt ?? fallback
    }

    /// The line under the name: the subject, the page title, else the page address.
    var detail: String {
        let c = entry.callSession
        if let subject = c?.subject, !subject.isEmpty { return subject }
        if let title = c?.pageTitle, !title.isEmpty { return title }
        return CallDeskText.shortUrl(c?.pageUrl)
    }

    func matches(_ q: String, _ channel: String) -> Bool {
        if channel == "voice" && entry.isVideo { return false }
        if channel == "video" && !entry.isVideo { return false }
        if q.isEmpty { return true }
        let c = entry.callSession
        let fields: [String?] = [name, c?.visitorEmail, c?.visitorPhone, c?.subject, c?.pageTitle, c?.pageUrl]
        return fields.contains { $0?.localizedCaseInsensitiveContains(q) == true }
    }
}

/// The call center's labels and colours, as the web's callLabels.ts.
enum CallDeskText {
    static func state(_ state: String?, _ s: Strings) -> String {
        switch state {
        case "pending": return s["ccStatePending"]
        case "queued", "offered": return s["ccStateQueued"]
        case "ringing": return s["ccStateRinging"]
        case "connecting": return s["ccStateConnecting"]
        case "active", "in_progress": return s["ccStateActive"]
        case "cancelled": return s["ccStateCancelled"]
        case "missed": return s["ccStateMissed"]
        case "failed": return s["ccStateFailed"]
        default: return s["ccStateEnded"]
        }
    }

    /// (foreground, background) for a call state.
    static func stateColors(_ state: String?) -> (Color, Color) {
        switch state {
        case "active", "in_progress", "connecting": return (Palette.success, Palette.successSoft)
        case "queued", "offered", "pending", "ringing": return (Palette.warning, Palette.warningSoft)
        case "missed", "failed": return (Palette.danger, Palette.dangerSoft)
        case "cancelled": return (Palette.text2, Palette.elevated)
        default: return (Palette.brand, Palette.brandSoft)
        }
    }

    static func event(_ type: String?, _ s: Strings) -> String {
        let key: String?
        switch type {
        case "call_requested": key = "ccEvCallRequested"
        case "call_queued": key = "ccEvCallQueued"
        case "call_accepted": key = "ccEvCallAccepted"
        case "call_rejected": key = "ccEvCallRejected"
        case "call_connected": key = "ccEvCallConnected"
        case "call_ended": key = "ccEvCallEnded"
        case "call_missed": key = "ccEvCallMissed"
        case "call_cancelled": key = "ccEvCallCancelled"
        case "operator_joined": key = "ccEvOperatorJoined"
        case "visitor_joined": key = "ccEvVisitorJoined"
        case "visitor_left": key = "ccEvVisitorLeft"
        default: key = nil
        }
        if let key { return s[key] }
        return (type ?? "").replacingOccurrences(of: "_", with: " ")
    }

    static func eventColor(_ type: String?) -> Color {
        switch type {
        case "call_accepted", "call_connected", "operator_joined", "visitor_joined": return Palette.success
        case "call_missed", "call_rejected", "call_cancelled", "visitor_left": return Palette.danger
        case "call_ended": return Palette.text3
        default: return Palette.brand
        }
    }

    /// m:ss since the call came in.
    static func wait(_ seconds: TimeInterval, _ language: Language) -> String {
        let t = max(0, Int(seconds))
        return Digits.localize("\(t / 60):" + String(format: "%02d", t % 60), language)
    }

    /// Green, then amber after a minute and red after three (the web desk's SLA).
    static func waitColors(_ seconds: TimeInterval) -> (Color, Color) {
        if seconds > 180 { return (Palette.danger, Palette.dangerSoft) }
        if seconds > 60 { return (Palette.warning, Palette.warningSoft) }
        return (Palette.success, Palette.successSoft)
    }

    /// m:ss talk time, or a dash when the call never connected.
    static func duration(_ seconds: Int?, _ language: Language) -> String {
        guard let d = seconds, d > 0 else { return "—" }
        return Digits.localize("\(d / 60):" + String(format: "%02d", d % 60), language)
    }

    /// host/path without the scheme, as a line fits it; Persian slugs decoded.
    static func shortUrl(_ url: String?) -> String {
        guard let url, !url.trimmingCharacters(in: .whitespaces).isEmpty else { return "" }
        guard let c = URLComponents(string: url), c.scheme != nil, let host = c.host, !host.isEmpty else {
            return url.removingPercentEncoding ?? url
        }
        var path = c.percentEncodedPath.isEmpty ? "/" : c.percentEncodedPath
        if let q = c.percentEncodedQuery { path += "?" + q }
        path = path.removingPercentEncoding ?? path
        return path == "/" ? host : host + path
    }

    static func channelIcon(video: Bool) -> String { video ? "video.fill" : "phone.fill" }
}
