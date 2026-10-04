import UserNotifications

/// What the app needs from a notification, read off it where iOS hands it
/// over.
///
/// `UNNotification` and `UNNotificationResponse` are not `Sendable`, and the
/// notification centre calls its delegate from outside the main actor. So the
/// objects stay where they arrive — `AppDelegate`'s nonisolated methods — and
/// only these plain values cross to `PushController`, which is main-actor.
struct PushArrival: Sendable, Equatable {
    /// Where the notification wants to take the operator, if anywhere.
    let target: PushTarget?
    /// The message it announces, when the payload names one: an open thread
    /// that already has it (realtime was faster) skips the read.
    let messageID: String?
    /// The mailbox provider of an email notification.
    let provider: String?

    init(_ content: UNNotificationContent) {
        self.init(userInfo: content.userInfo)
    }

    init(userInfo: [AnyHashable: Any]) {
        target = PushTarget(userInfo: userInfo)
        messageID = userInfo["messageId"] as? String
        provider = userInfo["provider"] as? String
    }
}

/// A tap on a notification, or one of its buttons.
struct PushResponse: Sendable, Equatable {
    let arrival: PushArrival
    /// `UNNotificationDefaultActionIdentifier` for a plain tap, otherwise the
    /// category action's identifier ("MARK_READ", "REPLY").
    let actionIdentifier: String
    /// What was typed into the Reply action, as typed; nil for any other.
    let typedText: String?
    /// The notification's own identifier: a reply's idempotency key is
    /// derived from it, so the same reply replayed is the same message.
    let notificationID: String

    init(_ response: UNNotificationResponse) {
        arrival = PushArrival(response.notification.request.content)
        actionIdentifier = response.actionIdentifier
        typedText = (response as? UNTextInputNotificationResponse)?.userText
        notificationID = response.notification.request.identifier
    }
}
