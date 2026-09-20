import UIKit
import UserNotifications

/// Registers the notification categories whose ids the backend attaches to a
/// push payload (`aps.category`).
///
/// The action buttons on a banner come from the OS, not from the payload: iOS
/// only shows them when a category with that id was registered by THIS app at
/// launch. The ids here are the shipped set in
/// `server/services/push/platformSettings.ts` — an operator can retune the
/// copy and which events use a category in Super Admin, but an id that exists
/// on only one side simply produces a banner with no buttons, never a crash.
///
/// Titles are localized through `Localizable.strings` when a translation
/// exists and fall back to English otherwise, so a build without the
/// localization still shows a readable button rather than a raw key.
enum NotificationCategories {

    static func register() {
        let reply = UNTextInputNotificationAction(
            identifier: "REPLY",
            title: localized("push.action.reply", fallback: "Reply"),
            // Foreground: the app sends the typed reply once it resumes. See
            // performNotificationAction() in src/lib/push/nativePush.ts.
            options: [.foreground],
            textInputButtonTitle: localized("push.action.send", fallback: "Send"),
            textInputPlaceholder: localized("push.action.replyPlaceholder", fallback: "Reply…")
        )

        let markRead = UNNotificationAction(
            identifier: "MARK_READ",
            title: localized("push.action.markRead", fallback: "Mark as read"),
            options: []
        )

        let open = UNNotificationAction(
            identifier: "OPEN",
            title: localized("push.action.open", fallback: "Open"),
            options: [.foreground]
        )

        let message = UNNotificationCategory(
            identifier: "WEBYAR_MESSAGE",
            actions: [reply, markRead],
            intentIdentifiers: [],
            options: []
        )

        let mention = UNNotificationCategory(
            identifier: "WEBYAR_MENTION",
            actions: [open],
            intentIdentifiers: [],
            options: []
        )

        UNUserNotificationCenter.current().setNotificationCategories([message, mention])
    }

    private static func localized(_ key: String, fallback: String) -> String {
        let value = NSLocalizedString(key, comment: "")
        return value == key ? fallback : value
    }
}
