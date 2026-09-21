import UIKit
import UserNotifications

/// The one thing SwiftUI cannot do on its own.
///
/// Remote notifications are delivered through `UIApplicationDelegate` and
/// `UNUserNotificationCenterDelegate` and there is no SwiftUI equivalent: the
/// device token arrives at `didRegisterForRemoteNotifications`, and a tapped
/// banner arrives at `didReceive response` whether the app was running, in the
/// background, or not launched at all. `@UIApplicationDelegateAdaptor` in
/// `WebyarApp` is what puts this in the responder chain.
///
/// Everything it receives is handed straight to `PushController`. The delegate
/// is deliberately thin, because it runs in situations SwiftUI is not ready
/// for yet — a tap that launches the app cold arrives before there is a
/// window, let alone a navigation stack — so nothing here navigates or draws.
/// It records what was asked for; the inbox acts on it when it exists.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set here rather than later: iOS delivers a notification that
        // launched the app as soon as the delegate exists, and a centre with
        // no delegate at that moment drops it.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    // MARK: - The address

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { await PushController.shared.adopt(deviceToken: deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in PushController.shared.registrationFailed(error) }
    }

    // MARK: - Arrival

    /// A notification that arrives while the operator is looking at the app.
    ///
    /// iOS shows nothing by default here, which is the wrong answer for an
    /// inbox: an operator reading one thread still needs to know another
    /// customer has written. The one exception is the thread they are already
    /// in, where the banner would cover the message it is announcing.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        await PushController.shared.presentation(for: notification.request.content)
    }

    /// A tap, or one of the buttons on the banner.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        await PushController.shared.handle(response)
    }
}
