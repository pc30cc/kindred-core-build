import AppKit
import SwiftUI

// MARK: - Account

/// Who is signed in, as Windows Settings opens with the user; their status
/// for visitors (the web console's "invisible mode", `force_offline`); and
/// the settings page's campaign.
struct AccountSettingsTab: View {
    @Environment(AppModel.self) private var app
    @State private var confirmSignOut = false
    @State private var changingStatus = false
    @State private var statusError: String?

    var body: some View {
        let s = app.strings
        Form {
            Section {
                accountRow
            } header: {
                SettingsHeader(s["settingsAccount"])
            } footer: {
                CampaignCard(placement: "settings")
                    .padding(.top, 8)
            }
            if let presence = app.presence {
                Section {
                    statusPicker(presence)
                } header: {
                    SettingsHeader(s["menuStatus"])
                }
            }
        }
        .settingsForm(height: app.engagement.ad(for: "settings") != nil ? 460 : 320)
        .alert(s["signOut"], isPresented: $confirmSignOut) {
            Button(s["signOut"], role: .destructive) {
                Task { await app.signOut() }
            }
            Button(s["cancel"], role: .cancel) {}
        } message: {
            Text(s["signOutConfirm"])
        }
        .alert(s["statusChangeFailed"], isPresented: statusErrorShown) {
            Button(s["ok"], role: .cancel) {}
        } message: {
            Text(statusError ?? "")
        }
    }

    private var name: String {
        if let n = app.account?.profile?.fullName, !n.isEmpty { return n }
        return app.user?.fullName ?? ""
    }

    private var email: String { app.user?.email ?? "" }

    /// Presence as teammates see it, and "Invisible" beside it when visitors do not.
    private var presenceText: String {
        let label = app.presenceLabel(app.myState)
        if app.presence?.isInvisible == true { return "\(label) · \(app.strings["statusInvisible"])" }
        return label
    }

    private var accountRow: some View {
        HStack(spacing: 16) {
            AvatarView(name: name.isEmpty ? email : name, email: email, imageURL: app.account?.avatarUrl,
                       size: 60, kind: .operator, presence: app.myState)
            VStack(alignment: .leading, spacing: 2) {
                if !name.isEmpty {
                    Text(name).appFont(17, .semibold).lineLimit(1).truncationMode(.tail)
                }
                if !email.isEmpty {
                    Text(email).appFont(12.5).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        .textSelection(.enabled)
                }
                if let ws = app.workspace?.name, !ws.isEmpty {
                    Text(ws).appFont(11.5).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.tail)
                }
                presenceLine
            }
            Spacer(minLength: 8)
            Button(app.strings["signOut"]) { confirmSignOut = true }
                .frame(minWidth: 110)
                .glassButton()
        }
        .padding(.vertical, 6)
    }

    private var presenceLine: some View {
        HStack(spacing: 5) {
            Circle().fill(Palette.dot(app.myState).fill).frame(width: 7, height: 7)
            Text(presenceText).appFont(11.5).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(.top, 2)
    }

    private func statusBinding(_ presence: PresenceService) -> Binding<Bool> {
        Binding<Bool>(get: { presence.isInvisible }, set: { invisible in setInvisible(invisible) })
    }

    private func statusPicker(_ presence: PresenceService) -> some View {
        let s = app.strings
        let invisible = presence.isInvisible
        return Picker(selection: statusBinding(presence)) {
            Text(s["statusOnlineForVisitors"]).appFont(13).tag(false)
            Text(s["statusInvisible"]).appFont(13).tag(true)
        } label: {
            SettingLabel(title: s["statusHeader"],
                         hint: invisible ? s["statusInvisibleHint"] : s["statusOnlineHint"],
                         systemImage: invisible ? "eye.slash" : "eye")
        }
        .pickerStyle(.radioGroup)
        .disabled(changingStatus)
    }

    private func setInvisible(_ invisible: Bool) {
        guard !changingStatus else { return }
        changingStatus = true
        Task {
            let error = await app.setInvisible(invisible)
            changingStatus = false
            statusError = error
        }
    }

    private var statusErrorShown: Binding<Bool> {
        Binding<Bool>(get: { statusError != nil }, set: { shown in if !shown { statusError = nil } })
    }
}

// MARK: - Notifications

/// Notifications on this Mac and their sound. What the operator is notified
/// about is their account setting, shared with the web console.
struct NotificationSettingsTab: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        Form {
            if app.notificationsBlocked {
                Section {
                    Banner(severity: .warning, title: s["windowsNotificationsOff"], message: s["windowsNotificationsOffBody"],
                           actionTitle: s["openWindowsSettings"], action: { openSystemSettings() })
                }
            }
            Section {
                Toggle(isOn: notificationsBinding) {
                    SettingLabel(title: s["desktopNotifications"], hint: s["desktopNotificationsHint"], systemImage: "bell.badge")
                }
                .toggleStyle(.switch)
                Toggle(isOn: soundBinding) {
                    SettingLabel(title: s["notificationSoundLocal"], systemImage: "speaker.wave.2")
                }
                .toggleStyle(.switch)
                systemSettingsRow
            } header: {
                SettingsHeader(s["notifications"])
            }
        }
        .settingsForm(height: app.notificationsBlocked ? 400 : 290)
    }

    private var notificationsBinding: Binding<Bool> {
        Binding<Bool>(
            get: { app.settings.notifications },
            set: { on in
                app.settings.notifications = on
                app.saveSettings()
                // Turning them on asks macOS for permission if it has not been asked yet.
                if on { app.notifier.register() }
                Task { await app.refreshNotificationPermission() }
            })
    }

    private var soundBinding: Binding<Bool> {
        Binding<Bool>(
            get: { app.settings.notificationSound },
            set: { on in
                app.settings.notificationSound = on
                app.saveSettings()
            })
    }

    /// System Settings → Notifications, where macOS keeps whether Webyar may show them at all.
    private var systemSettingsRow: some View {
        Button {
            openSystemSettings()
        } label: {
            HStack {
                SettingLabel(title: app.strings["openWindowsSettings"], hint: app.strings["notificationsServerFooter"], systemImage: "gear")
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.forward").foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func openSystemSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }
}

// MARK: - Desktop

/// Opening at login, staying in the menu bar when the window closes, and the menu bar item.
struct DesktopSettingsTab: View {
    @Environment(AppModel.self) private var app
    /// macOS's own login items are the truth; read again whenever the tab shows.
    @State private var openAtLogin = LoginItem.isEnabled

    var body: some View {
        let s = app.strings
        Form {
            Section {
                Toggle(isOn: loginBinding) {
                    SettingLabel(title: s["startWithWindows"], hint: s["startWithWindowsHint"], systemImage: "power")
                }
                .toggleStyle(.switch)
                Toggle(isOn: closeBinding) {
                    SettingLabel(title: s["closeToTray"], hint: s["closeToTrayHint"], systemImage: "menubar.arrow.up.rectangle")
                }
                .toggleStyle(.switch)
                Toggle(isOn: menuBarBinding) {
                    SettingLabel(title: s["menuBarItem"], hint: s["menuBarItemHint"], systemImage: "menubar.rectangle")
                }
                .toggleStyle(.switch)
            } header: {
                SettingsHeader(s["desktop"])
            }
        }
        .settingsForm(height: 290)
        .onAppear { openAtLogin = LoginItem.isEnabled }
    }

    private var loginBinding: Binding<Bool> {
        Binding<Bool>(
            get: { openAtLogin },
            set: { on in
                LoginItem.set(on)
                // A refusal (or a pending approval) leaves the switch where macOS has it.
                openAtLogin = LoginItem.isEnabled
            })
    }

    private var closeBinding: Binding<Bool> {
        Binding<Bool>(
            get: { app.settings.closeToMenuBar },
            set: { on in
                app.settings.closeToMenuBar = on
                app.saveSettings()
            })
    }

    private var menuBarBinding: Binding<Bool> {
        Binding<Bool>(
            get: { app.settings.menuBarItem },
            set: { on in
                app.settings.menuBarItem = on
                app.saveSettings()
            })
    }
}

// MARK: - Updates

/// This build's version and a manual check. Sparkle shows its own progress
/// and "install and relaunch" window, so there is no status line here.
struct UpdateSettingsTab: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        Form {
            Section {
                versionRow
                if app.updates.required {
                    Banner(severity: .error, title: s["updateRequiredTitle"], message: s["updateRequiredBody"])
                }
            } header: {
                SettingsHeader(s["updates"])
            }
        }
        .settingsForm(height: app.updates.required ? 260 : 170)
    }

    private var unavailable: Bool { app.updates.status == .unavailable }

    private var versionRow: some View {
        let s = app.strings
        return HStack {
            SettingLabel(title: "\(s["version"]) \(Digits.localize(AppModel.version, s.language))",
                         hint: unavailable ? s["updatesUnavailable"] : nil,
                         systemImage: "shippingbox")
            Spacer(minLength: 8)
            if !unavailable {
                Button(s["checkForUpdates"]) { app.updates.checkForUpdates() }
                    .frame(minWidth: 110)
                    .glassButton()
            }
        }
    }
}

// MARK: - Storage

/// Where downloaded files live, and a way to free the space.
struct StorageSettingsTab: View {
    private struct Usage: Sendable {
        var bytes: Int64
        var count: Int
    }

    @Environment(AppModel.self) private var app
    @State private var usage: Usage?
    @State private var clearing = false
    @State private var cleared = false
    @State private var confirmClear = false

    var body: some View {
        let s = app.strings
        Form {
            Section {
                sizeRow
                folderRow
                clearRow
            } header: {
                SettingsHeader(s["storage"])
            }
        }
        .settingsForm(height: 340)
        .task { await measure() }
        .alert(s["clearCache"], isPresented: $confirmClear) {
            Button(s["clearCache"], role: .destructive) {
                Task { await clear() }
            }
            Button(s["cancel"], role: .cancel) {}
        } message: {
            Text(s["clearCacheConfirm"])
        }
    }

    private var sizeRow: some View {
        let s = app.strings
        return LabeledContent {
            if let usage {
                Text(Display.fileSize(usage.bytes, s)).appFont(13, .semibold)
            } else {
                ProgressView().controlSize(.small)
            }
        } label: {
            SettingLabel(title: s["fileCache"], hint: s["fileCacheHint"], systemImage: "internaldrive")
        }
    }

    private var folderRow: some View {
        let s = app.strings
        let path = FileCache.folder.path
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                SettingLabel(title: s["fileCacheFolder"], systemImage: "folder")
                Spacer(minLength: 8)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(path, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .glassButton()
                .help(s["copyPath"])
                Button(s["openFolder"]) {
                    NSWorkspace.shared.activateFileViewerSelecting([FileCache.folder])
                }
                .frame(minWidth: 110)
                .glassButton()
            }
            // A path reads left to right in every language.
            Text(path)
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .environment(\.layoutDirection, .leftToRight)
        }
    }

    private var clearRow: some View {
        let s = app.strings
        return HStack {
            SettingLabel(title: s["clearCache"], hint: cleared ? s["cacheCleared"] : s["clearCacheHint"], systemImage: "trash")
            Spacer(minLength: 8)
            Button(s["clearCache"], role: .destructive) { confirmClear = true }
                .frame(minWidth: 110)
                .glassButton()
                .disabled(clearing || (usage?.count ?? 0) == 0)
        }
    }

    private func measure() async {
        let result = await Task.detached(priority: .utility) { () -> Usage in
            let m = FileCache.measure()
            return Usage(bytes: m.bytes, count: m.count)
        }.value
        usage = result
    }

    private func clear() async {
        clearing = true
        await Task.detached(priority: .userInitiated) { FileCache.clear() }.value
        AttachmentStore.shared.clearMemory()
        await measure()
        clearing = false
        cleared = true
    }
}
