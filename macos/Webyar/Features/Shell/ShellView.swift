import SwiftUI

/// The signed-in window: the sidebar with the inboxes and sections (as in
/// the web sidebar and the Windows navigation pane), and the page on show as
/// a list column beside its detail.
struct ShellView: View {
    @Environment(AppModel.self) private var app
    @State private var pages: Pages?
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        Group {
            if let pages {
                NavigationSplitView(columnVisibility: $columns) {
                    SidebarView()
                        .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 300)
                } detail: {
                    // The page: its list at a fixed width beside its detail, as on
                    // Windows (a 340 column, then the rest). A plain stack rather than
                    // a third split column, so a wider window widens the detail.
                    HStack(spacing: 0) {
                        PageList(route: app.route, pages: pages)
                            .frame(width: 340)
                            .frame(maxHeight: .infinity)
                        Divider()
                        PageDetail(route: app.route, pages: pages)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .safeAreaInset(edge: .top, spacing: 0) { ShellBanners() }
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    IncomingCallCard()
                        .padding(20)
                }
            } else {
                Color.clear
            }
        }
        .onAppear { if pages == nil { pages = Pages(app: app) } }
        .onDisappear { pages?.stop() }
        .onChange(of: app.callQueue?.queue.map(\.callSessionId) ?? []) { _, _ in app.syncRinging() }
    }
}

/// Each section's state, kept while the window is open so switching between
/// sections is instant and a half-written reply survives a look elsewhere.
@MainActor
final class Pages {
    let inbox: InboxModel
    let contacts: ContactsModel
    let visitors: VisitorsModel
    let calls: CallCenterModel
    let colleagues: ColleaguesModel
    let email: EmailModel

    init(app: AppModel) {
        inbox = InboxModel(app: app)
        contacts = ContactsModel(app: app)
        visitors = VisitorsModel(app: app)
        calls = CallCenterModel(app: app)
        colleagues = ColleaguesModel(app: app)
        email = EmailModel(app: app)
    }

    func stop() {
        inbox.stop()
        contacts.stop()
        visitors.stop()
        calls.stop()
        colleagues.stop()
        email.stop()
    }
}

struct PageList: View {
    let route: Route
    let pages: Pages

    var body: some View {
        switch route {
        case .inbox, .channel: InboxList(model: pages.inbox, route: route)
        case .contacts: ContactsList(model: pages.contacts)
        case .visitors: VisitorsList(model: pages.visitors)
        case .calls: CallCenterList(model: pages.calls)
        case .colleagues: ColleaguesList(model: pages.colleagues)
        case .email: EmailList(model: pages.email)
        }
    }
}

struct PageDetail: View {
    let route: Route
    let pages: Pages

    var body: some View {
        switch route {
        case .inbox, .channel: ChatView(inbox: pages.inbox)
        case .contacts: ContactDetail(model: pages.contacts)
        case .visitors: VisitorDetail(model: pages.visitors)
        case .calls: CallCenterDetail(model: pages.calls)
        case .colleagues: ColleagueThread(model: pages.colleagues)
        case .email: EmailDetail(model: pages.email)
        }
    }
}

// MARK: - Sidebar

struct SidebarView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        let s = app.strings
        let plan = app.plan
        List(selection: Binding(get: { app.route }, set: { if let r = $0 { app.route = r } })) {
            Section(s["tabInbox"]) {
                row(.inbox(.open), s["navInboxOpen"], "tray.full", badge: app.unread, color: Palette.brand)
                if plan.aiQueue(automated: app.counts.automated) {
                    row(.inbox(.ai), s["navInboxAi"], "sparkles", badge: app.counts.automated ?? 0, color: Palette.ai)
                }
                if plan.needsHumanQueue {
                    row(.inbox(.needsHuman), s["navInboxNeedsHuman"], "person.fill.questionmark", badge: app.counts.needsHuman ?? 0, color: Palette.danger)
                }
                row(.inbox(.pending), s["navInboxPending"], "clock", badge: 0, color: Palette.brand)
                row(.inbox(.resolved), s["navInboxResolved"], "checkmark.circle", badge: 0, color: Palette.brand)
                row(.inbox(.spam), s["navInboxSpam"], "xmark.bin", badge: app.counts.spam ?? 0, color: Palette.text3)
                if plan.emailInbox { row(.email, s["emailInbox"], "envelope", badge: 0, color: Palette.brand) }
            }
            if plan.teamChat {
                Section(s["navInternalInbox"]) {
                    row(.colleagues, s["navColleagues"], "person.2", badge: 0, color: Palette.brand)
                }
            }
            if plan.isAdmin && !app.channels.isEmpty {
                Section(s["navOtherInboxes"]) {
                    ForEach(app.channels, id: \.self) { key in
                        row(.channel(key), Display.channelLabel(key, s), channelIcon(key), badge: 0, color: Palette.brand)
                    }
                }
            }
            Section {
                if plan.contacts { row(.contacts, s["tabContacts"], "person.crop.rectangle.stack", badge: 0, color: Palette.brand) }
                if plan.visitors { row(.visitors, s["navVisitors"], "globe", badge: app.visitorsOnline, color: Palette.success) }
                if plan.callCenter { row(.calls, s["navCallCenter"], "phone", badge: app.callQueue?.queue.count ?? 0, color: Palette.danger) }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) { WorkspaceHeader().padding(.horizontal, 10).padding(.bottom, 6) }
        .safeAreaInset(edge: .bottom, spacing: 0) { AccountCorner().padding(8) }
    }

    private func row(_ route: Route, _ title: String, _ icon: String, badge: Int, color: Color) -> some View {
        HStack(spacing: 0) {
            Label { Text(title).appFont(13) } icon: { Image(systemName: icon) }
            Spacer(minLength: 6)
            CountBadge(count: badge, color: color)
        }
        .tag(route)
    }

    private func channelIcon(_ key: String) -> String {
        switch key {
        case "telegram", "bale": return "paperplane"
        case "whatsapp": return "phone.bubble"
        case "instagram": return "camera"
        case "email": return "envelope"
        case "phone": return "phone"
        default: return "bubble.left"
        }
    }
}

/// The workspace, as at the top of the web sidebar; it opens the list to switch between them.
struct WorkspaceHeader: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        Menu {
            Section(s["switchWorkspace"]) {
                ForEach(app.workspaces) { w in
                    Button {
                        Task { await app.switchWorkspace(w) }
                    } label: {
                        if w.id == app.workspace?.id {
                            Label(w.name.isEmpty ? (w.slug ?? w.id) : w.name, systemImage: "checkmark")
                        } else {
                            Text(w.name.isEmpty ? (w.slug ?? w.id) : w.name)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 10) {
                logo
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text(app.workspace?.name.isEmpty == false ? app.workspace!.name : s["appName"])
                    .appFont(14, .semibold)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.text3)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .glassCard(12, interactive: true)
        .help(s["switchWorkspace"])
        .simultaneousGesture(TapGesture().onEnded { Task { await app.refreshWorkspaces() } })
    }

    @ViewBuilder private var logo: some View {
        if let url = app.workspace?.logoUrl, url.hasPrefix("https://"), let u = URL(string: url) {
            AsyncImage(url: u) { $0.resizable().scaledToFill() } placeholder: { Image("BrandMark").resizable() }
        } else {
            Image("BrandMark").resizable()
        }
    }
}

/// The account: photo, name, and presence as teammates see it; a menu with
/// the invisible switch, the workspaces and sign out.
struct AccountCorner: View {
    @Environment(AppModel.self) private var app
    @State private var confirmSignOut = false
    @State private var statusError: String?

    var body: some View {
        let s = app.strings
        Menu {
            if let email = app.user?.email { Text(email) }
            if let presence = app.presence {
                Divider()
                Section(s["statusHeader"]) {
                    Toggle(isOn: Binding(get: { !presence.isInvisible }, set: { if $0 { setInvisible(false) } })) {
                        Label(s["statusOnlineForVisitors"], systemImage: "checkmark.circle")
                    }
                    Toggle(isOn: Binding(get: { presence.isInvisible }, set: { if $0 { setInvisible(true) } })) {
                        Label(s["statusInvisible"], systemImage: "eye.slash")
                    }
                    .help(s["statusInvisibleHint"])
                }
            }
            if app.workspaces.count > 1 {
                Menu(s["workspace"]) {
                    ForEach(app.workspaces) { w in
                        Toggle(w.name, isOn: Binding(get: { w.id == app.workspace?.id }, set: { _ in Task { await app.switchWorkspace(w) } }))
                    }
                }
            }
            Divider()
            SettingsLink { Label(s["tabSettings"] + "…", systemImage: "gearshape") }
            Button(role: .destructive) { confirmSignOut = true } label: { Label(s["signOut"], systemImage: "rectangle.portrait.and.arrow.right") }
        } label: {
            HStack(spacing: 10) {
                AvatarView(name: app.myName, imageURL: app.account?.avatarUrl, size: 30, kind: .operator, presence: app.myState)
                VStack(alignment: .leading, spacing: 1) {
                    Text(app.myName).appFont(12.5, .semibold).lineLimit(1)
                    Text(statusLine).appFont(11).foregroundStyle(Palette.text2).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .glassCard(12, interactive: true)
        .help(app.workspace.map { "\(app.myName) — \($0.name)" } ?? app.myName)
        .confirmationDialog(s["signOut"], isPresented: $confirmSignOut) {
            Button(s["signOut"], role: .destructive) { Task { await app.signOut() } }
            Button(s["cancel"], role: .cancel) {}
        } message: {
            Text(s["signOutConfirm"])
        }
        .alert(s["statusChangeFailed"], isPresented: Binding(get: { statusError != nil }, set: { if !$0 { statusError = nil } })) {
            Button(s["ok"]) { statusError = nil }
        } message: {
            Text(statusError ?? "")
        }
    }

    private var statusLine: String {
        let label = app.presenceLabel(app.myState)
        return app.presence?.isInvisible == true ? "\(label) · \(app.strings["statusInvisible"])" : label
    }

    private func setInvisible(_ on: Bool) {
        Task { statusError = await app.setInvisible(on) }
    }
}

// MARK: - Banners

/// Over the page: Super Admin's announcements and broadcasts, a required
/// update, and a warning when macOS is hiding the app's notifications.
struct ShellBanners: View {
    @Environment(AppModel.self) private var app
    @State private var notificationsHidden = false

    var body: some View {
        let s = app.strings
        VStack(spacing: 6) {
            ForEach(app.engagement.announcements) { a in
                Banner(severity: severity(a.severity), title: a.title, message: a.body ?? "",
                       actionTitle: a.ctaUrl != nil ? (a.ctaLabel.flatMap { $0.isEmpty ? nil : $0 } ?? s["adLearnMore"]) : nil,
                       action: a.ctaUrl != nil ? { NSWorkspace.shared.openHttps(a.ctaUrl) } : nil,
                       onClose: a.dismissible ? { app.engagement.dismiss(a) } : nil)
            }
            ForEach(app.engagement.broadcasts) { b in
                Banner(severity: severity(b.severity), title: b.title, message: b.body ?? "",
                       actionTitle: b.url != nil ? s["adLearnMore"] : nil,
                       action: b.url != nil ? { NSWorkspace.shared.openHttps(b.url) } : nil,
                       onClose: { app.engagement.broadcasts.removeAll { $0.id == b.id } })
            }
            if app.updates.required {
                UpdateRequiredBanner()
            }
            if app.notificationsBlocked && !notificationsHidden {
                Banner(severity: .warning, title: s["windowsNotificationsOff"], message: s["windowsNotificationsOffBody"],
                       actionTitle: s["openWindowsSettings"],
                       action: {
                           if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
                       },
                       onClose: { notificationsHidden = true })
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, hasAny ? 8 : 0)
        .animation(.smooth, value: app.engagement.broadcasts.count)
    }

    private var hasAny: Bool {
        !app.engagement.announcements.isEmpty || !app.engagement.broadcasts.isEmpty || app.updates.required || (app.notificationsBlocked && !notificationsHidden)
    }

    private func severity(_ s: String?) -> Banner.Severity {
        switch s {
        case "success": return .success
        case "warning": return .warning
        case "critical": return .error
        default: return .info
        }
    }
}

/// This build may not keep running: too old, or withdrawn by the platform.
/// It cannot be closed; it offers Sparkle's check, or the platform's
/// download page where Sparkle is not available.
struct UpdateRequiredBanner: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let updates = app.updates
        let blocked = updates.requirement == .blocked
        let canCheck = updates.status != .unavailable
        let download = canCheck ? nil : updates.downloadUrl
        Banner(severity: .error,
               title: s[blocked ? "updateBlockedTitle" : "updateRequiredTitle"],
               message: s[blocked ? "updateBlockedBody" : "updateRequiredBody"],
               actionTitle: canCheck ? s["checkForUpdates"] : (download != nil ? s["download"] : nil),
               action: { if canCheck { updates.checkForUpdates() } else { NSWorkspace.shared.openHttps(download) } })
    }
}

/// A call waiting in the call center, from anywhere in the app: who, and
/// answer / decline / open the desk. Rings like a phone for 45 seconds.
struct IncomingCallCard: View {
    @Environment(AppModel.self) private var app
    @State private var busy = false
    @State private var pulse = false

    var body: some View {
        if let entry = app.ringing {
            let s = app.strings
            let c = entry.callSession
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    AvatarView(name: c?.visitorName, email: c?.visitorEmail, size: 44)
                        .overlay(Circle().stroke(Palette.success.opacity(pulse ? 0 : 0.7), lineWidth: pulse ? 12 : 2).scaleEffect(pulse ? 1.5 : 1))
                    VStack(alignment: .leading, spacing: 2) {
                        Label(s[entry.isVideo ? "incomingVideoCall" : "incomingVoiceCall"], systemImage: entry.isVideo ? "video.fill" : "phone.fill")
                            .appFont(11.5, .semibold)
                            .foregroundStyle(Palette.success)
                        Text(CallNames.caller(entry, s)).appFont(15, .semibold).lineLimit(1)
                        let meta = [c?.visitorPhone, c?.visitorEmail, c?.pageTitle].compactMap { $0 }.filter { !$0.isEmpty }
                        if !meta.isEmpty { Text(Array(NSOrderedSet(array: meta)).compactMap { $0 as? String }.joined(separator: " · ")).appFont(11.5).foregroundStyle(Palette.text2).lineLimit(1) }
                    }
                }
                GlassGroup(spacing: 8) {
                    HStack(spacing: 8) {
                        Button(s["callOpenDesk"]) { app.openCall(entry.callSessionId, answer: false) }
                            .glassButton()
                        Spacer(minLength: 8)
                        Button {
                            busy = true
                            Task { await app.rejectRinging(); busy = false }
                        } label: { Label(s["ccReject"], systemImage: "phone.down.fill") }
                            .prominentButton(tint: Palette.danger)
                        Button { app.openCall(entry.callSessionId, answer: true) } label: { Label(s["callAnswer"], systemImage: "phone.fill") }
                            .prominentButton(tint: Palette.success)
                    }
                    .disabled(busy)
                }
            }
            .padding(16)
            .frame(width: 380)
            .glassCard(22, tint: Palette.success.opacity(0.10))
            .shadow(color: .black.opacity(0.18), radius: 24, y: 10)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .onAppear { withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { pulse = true } }
        }
    }
}
