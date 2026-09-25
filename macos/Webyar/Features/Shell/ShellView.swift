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
                        .navigationSplitViewColumnWidth(min: 210, ideal: 240, max: 300)
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
    let analytics: AnalyticsModel

    init(app: AppModel) {
        inbox = InboxModel(app: app)
        contacts = ContactsModel(app: app)
        visitors = VisitorsModel(app: app)
        calls = CallCenterModel(app: app)
        colleagues = ColleaguesModel(app: app)
        email = EmailModel(app: app)
        analytics = AnalyticsModel(app: app)
    }

    func stop() {
        inbox.stop()
        contacts.stop()
        visitors.stop()
        calls.stop()
        colleagues.stop()
        email.stop()
        analytics.stop()
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
        case .analytics: AnalyticsList(model: pages.analytics)
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
        case .analytics: AnalyticsDetail(model: pages.analytics)
        }
    }
}

// MARK: - Sidebar

/// The sidebar in two tiers, so where one is reads at a glance: the sections
/// (inbox, colleagues, contacts, visitors, call center) each on a coloured
/// tile in semibold, and the inbox's pages — its queues, email and the other
/// channels — folded under it, indented and lighter. A folded section
/// shows its unread count on itself.
struct SidebarView: View {
    @Environment(AppModel.self) private var app
    @AppStorage("sidebarInboxOpen") private var inboxOpen = true

    var body: some View {
        @Bindable var app = app
        let s = app.strings
        let plan = app.plan
        List(selection: Binding(get: { app.route }, set: { if let r = $0 { app.route = r } })) {
            Section {
                DisclosureGroup(isExpanded: $inboxOpen) {
                    sub(.inbox(.open), s["navInboxOpen"], "bubble.left.and.bubble.right", badge: app.unread, color: Palette.brand)
                    if plan.aiQueue(automated: app.counts.automated) {
                        sub(.inbox(.ai), s["navInboxAi"], "sparkles", badge: app.counts.automated ?? 0, color: Palette.ai)
                    }
                    if plan.needsHumanQueue {
                        sub(.inbox(.needsHuman), s["navInboxNeedsHuman"], "person.fill.questionmark", badge: app.counts.needsHuman ?? 0, color: Palette.danger)
                    }
                    sub(.inbox(.pending), s["navInboxPending"], "clock", badge: 0, color: Palette.brand)
                    sub(.inbox(.resolved), s["navInboxResolved"], "checkmark.circle", badge: 0, color: Palette.brand)
                    sub(.inbox(.spam), s["navInboxSpam"], "xmark.bin", badge: app.counts.spam ?? 0, color: Palette.text3)
                    if plan.emailInbox { sub(.email, s["emailInbox"], "envelope", badge: 0, color: Palette.brand) }
                    // The other inboxes (Telegram, WhatsApp, …) are pages of the inbox too.
                    if plan.isAdmin {
                        ForEach(app.channels.filter { plan.channelInbox($0) }, id: \.self) { key in
                            sub(.channel(key), Display.channelLabel(key, s), channelIcon(key), badge: 0, color: Palette.brand)
                        }
                    }
                } label: {
                    heading(s["tabInbox"], "tray.full.fill", tint: Palette.brand, badge: inboxOpen ? 0 : app.unread, open: $inboxOpen)
                }
                if plan.teamChat {
                    section(.colleagues, s["navColleagues"], "person.2.fill", tint: Color(hex: 0x0EA5A4), badge: 0, color: Palette.brand)
                }
            }
            Section {
                if plan.contacts {
                    section(.contacts, s["tabContacts"], "person.crop.rectangle.stack.fill", tint: Color(hex: 0xF76B15), badge: 0, color: Palette.brand)
                }
                if plan.visitors {
                    section(.visitors, s["navVisitors"], "globe", tint: Color(hex: 0x30A46C), badge: app.visitorsOnline, color: Palette.success)
                }
                if plan.webAnalytics {
                    section(.analytics, s["navAnalytics"], "chart.bar.xaxis", tint: Color(hex: 0x0091FF), badge: 0, color: Palette.brand)
                }
                if plan.callCenter {
                    section(.calls, s["navCallCenter"], "phone.fill", tint: Color(hex: 0xE5484D), badge: app.callQueue?.queue.count ?? 0, color: Palette.danger)
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) { WorkspaceHeader().padding(.horizontal, 10).padding(.bottom, 6) }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                // The call, while the operator is on a page other than its own.
                CallBar()
                AccountCorner()
            }
            .padding(8)
            .animation(.smooth(duration: 0.3), value: CallCoordinator.shared.showsCallBar)
        }
    }

    /// A section of the app: its own page.
    private func section(_ route: Route, _ title: String, _ icon: String, tint: Color, badge: Int, color: Color) -> some View {
        SidebarSection(title: title, icon: icon, tint: tint, badge: badge, color: color)
            .tag(route)
    }

    /// A section that folds its pages under it; the whole row opens and closes it.
    private func heading(_ title: String, _ icon: String, tint: Color, badge: Int, open: Binding<Bool>) -> some View {
        SidebarSection(title: title, icon: icon, tint: tint, badge: badge, color: Palette.brand)
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.smooth(duration: 0.2)) { open.wrappedValue.toggle() } }
    }

    /// A page inside a section: a queue of the inbox, or a channel.
    private func sub(_ route: Route, _ title: String, _ icon: String, badge: Int, color: Color) -> some View {
        HStack(spacing: 9) {
            Image(systemName: icon)
                .font(.system(size: 11.5, weight: .medium))
                .frame(width: 18)
                .foregroundStyle(.secondary)
            Text(title).appFont(12.5).lineLimit(1)
            Spacer(minLength: 6)
            CountBadge(count: badge, color: color)
        }
        .padding(.vertical, 1)
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

/// A section's row: its icon on a coloured tile, its name in semibold.
private struct SidebarSection: View {
    let title: String
    let icon: String
    let tint: Color
    let badge: Int
    let color: Color

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 24, height: 24)
                .background(
                    LinearGradient(colors: [tint.opacity(0.92), tint], startPoint: .top, endPoint: .bottom),
                    in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                )
                .shadow(color: tint.opacity(0.28), radius: 2, y: 1)
            Text(title).appFont(13.5, .semibold).lineLimit(1).minimumScaleFactor(0.85)
            Spacer(minLength: 6)
            CountBadge(count: badge, color: color)
        }
        .padding(.vertical, 3)
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
        // Whatever link the server gives (the provider's CDN or a path on the API), resolved as every picture is.
        if let url = app.workspace?.logoUrl, let u = app.client.absolute(url) {
            RemoteImage(url: u) { Image("BrandMark").resizable() }
        } else {
            Image("BrandMark").resizable()
        }
    }
}

/// The account: photo, name, and presence as teammates see it. It opens a card
/// drawn here rather than a system menu, so it reads right to left in Persian
/// like the rest of the window: status, workspaces, settings, sign out.
struct AccountCorner: View {
    @Environment(AppModel.self) private var app
    @State private var open = false
    @State private var confirmSignOut = false
    @State private var statusError: String?

    var body: some View {
        let s = app.strings
        Button { open.toggle() } label: {
            HStack(spacing: 10) {
                AvatarView(name: app.myName, imageURL: app.account?.avatarUrl, size: 30, kind: .operator, presence: app.myState, faceless: true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(app.myName).appFont(12.5, .semibold).lineLimit(1)
                    Text(statusLine).appFont(11).foregroundStyle(Palette.text2).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.text3)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .glassCard(12, interactive: true)
        .help(app.workspace.map { "\(app.myName) — \($0.name)" } ?? app.myName)
        .popover(isPresented: $open, arrowEdge: .top) {
            AccountMenu(close: { open = false },
                        signOut: { open = false; confirmSignOut = true },
                        setInvisible: setInvisible,
                        scheduleOff: scheduleOff)
                // A popover is a window of its own: set the reading direction again, and
                // a solid card rather than the popover's see-through material.
                .environment(\.layoutDirection, s.isRightToLeft ? .rightToLeft : .leftToRight)
                .background(Palette.surface)
                .presentationBackground(Palette.surface)
        }
        #if DEBUG
        // DebugTools' `account`: opens the card as a click would.
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("WebyarDebugAccount"))) { _ in open.toggle() }
        #endif
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

    private var statusLine: String { app.myStatusLine }

    private func setInvisible(_ on: Bool) {
        Task { statusError = await app.setInvisible(on) }
    }

    private func scheduleOff() {
        Task { statusError = await app.turnScheduleOff() }
    }
}

/// The account card: who, how visitors see them, the workspaces, settings and sign out.
private struct AccountMenu: View {
    let close: () -> Void
    let signOut: () -> Void
    let setInvisible: (Bool) -> Void
    let scheduleOff: () -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                AvatarView(name: app.myName, imageURL: app.account?.avatarUrl, size: 40, kind: .operator, presence: app.myState, faceless: true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.myName).appFont(14, .bold).lineLimit(1)
                    if let email = app.user?.email {
                        Text(verbatim: email).appFont(11.5).foregroundStyle(Palette.text2).lineLimit(1)
                    }
                    Text(app.myStatusLine).appFont(11).foregroundStyle(presenceColor).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            Divider()
            if let presence = app.presence {
                heading(s["statusHeader"])
                if presence.offScheduleReason != nil {
                    // Not invisible, yet offline: the weekly schedule says so. Say it, and offer the way out.
                    VStack(alignment: .leading, spacing: 8) {
                        Label(s["scheduleOfflineNote"], systemImage: "clock.badge.exclamationmark")
                            .appFont(11.5)
                            .foregroundStyle(Palette.warning)
                            .fixedSize(horizontal: false, vertical: true)
                        Button(s["scheduleOffAction"], action: scheduleOff)
                            .controlSize(.small)
                            .prominentButton(tint: Palette.warning)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.warningSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                }
                AccountMenuRow(title: s["statusOnlineForVisitors"], icon: "circle.fill",
                               tint: presence.offScheduleReason == nil ? Palette.success : Palette.text3, checked: !presence.isInvisible) {
                    setInvisible(false)
                }
                AccountMenuRow(title: s["statusInvisible"], icon: "eye.slash", tint: Palette.text2, checked: presence.isInvisible) {
                    setInvisible(true)
                }
                .help(s["statusInvisibleHint"])
                Divider().padding(.vertical, 4)
            }
            if app.workspaces.count > 1 {
                heading(s["workspace"])
                ForEach(app.workspaces) { w in
                    AccountMenuRow(title: w.name.isEmpty ? (w.slug ?? w.id) : w.name, icon: "building.2", tint: Palette.text2,
                                   checked: w.id == app.workspace?.id) {
                        close()
                        Task { await app.switchWorkspace(w) }
                    }
                }
                Divider().padding(.vertical, 4)
            }
            SettingsLink {
                AccountMenuRowLabel(title: s["tabSettings"], icon: "gearshape", tint: Palette.text2, checked: false)
            }
            .buttonStyle(AccountMenuRowStyle())
            .simultaneousGesture(TapGesture().onEnded { close() })
            AccountMenuRow(title: s["signOut"], icon: "rectangle.portrait.and.arrow.right", tint: Palette.danger, checked: false,
                           textTint: Palette.danger, action: signOut)
                .padding(.bottom, 6)
        }
        .frame(width: 270)
    }

    private var presenceColor: Color {
        if app.presence?.offScheduleReason != nil { return Palette.warning }
        switch app.myState {
        case PresenceState.active: return Palette.success
        case PresenceState.away: return Palette.warning
        default: return Palette.text3
        }
    }

    private func heading(_ text: String) -> some View {
        Text(text)
            .appFont(11, .semibold)
            .foregroundStyle(Palette.text3)
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 2)
    }
}

private struct AccountMenuRow: View {
    let title: String
    let icon: String
    let tint: Color
    let checked: Bool
    var textTint: Color? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            AccountMenuRowLabel(title: title, icon: icon, tint: tint, checked: checked, textTint: textTint)
        }
        .buttonStyle(AccountMenuRowStyle())
    }
}

private struct AccountMenuRowLabel: View {
    let title: String
    let icon: String
    let tint: Color
    let checked: Bool
    var textTint: Color? = nil

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: icon == "circle.fill" ? 8 : 13, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 20)
            Text(title).appFont(13).foregroundStyle(textTint ?? Palette.text).lineLimit(1)
            Spacer(minLength: 8)
            if checked {
                Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.brand)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
    }
}

/// A row that lights up under the pointer, as a menu item does.
private struct AccountMenuRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Lit(label: configuration.label, pressed: configuration.isPressed)
    }

    private struct Lit<Label: View>: View {
        let label: Label
        let pressed: Bool
        @State private var hovering = false

        var body: some View {
            label
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(pressed ? Palette.selected : hovering ? Palette.hover : Color.clear)
                )
                .padding(.horizontal, 6)
                .onHover { hovering = $0 }
        }
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

    var body: some View {
        VStack(alignment: .trailing, spacing: 12) {
            HandedCallCard()
            ringingCard
        }
    }

    @ViewBuilder private var ringingCard: some View {
        if let entry = app.ringing {
            let s = app.strings
            let c = entry.callSession
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    CallerAvatar(call: c, sessionId: entry.visitorSessionId, size: 44)
                        .overlay(RingPulse())
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
        }
    }
}

/// A ring spreading from the caller's face every 1.2 s — clock-driven, so the repeating
/// animation never catches the card sliding in (see CallPulse in the call window).
private struct RingPulse: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            // 0 → 1 every 1.2 s, eased out.
            let x = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2
            let p = 1 - (1 - x) * (1 - x)
            Circle()
                .stroke(Palette.success.opacity(0.7 * (1 - p)), lineWidth: 2 + 10 * p)
                .scaleEffect(1 + 0.5 * p)
        }
        .allowsHitTesting(false)
    }
}

/// A call a colleague handed over: who it is, from whom and why, and a button to join it.
private struct HandedCallCard: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let c = app.handedCall {
            let s = app.strings
            let from = c.transferFromAgentId.map { app.memberName($0) } ?? ""
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    CallerAvatar(call: c, size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Label(s["callHandedTitle"], systemImage: "arrow.left.arrow.right")
                            .appFont(11.5, .semibold)
                            .foregroundStyle(Palette.brand)
                        Text(CallNames.caller(c, fallbackId: c.contactId ?? c.visitorSessionId ?? c.id, s))
                            .appFont(15, .semibold)
                            .lineLimit(1)
                        let meta = [from.isEmpty ? nil : s.get("callHandedFrom", "name", from), c.transferReason]
                            .compactMap { $0 }.filter { !$0.isEmpty }
                        if !meta.isEmpty {
                            Text(meta.joined(separator: " · ")).appFont(11.5).foregroundStyle(Palette.text2).lineLimit(2)
                        }
                    }
                }
                if let error = app.handedCallError {
                    Text(error).appFont(11.5).foregroundStyle(Palette.danger).lineLimit(3)
                }
                GlassGroup(spacing: 8) {
                    HStack(spacing: 8) {
                        Button(s["close"]) { app.dismissHandedCall() }
                            .glassButton()
                        Spacer(minLength: 8)
                        Button {
                            Task { await app.joinHandedCall() }
                        } label: {
                            Label(s["callJoin"], systemImage: c.isVideo ? "video.fill" : "phone.fill")
                        }
                        .prominentButton(tint: Palette.success)
                        .disabled(app.joiningHandedCall)
                    }
                }
            }
            .padding(16)
            .frame(width: 380)
            .glassCard(22, tint: Palette.brand.opacity(0.10))
            .shadow(color: .black.opacity(0.18), radius: 24, y: 10)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
