import SwiftUI

/// The menu bar item's icon: the unread count beside it, like Mail's Dock badge.
struct MenuBarLabel: View {
    let app: AppModel

    var body: some View {
        let waiting = app.callQueue?.queue.count ?? 0
        HStack(spacing: 3) {
            Image(systemName: waiting > 0 ? "phone.arrow.down.left.fill" : (app.unread > 0 ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right"))
            if app.unread > 0 { Text(app.unread > 99 ? "99+" : String(app.unread)) }
        }
    }
}

/// What the menu bar item offers: open the window, the unread and waiting
/// counts, the operator's status, and quit — the Windows app's tray menu, and
/// more — with a line on top while the platform is under maintenance.
struct MenuBarContent: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let s = app.strings
        if app.config.maintenance.enabled {
            Label(s["maintenanceMenuLine"], systemImage: "wrench.and.screwdriver")
            Divider()
        }
        Button(s["trayOpen"]) { show() }
        Divider()
        Text(s.get("menuUnread", "count", app.unread))
        if app.plan.callCenter {
            Button(s.get("menuWaitingCalls", "count", app.callQueue?.queue.count ?? 0)) {
                show()
                app.route = .calls
            }
        }
        if let presence = app.presence {
            Divider()
            Text(s["statusHeader"])
            Toggle(s["statusOnlineForVisitors"], isOn: Binding(get: { !presence.isInvisible }, set: { on in Task { _ = await app.setInvisible(!on) } }))
            Toggle(s["statusInvisible"], isOn: Binding(get: { presence.isInvisible }, set: { on in Task { _ = await app.setInvisible(on) } }))
        }
        Divider()
        SettingsLink { Text(s["tabSettings"] + "…") }
        Button(s["trayQuit"]) { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private func show() {
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }
}
