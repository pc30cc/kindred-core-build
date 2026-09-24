import AppKit
import UserNotifications

/// Native macOS notifications through the UserNotifications framework. A
/// click brings the window forward and opens what the notification is about
/// (a conversation, or a page such as the call center).
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    /// Called with the arguments the notification was created with.
    var onOpen: (([String: String]) -> Void)?

    private(set) var authorized: Bool?
    /// macOS has been asked for permission this run.
    private(set) var asked = false

    /// Takes the clicks on this app's notifications and, unless told not to,
    /// asks macOS for permission to show them.
    func register(askPermission: Bool = true) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        guard askPermission else { return }
        asked = true
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error { Log.error("notification permission", error) }
            Task { @MainActor in self.authorized = granted }
        }
    }

    /// Whether macOS is showing this app's notifications at all.
    func refreshAuthorization() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let ok = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        authorized = ok
        return ok
    }

    func show(title: String, body: String, silent: Bool, arguments: [String: String]) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.userInfo = arguments
        if !silent { content.sound = .default }
        if let conversation = arguments["conversation"] { content.threadIdentifier = conversation }
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { Log.error("show notification", error) }
        }
    }

    /// Takes down what is already in Notification Center, when the platform turns notifications off.
    func clearDelivered() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    /// The Dock icon's red badge: unread visitor messages.
    func setBadge(_ count: Int) {
        NSApp.dockTile.badgeLabel = count > 0 ? (count > 99 ? "99+" : String(count)) : nil
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        var args: [String: String] = [:]
        for (k, v) in info { if let k = k as? String, let v = v as? String { args[k] = v } }
        await MainActor.run { self.onOpen?(args) }
    }
}
