import AVFoundation
import AppKit
import LiveKit
import SwiftUI

/// The inside of the call window — the Windows call page (Assets/Call/call.html)
/// in SwiftUI: the visitor's face and the call's state in the middle, the
/// controls in a glass row at the bottom, and for a video call their picture
/// edge to edge with the operator's own camera inset in the corner.
struct CallView: View {
    let call: LiveCall
    @Environment(AppModel.self) private var app
    /// The notes beside the call (over the picture on a video call).
    @State private var showNotes = false
    @State private var showTransfer = false

    private var s: Strings { app.strings }

    /// The video layout — the picture edge to edge, the name in the corner. Decided by the call,
    /// not by whether a frame is arriving this instant: a voice call never takes it, and a video
    /// call keeps it once connected, so a picture that drops for a moment no longer moves the
    /// face, the name and the buttons back and forth.
    private var videoLive: Bool {
        guard call.isVideo else { return false }
        return call.phase == .connected || call.remoteVideoTrack != nil || call.localVideoTrack != nil
    }

    var body: some View {
        ZStack {
            Color(hex: 0x0C0E14)
                .ignoresSafeArea()
            if videoLive {
                videoLayer
                    .ignoresSafeArea()
            } else {
                centeredWho
                    // Beside the notes rather than under them.
                    .padding(.leading, showNotes ? CallNotesPanel.width + 16 : 0)
            }
        }
        .overlay(alignment: .leading) {
            if showNotes {
                CallNotesPanel(call: call, s: s) { setNotes(false) }
                    .padding(.leading, 14)
                    .padding(.top, videoLive ? 72 : 52)
                    .padding(.bottom, 104)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        .animation(.smooth(duration: 0.22), value: showNotes)
        .overlay(alignment: .topLeading) {
            if videoLive {
                compactWho
                    .padding(.top, 14)
                    .padding(.horizontal, 20)
            }
        }
        .overlay(alignment: .top) { notices }
        .overlay(alignment: .topTrailing) { pinButton }
        .overlay(alignment: .bottom) {
            controls
                .padding(.bottom, 22)
        }
        .environment(\.colorScheme, .dark)
        .foregroundStyle(Color(hex: 0xE8ECF4))
        .callDebugHooks(call) { what in
            if what == "notes" { setNotes(!showNotes) } else if what == "transfer" { showTransfer.toggle() }
        }
    }

    // MARK: The person

    private var centeredWho: some View {
        VStack(spacing: 14) {
            ZStack {
                if call.phase == .waiting {
                    CallPulse()
                }
                avatar(112)
            }
            .frame(width: 160, height: 160)
            Text(call.name)
                .appFont(22, .bold)
                .lineLimit(1)
                .truncationMode(.tail)
            statusLine
                .appFont(14)
                .foregroundStyle(statusColor)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 60)
    }

    private var compactWho: some View {
        HStack(spacing: 12) {
            avatar(40)
            VStack(alignment: .leading, spacing: 2) {
                Text(call.name)
                    .appFont(15, .bold)
                    .lineLimit(1)
                statusLine
                    .appFont(13)
                    .foregroundStyle(statusColor)
            }
            .shadow(color: .black.opacity(0.6), radius: 4, y: 1)
        }
    }

    private func avatar(_ size: CGFloat) -> some View {
        CallAvatar(call: call, size: size)
    }

    private var statusColor: Color { CallStatusText.color(call) }

    private var statusLine: some View { CallStatusText(call: call) }

    // MARK: Video

    private var videoLayer: some View {
        CallVideoStage(call: call, previewBottom: 96)
    }

    // MARK: Notices

    @ViewBuilder
    private var notices: some View {
        VStack(spacing: 8) {
            if let to = call.transferredTo, call.phase.isLive {
                Label(call.handoverJoined ? s.get("callHandoverJoined", "name", to) : s.get("callTransferredWaiting", "name", to),
                      systemImage: "arrow.left.arrow.right")
                    .appFont(12)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .glassCapsule(tint: Palette.brand.opacity(0.35))
            }
            if let key = call.warningKey, call.phase.isLive {
                Label(s[key], systemImage: "exclamationmark.triangle.fill")
                    .appFont(12)
                    .foregroundStyle(Palette.warning)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .glassCapsule(tint: Palette.warning.opacity(0.35))
            }
            if let blocked = call.mediaBlocked, call.phase.isLive {
                permissionNotice(blocked)
            }
        }
        .padding(.top, 14)
        .padding(.horizontal, 60)
        .frame(maxWidth: 520)
    }

    /// macOS refused the microphone or camera: where to allow it, one click away.
    private func permissionNotice(_ type: AVMediaType) -> some View {
        HStack(spacing: 10) {
            Text(s["mediaPermission"])
                .appFont(12)
                .foregroundStyle(Color(hex: 0xE8ECF4))
                .fixedSize(horizontal: false, vertical: true)
            Button(s["openWindowsSettings"]) { openPrivacySettings(type) }
                .controlSize(.small)
                .glassButton()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassCard(12)
    }

    private func openPrivacySettings(_ type: AVMediaType) {
        CallVideoStage.openPrivacySettings(type)
    }

    // MARK: Window

    /// Back into the page, full screen, keep on top.
    private var pinButton: some View {
        let co = CallCoordinator.shared
        return HStack(spacing: 8) {
            if call.isVideo {
                windowButton(icon: co.isFullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                             help: s[co.isFullScreen ? "callExitFullScreen" : "callFullScreen"]) { co.toggleFullScreen() }
            }
            windowButton(icon: "pip.enter", help: s["callDockBack"]) { co.dockBack() }
            windowButton(icon: co.isFloating ? "pin.fill" : "pin", help: s["callKeepOnTop"], on: co.isFloating) {
                co.setFloating(!co.isFloating)
            }
        }
        .padding(.top, 12)
        .padding(.horizontal, 14)
    }

    private func windowButton(icon: String, help: String, on: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(on ? Palette.brand : Color.white.opacity(0.85))
                .frame(width: 30, height: 30)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glass(Circle(), interactive: true)
        .help(help)
    }

    // MARK: Controls

    private var controls: some View {
        let live = call.phase == .connected
        return GlassGroup(spacing: 14) {
            HStack(spacing: 14) {
                CallControlButton(icon: call.isMuted ? "mic.slash.fill" : "mic.fill",
                                  help: s[call.isMuted ? "unmute" : "mute"],
                                  solid: call.isMuted ? Color.white : nil) {
                    call.toggleMute()
                }
                .keyboardShortcut("m", modifiers: [.command, .shift])
                .disabled(!live)
                if call.isVideo {
                    CallControlButton(icon: call.isCameraOn ? "video.fill" : "video.slash.fill",
                                      help: s["camera"],
                                      solid: call.isCameraOn ? nil : Color.white) {
                        call.toggleCamera()
                    }
                    .keyboardShortcut("v", modifiers: [.command, .shift])
                    .disabled(!live)
                }
                if call.hasNotes {
                    CallControlButton(icon: "note.text", help: s["callNotes"],
                                      solid: showNotes ? Color.white : nil) {
                        setNotes(!showNotes)
                    }
                    .keyboardShortcut("n", modifiers: [.command, .shift])
                }
                if call.canTransfer && call.transferredTo == nil {
                    CallControlButton(icon: "arrow.left.arrow.right", help: s["callTransfer"],
                                      solid: showTransfer ? Color.white : nil) {
                        showTransfer.toggle()
                    }
                    .disabled(!live)
                    .popover(isPresented: $showTransfer, arrowEdge: .top) {
                        CallTransferPanel(call: call) { showTransfer = false }
                            .callPopover()
                    }
                }
                if call.transferredTo != nil {
                    // Handed on: hanging up here would end the call for the colleague too.
                    CallControlButton(icon: "rectangle.portrait.and.arrow.forward", help: s["callLeave"], solid: Palette.warning) {
                        call.leave()
                    }
                    .disabled(!call.phase.isLive)
                } else {
                    CallControlButton(icon: "phone.down.fill", help: s["hangUpCall"], solid: Palette.danger) {
                        call.hangUp()
                    }
                    .disabled(!call.phase.isLive)
                }
            }
        }
        .opacity(call.phase.isLive ? 1 : 0.4)
    }

    private func setNotes(_ open: Bool) {
        showNotes = open
        // A voice call's window is narrow: it widens for the notes and narrows again after.
        if !videoLive { CallCoordinator.shared.fitSidePanel(open) }
    }
}

/// The notes' glass card, when they stand beside the call rather than in a popover.
private struct CallPanelChrome: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on { content.glassCard(18) } else { content }
    }
}

/// A popover is a window of its own and does not carry the page's reading
/// direction with it: set it again, so Persian reads right to left there too.
private struct CallPopoverStyle: ViewModifier {
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        content
            .environment(\.colorScheme, .dark)
            .environment(\.layoutDirection, app.strings.isRightToLeft ? .rightToLeft : .leftToRight)
            .foregroundStyle(Color(hex: 0xE8ECF4))
            .background(Color(hex: 0x14171F))
            .presentationBackground(Color(hex: 0x14171F))
    }
}

extension View {
    /// A popover off a call (notes, transfer): the call's own solid dark, edge to edge —
    /// not the system's grey popover material with a second, lighter card inside it.
    func callPopover() -> some View {
        modifier(CallPopoverStyle())
    }

    /// DebugTools' `callui` command: opens a panel as if its button had been clicked.
    @ViewBuilder
    func callDebugHooks(_ call: LiveCall, _ open: @escaping (String) -> Void) -> some View {
        #if DEBUG
        onChange(of: call.debugOpen) { _, what in
            guard let what else { return }
            open(what)
            call.debugOpen = nil
        }
        #else
        self
        #endif
    }
}

// MARK: - Notes

/// The call's notes beside it: read every few seconds, so what a colleague writes shows up,
/// and what is written here is there for whoever the call is handed to.
struct CallNotesPanel: View {
    static let width: CGFloat = 300

    @Bindable var call: LiveCall
    let s: Strings
    let close: () -> Void
    /// Its own glass card beside the call; none in a popover, which is the card.
    var chrome = true
    @FocusState private var focused: Bool

    private var draftEmpty: Bool { call.noteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(s["callNotes"], systemImage: "note.text")
                    .appFont(13, .semibold)
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 22, height: 22)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.white.opacity(0.7))
                .help(s["close"])
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        if let notes = call.shownNotes {
                            if notes.isEmpty {
                                Text(s["callNotesEmpty"])
                                    .appFont(12)
                                    .foregroundStyle(Color(hex: 0x98A2B3))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            ForEach(notes) { n in
                                bubble(n).id(n.id)
                            }
                        } else {
                            ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .onChange(of: call.shownNotes?.last?.id, initial: true) { _, id in
                    guard let id else { return }
                    withAnimation(.smooth(duration: 0.2)) { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
            if let error = call.noteError {
                Text(error)
                    .appFont(11.5)
                    .foregroundStyle(Palette.danger)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(s["callNotePlaceholder"], text: $call.noteDraft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .appFont(13)
                    .readingSide(s.isRightToLeft)
                    .lineLimit(1...5)
                    .focused($focused)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .onChange(of: call.noteDraft) { _, text in
                        if text.count > 2000 { call.noteDraft = String(text.prefix(2000)) }
                    }
                    .onKeyPress(.return, phases: .down) { press in
                        // Enter adds the note; Shift+Enter starts a new line, as in the chat composer.
                        if press.modifiers.contains(.shift) || press.modifiers.contains(.option) {
                            call.noteDraft += "\n"
                            return .handled
                        }
                        call.addNote()
                        return .handled
                    }
                Button {
                    call.addNote()
                    focused = true
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 26))
                        .foregroundStyle(draftEmpty ? Color.white.opacity(0.25) : Palette.brand)
                        .frame(width: 30, height: 30)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(draftEmpty)
                .help(s["callNoteSend"])
                .accessibilityLabel(s["callNoteSend"])
            }
        }
        .padding(14)
        .frame(width: Self.width)
        .frame(maxHeight: .infinity, alignment: .top)
        .modifier(CallPanelChrome(on: chrome))
        .onAppear { focused = true }
    }

    private func bubble(_ n: CallWindowNote) -> some View {
        let when = n.at.map { Display.listStamp($0, s) } ?? ""
        let head = [n.author, when].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 3) {
            if !head.isEmpty {
                Text(verbatim: head).appFont(11).foregroundStyle(Color(hex: 0x98A2B3))
            }
            Text(n.text)
                .appFont(12.5)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            switch n.sending {
            case .no:
                EmptyView()
            case .going:
                HStack(spacing: 5) {
                    ProgressView().controlSize(.mini)
                    Text(s["callNoteSending"])
                }
                .appFont(11)
                .foregroundStyle(Color(hex: 0x98A2B3))
            case .failed:
                HStack(spacing: 10) {
                    Label(s["callNoteFailed"], systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(Palette.danger)
                    Button(s["callNoteRetry"]) { call.retryNote(n.id) }
                        .buttonStyle(.plain)
                        .foregroundStyle(Palette.brand)
                    Button(s["callNoteDiscard"]) { call.discardNote(n.id) }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color(hex: 0x98A2B3))
                }
                .appFont(11, .semibold)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.white.opacity(n.sending == .no ? 0.07 : 0.045), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .opacity(n.sending == .going ? 0.75 : 1)
    }
}

// MARK: - Transfer

/// Who the call can go to — operators with their state and load, or a department — and why.
struct CallTransferPanel: View {
    let call: LiveCall
    let done: () -> Void
    @Environment(AppModel.self) private var app
    @State private var toDepartment = false
    @State private var people: [Person] = []
    @State private var departments: [CallDepartment] = []
    @State private var loading = true
    @State private var pickedAgent: String?
    @State private var pickedDepartment: String?
    @State private var reason = ""

    struct Person: Identifiable {
        let id: String
        let name: String
        let status: String
        let calls: Int
    }

    /// The roles the server lets a call be assigned to.
    private static let assignable: Set<String> = ["owner", "admin", "agent", "support_agent", "team_lead"]

    var body: some View {
        let s = app.strings
        VStack(alignment: .leading, spacing: 12) {
            Text(s["callTransfer"]).appFont(14, .bold)
            Picker("", selection: $toDepartment) {
                Text(s["callTransferOperators"]).tag(false)
                Text(s["callTransferDepartments"]).tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            ScrollView {
                VStack(spacing: 4) {
                    if loading {
                        ProgressView().controlSize(.small).padding(.vertical, 20)
                    } else if toDepartment {
                        if departments.isEmpty { empty(s["callTransferNoDepartments"]) }
                        ForEach(departments) { d in
                            row(selected: pickedDepartment == d.id, dot: Palette.brand, title: d.name ?? "—", subtitle: nil) {
                                pickedDepartment = d.id
                            }
                        }
                    } else {
                        if people.isEmpty { empty(s["callTransferNoOperators"]) }
                        ForEach(people) { p in
                            row(selected: pickedAgent == p.id, dot: dot(p.status), title: p.name,
                                subtitle: statusText(p, s)) {
                                pickedAgent = p.id
                            }
                        }
                    }
                }
            }
            .frame(height: 220)
            TextField(s["callTransferReason"], text: $reason)
                .textFieldStyle(.plain)
                .appFont(13)
                .readingSide(s.isRightToLeft)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .onChange(of: reason) { _, text in
                    if text.count > 200 { reason = String(text.prefix(200)) }
                }
            Text(s["callTransferHint"])
                .appFont(11.5)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let error = call.transferError {
                Text("\(s["callTransferFailed"]) — \(error)")
                    .appFont(11.5)
                    .foregroundStyle(Palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button(s["cancel"], action: done)
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await submit() }
                } label: {
                    if call.transferring {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(s["callTransferSubmit"])
                    }
                }
                .keyboardShortcut(.defaultAction)
                .prominentButton()
                .disabled(target == nil || call.transferring)
            }
        }
        .padding(16)
        .frame(width: 340)
        .task { await load() }
    }

    private var target: String? { toDepartment ? pickedDepartment : pickedAgent }

    private func submit() async {
        let s = app.strings
        let name: String
        if toDepartment {
            name = departments.first { $0.id == pickedDepartment }?.name ?? s["callTransferDepartments"]
        } else {
            name = people.first { $0.id == pickedAgent }?.name ?? ""
        }
        let ok = await call.transfer(toAgent: toDepartment ? nil : pickedAgent,
                                     department: toDepartment ? pickedDepartment : nil,
                                     name: name, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines))
        if ok { done() }
    }

    private func load() async {
        guard let ws = app.workspace else { loading = false; return }
        let me = app.user?.id
        async let membersTask = try? app.loadMembers()
        async let presenceTask = try? app.api.callAgentPresence(workspaceId: ws.id)
        async let departmentsTask = try? app.api.callDepartments(workspaceId: ws.id)
        let members = await membersTask ?? []
        let presence = Dictionary((await presenceTask ?? []).map { ($0.userId, $0) }, uniquingKeysWith: { a, _ in a })
        let video = call.isVideo
        departments = (await departmentsTask ?? []).filter {
            $0.enabled != false && (video ? $0.ccVideoEnabled != false : $0.ccVoiceEnabled != false)
        }
        people = members
            .filter { $0.suspendedAt == nil && $0.userId != me && ($0.role.map { Self.assignable.contains($0) } ?? true) }
            .map { m in
                let p = presence[m.userId]
                return Person(id: m.userId, name: m.displayName, status: p?.status ?? "offline", calls: p?.activeCallCount ?? 0)
            }
            .sorted { a, b in
                let ra = Self.rank(a.status), rb = Self.rank(b.status)
                return ra != rb ? ra < rb : a.name.localizedCompare(b.name) == .orderedAscending
            }
        loading = false
    }

    private static func rank(_ status: String) -> Int {
        switch status {
        case "available": return 0
        case "busy": return 1
        case "away": return 2
        default: return 3
        }
    }

    private func dot(_ status: String) -> Color {
        switch status {
        case "available": return Palette.success
        case "busy": return Palette.brand
        case "away": return Palette.warning
        default: return Color.gray
        }
    }

    private func statusText(_ p: Person, _ s: Strings) -> String {
        let key: String
        switch p.status {
        case "available": key = "callAgentAvailable"
        case "busy": key = "callAgentBusy"
        case "away": key = "callAgentAway"
        default: key = "callAgentOffline"
        }
        return p.calls > 0 ? "\(s[key]) · \(s.number(p.calls))" : s[key]
    }

    private func empty(_ text: String) -> some View {
        Text(text)
            .appFont(12)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
    }

    private func row(selected: Bool, dot: Color, title: String, subtitle: String?, pick: @escaping () -> Void) -> some View {
        Button(action: pick) {
            HStack(spacing: 10) {
                Circle().fill(dot).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).appFont(13, .medium).lineLimit(1)
                    if let subtitle {
                        Text(subtitle).appFont(11).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 4)
                if selected {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.brand)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Palette.brand.opacity(0.24) : Color.white.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// One round control: glass, or a solid disc when switched off (white) or for hanging up (red).
struct CallControlButton: View {
    let icon: String
    let help: String
    var solid: Color?
    /// 56 in the call window; smaller where the call sits inside a page.
    var size: CGFloat = 56
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            face
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
    }

    @ViewBuilder
    private var face: some View {
        let glyph = Image(systemName: icon)
            .font(.system(size: size * 0.36, weight: .medium))
            .foregroundStyle(solid == Color.white ? Color(hex: 0x0C0E14) : Color.white)
            .frame(width: size, height: size)
            .contentShape(Circle())
        if let solid {
            glyph.background(Circle().fill(solid))
        } else {
            glyph.glass(Circle(), interactive: true)
        }
    }
}

/// Soft rings around the face while the visitor is being rung.
struct CallPulse: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // Driven by the clock, not by a repeating `withAnimation` started in `onAppear`: that
        // transaction also caught the layout settling around it as the window opened, so the
        // face, the name and the buttons swung back and forth with the rings for as long as
        // the visitor was being rung — every call from a conversation, which rings until the
        // visitor answers (a desk call is answered at once and never showed it).
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            // 0…1…0 every 1.8 s, eased like the old ease-in-out.
            let wave = reduceMotion ? 0 : (1 - cos(t * .pi / 0.9)) / 2
            ZStack {
                Circle()
                    .fill(Color(hex: 0x5A94FF).opacity(0.05))
                    .frame(width: 156, height: 156)
                    .scaleEffect(0.92 + 0.18 * wave)
                Circle()
                    .fill(Color(hex: 0x5A94FF).opacity(0.10))
                    .frame(width: 132, height: 132)
                    .scaleEffect(0.96 + 0.10 * wave)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Shared by the call window, the panel in the page and the call bar

/// The visitor's face (or the caller's, on the desk).
struct CallAvatar: View {
    let call: LiveCall
    let size: CGFloat

    var body: some View {
        if let c = call.conversation {
            AvatarView(name: c.contacts?.name, email: c.contacts?.email, os: c.visitorOs,
                       countryCode: c.visitorCountryCode, imageURL: c.contacts?.avatarUrl, size: size)
        } else {
            CallerAvatar(call: call.desk?.session, size: size)
        }
    }
}

/// A call-center caller's face, drawn as everywhere else: their device's logo
/// on its gradient and their flag, looked up by visitor session as the web desk
/// does. Until that is known, or when it cannot be, a grey disc with a person.
struct CallerAvatar: View {
    let call: CallSession?
    /// The queue's own note of the session, when its copy of the call lacks one.
    var sessionId: String? = nil
    var size: CGFloat = 42
    @Environment(AppModel.self) private var app

    var body: some View {
        let sid = call?.visitorSessionId ?? sessionId
        let p = sid.flatMap { app.sessionProfiles[$0] }
        AvatarView(name: call?.visitorName, email: call?.visitorEmail, os: p?.device?.os,
                   countryCode: p?.geo?.countryCode, size: size, faceless: true)
            .task(id: sid) { app.wantSessionProfile(sid) }
    }
}

/// Ringing, connecting, the running time, or how it ended — coloured green while connected.
struct CallStatusText: View {
    let call: LiveCall
    @Environment(AppModel.self) private var app

    static func color(_ call: LiveCall) -> Color {
        call.phase == .connected ? Palette.success : Color(hex: 0x98A2B3)
    }

    var body: some View {
        let s = app.strings
        Group {
            switch call.phase {
            case .waiting:
                Text(s[call.desk == nil ? "callWaiting" : "connectingCall"])
            case .connecting:
                Text(s["connectingCall"])
            case .connected:
                if let at = call.connectedAt {
                    TimelineView(.periodic(from: at, by: 1)) { context in
                        Text(Display.duration(Int(context.date.timeIntervalSince(at)), s.language))
                            .monospacedDigit()
                    }
                } else {
                    Text(Display.duration(0, s.language))
                }
            case .ended(let outcome):
                Text(s[outcome.textKey])
            }
        }
        .foregroundStyle(Self.color(call))
    }
}

/// The picture: the visitor's camera edge to edge (their face while it is off), the
/// operator's own camera inset in the corner.
struct CallVideoStage: View {
    let call: LiveCall
    /// Room below the operator's camera for the controls laid over the picture.
    var previewBottom: CGFloat = 96
    var previewMaxWidth: CGFloat = 260

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottomTrailing) {
                Color.black
                if call.remoteVideoTrack == nil {
                    // The visitor's camera is off (or not there yet): their face where the picture goes.
                    CallAvatar(call: call, size: min(96, geo.size.height * 0.4))
                        .frame(width: geo.size.width, height: geo.size.height)
                }
                if let remote = call.remoteVideoTrack {
                    // Flipped once, as the web console flips every call video (src/index.css,
                    // "Call video orientation"): the visitor's camera arrives mirrored, and this
                    // shows them the way they really are. Pinned left to right so a right-to-left
                    // window never adds a second flip.
                    SwiftUIVideoView(remote, layoutMode: .fill, mirrorMode: .mirror)
                        .environment(\.layoutDirection, .leftToRight)
                        .frame(width: geo.size.width, height: geo.size.height)
                        .clipped()
                }
                if let local = call.localVideoTrack {
                    localPreview(local, width: min(geo.size.width * 0.26, previewMaxWidth))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    /// The operator's own camera, mirrored the way every selfie camera is.
    private func localPreview(_ track: VideoTrack, width: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return SwiftUIVideoView(track, layoutMode: .fill, mirrorMode: .mirror)
            // Mirrored exactly once, whatever the window's direction (see the visitor's video).
            .environment(\.layoutDirection, .leftToRight)
            .frame(width: width, height: width / 1.6)
            .clipShape(shape)
            .overlay { shape.strokeBorder(Color.white.opacity(0.18), lineWidth: 2) }
            .shadow(color: .black.opacity(0.5), radius: 16, y: 12)
            .padding(.bottom, previewBottom)
            .padding(.trailing, 14)
    }

    static func openPrivacySettings(_ type: AVMediaType) {
        let pane = type == .video ? "Privacy_Camera" : "Privacy_Microphone"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }
}
