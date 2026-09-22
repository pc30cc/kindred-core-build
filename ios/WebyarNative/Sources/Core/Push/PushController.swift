import Foundation
import UIKit
import UserNotifications
import Observation

/// Everything this app knows about being reachable.
///
/// The native app shipped without any of this: no permission request, no
/// registration, no delegate, no entitlement. `server/services/push` was
/// complete — templates, categories, quiet hours, per-operator scope, a
/// dispatch log — and had nothing to send to, because `listActiveDevices`
/// only ever returned rows the Capacitor build had written. An operator who
/// installed the native app simply never heard from it.
///
/// Two deliberate choices here:
///
/// **The address is Apple's, not Google's.** `didRegisterForRemoteNotifications`
/// hands over a raw APNs device token and that is what is registered, with
/// `transport: "apns"`. The server sends to Apple directly — the same key and
/// the same HTTP/2 connection the CallKit ring already uses. Adding
/// FirebaseMessaging to get a token that Firebase would then forward to that
/// same Apple endpoint would mean eight SPM products, a plist of API keys in
/// the bundle, delegate swizzling, and a third party in the path of every
/// operator notification.
///
/// **Permission is never asked for at launch.** iOS gives an app exactly one
/// system prompt, and one shown before the operator has seen a single
/// conversation is spent on somebody with no reason to say yes. It is asked
/// for from two places that both have context: the notification settings
/// screen, and a primer the operator can accept or decline the first time
/// they reach the inbox. `requestAuthorization` is only ever called after
/// somebody has asked for it in the app's own words.
@MainActor
@Observable
final class PushController {
    static let shared = PushController()

    /// What iOS says about this app's permission, refreshed whenever the app
    /// comes forward — the operator can change it in Settings at any time
    /// and never tells us.
    private(set) var authorization: UNAuthorizationStatus = .notDetermined

    /// Whether the server has this device's current address.
    private(set) var isRegistered = false

    /// What the server said when it took the registration. `false` means the
    /// platform has no APNs credentials, so nothing will ever arrive however
    /// the operator sets their preferences — worth saying out loud.
    private(set) var platformCanSend: Bool?

    /// The last error registration produced, for the settings screen to show
    /// rather than leaving a silent "off".
    private(set) var lastFailure: String?

    private var deviceToken: String?
    private var isSignedIn = false
    private var workspaceID: String?

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    // MARK: - Identity of this install

    private static let deviceIDKey = "push.deviceId"

    /// A stable id for this installation.
    ///
    /// Generated once and kept in `UserDefaults`, rather than read from
    /// `identifierForVendor`. It is the same thing for the server's purposes
    /// — one row per install, surviving token rotation — and it is not a
    /// device identifier, so there is nothing to declare and nothing that
    /// follows the operator to another app.
    var deviceID: String {
        if let existing = UserDefaults.standard.string(forKey: Self.deviceIDKey) { return existing }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: Self.deviceIDKey)
        return fresh
    }

    /// What the device row is labelled with in the operator's session list.
    ///
    /// Deliberately NOT `UIDevice.current.name`: since iOS 16 that returns
    /// the model unless the app holds a special entitlement, so asking for it
    /// buys nothing and looks like an app trying to identify the hardware.
    private var deviceName: String {
        "\(UIDevice.current.model) · iOS \(UIDevice.current.systemVersion)"
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    // MARK: - Permission

    func refreshAuthorization() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorization = settings.authorizationStatus
        // Permission granted outside the app — in iOS Settings — leaves us
        // with no token until we ask for one, so this is also where a
        // re-enabled app gets back on the air.
        if isAllowed && deviceToken == nil {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    var isAllowed: Bool {
        authorization == .authorized || authorization == .provisional || authorization == .ephemeral
    }

    /// Asks iOS, once, and starts registering if the answer is yes.
    ///
    /// Returns what the operator chose, so the caller can react — the
    /// settings screen sends them to iOS Settings on a refusal, because the
    /// system will not ask twice.
    @discardableResult
    func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshAuthorization()
        if granted {
            UIApplication.shared.registerForRemoteNotifications()
        }
        return granted
    }

    /// The button in iOS Settings, for when the system prompt is spent.
    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    // MARK: - Registration

    /// Called by the app delegate with whatever Apple handed it.
    func adopt(deviceToken data: Data) async {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        guard hex != deviceToken else { return }
        deviceToken = hex
        lastFailure = nil
        await pushToServer()
    }

    func registrationFailed(_ error: Error) {
        // Not fatal and not worth alarming anybody with: a simulator with no
        // Apple ID, or a device briefly without a network, both land here.
        deviceToken = nil
        isRegistered = false
        lastFailure = error.localizedDescription
    }

    /// The operator has signed in, or changed workspace.
    ///
    /// The device row is owned by a user, so a token registered before
    /// sign-in belongs to nobody and a token registered by the previous
    /// operator has to be re-owned. Both are handled by simply registering
    /// again once we know who is here.
    func sessionChanged(signedIn: Bool, workspaceID: String?) async {
        isSignedIn = signedIn
        self.workspaceID = workspaceID
        guard signedIn else { return }
        await refreshAuthorization()
        await pushToServer()
    }

    private func pushToServer() async {
        guard isSignedIn, let deviceToken, isAllowed else { return }
        do {
            let result = try await api.registerPushDevice(
                token: deviceToken,
                deviceID: deviceID,
                deviceName: deviceName,
                appVersion: appVersion,
                permission: permissionString,
                workspaceID: workspaceID
            )
            isRegistered = true
            platformCanSend = result.pushEnabled
            lastFailure = nil
        } catch {
            isRegistered = false
            lastFailure = String(describing: error)
        }
    }

    private var permissionString: String {
        switch authorization {
        case .authorized, .provisional, .ephemeral: "granted"
        case .denied: "denied"
        default: "prompt"
        }
    }

    /// Signing out. This phone only — the operator's other devices keep
    /// working, which is why the server's own endpoint is per-device.
    func signOut() async {
        isSignedIn = false
        isRegistered = false
        platformCanSend = nil
        // Best effort: a failure here must never block a sign-out. The device
        // row's next send will fail with an unregistered token and be
        // disabled anyway.
        try? await api.unregisterPushDevice(deviceID: deviceID)
    }

    // MARK: - What a notification asked for

    /// A conversation a notification wants opened.
    struct PendingConversation: Equatable, Hashable, Sendable {
        let workspaceID: String
        let conversationID: String
    }

    /// Set when the operator taps a banner, cleared once a screen has acted
    /// on it. Nothing navigates from inside the delegate: a tap can arrive
    /// while the app is still launching, before there is a navigation stack
    /// to push onto.
    var pendingOpen: PendingConversation?

    /// The conversation currently on screen, if any.
    ///
    /// A banner for the thread the operator is already reading is noise, and
    /// worse than noise on a phone: it covers the newest message with a copy
    /// of itself. Set by `ChatView`.
    var viewing: String?

    /// Foreground arrival: what iOS should do with it.
    func presentation(for content: UNNotificationContent) -> UNNotificationPresentationOptions {
        applyBadge(from: content)
        if let id = content.userInfo["conversationId"] as? String, id == viewing { return [] }
        return [.banner, .sound, .list]
    }

    /// A tap, or one of the buttons on the banner.
    func handle(_ response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard
            let conversationID = info["conversationId"] as? String,
            let workspaceID = info["workspaceId"] as? String
        else { return }
        let target = PendingConversation(workspaceID: workspaceID, conversationID: conversationID)

        switch response.actionIdentifier {
        case "MARK_READ":
            // Nothing opens. If it fails, fall through to opening the thread
            // — it is marked read by being read, which is the right failure.
            do { try await api.markSeen(conversationID: conversationID) } catch { pendingOpen = target }

        case "REPLY":
            guard let typed = (response as? UNTextInputNotificationResponse)?.userText
                .trimmingCharacters(in: .whitespacesAndNewlines), !typed.isEmpty
            else {
                pendingOpen = target
                return
            }
            do {
                try await api.send(
                    body: typed,
                    conversationID: conversationID,
                    workspaceID: workspaceID,
                    // A resumed app can replay the same action, and the
                    // server dedupes on this.
                    clientMessageID: UUID().uuidString,
                    attachmentID: nil
                )
            } catch {
                // Open the thread rather than swallowing what they typed.
                pendingOpen = target
            }

        default:
            // Includes `UNNotificationDefaultActionIdentifier` — a plain tap
            // — and any action id this build does not know, which is what an
            // operator renaming one in Super Admin produces. Opening the
            // thread is the right answer to all of them.
            pendingOpen = target
        }
    }

    /// Handed to whichever screen can act on it, once.
    func takePendingOpen() -> PendingConversation? {
        defer { pendingOpen = nil }
        return pendingOpen
    }

    // MARK: - Categories

    /// Registers the action buttons a banner can carry.
    ///
    /// The buttons come from the OS, not from the payload: iOS only shows
    /// them when a category with that id has been registered by THIS app. The
    /// ids are the shipped set in `server/services/push/platformSettings.ts`;
    /// an id that exists on only one side produces a banner with no buttons,
    /// never a failure.
    ///
    /// Re-registered whenever the language changes, because the titles are in
    /// the operator's chosen language rather than the device's — this app
    /// deliberately never reads the device language.
    func registerCategories(language: Language) {
        let reply = UNTextInputNotificationAction(
            identifier: "REPLY",
            title: Str.pushReply(language),
            // Foreground so the app is running when the send goes out. A
            // background send would need a notification service extension,
            // and a button that silently fails is worse than one that opens
            // the thread.
            options: [.foreground],
            textInputButtonTitle: Str.send(language),
            textInputPlaceholder: Str.pushReplyPlaceholder(language)
        )
        let markRead = UNNotificationAction(
            identifier: "MARK_READ",
            title: Str.pushMarkRead(language),
            options: []
        )
        let open = UNNotificationAction(
            identifier: "OPEN",
            title: Str.pushOpen(language),
            options: [.foreground]
        )

        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(
                identifier: "WEBYAR_MESSAGE",
                actions: [reply, markRead],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: "WEBYAR_MENTION",
                actions: [open],
                intentIdentifiers: [],
                options: []
            ),
        ])
    }

    // MARK: - Badge

    /// Takes the badge off a payload, when it carried one.
    private func applyBadge(from content: UNNotificationContent) {
        guard let badge = content.badge?.intValue else { return }
        applyBadge(badge)
    }

    /// The unread count Apple draws on the icon.
    ///
    /// Set from the payload rather than counted locally: the server is the
    /// only place that knows how many conversations are unread across every
    /// workspace this operator belongs to, and a number the app computed from
    /// what it happens to have loaded would be wrong more often than right.
    func applyBadge(_ value: Int) {
        UNUserNotificationCenter.current().setBadgeCount(max(0, value))
    }
}
