import CryptoKit
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
    /// The permission the server was last told about, so a change made in
    /// iOS Settings is reported once rather than on every return to the app.
    private var reportedPermission: String?

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

    /// Asked on launch, on every return to the foreground, and by the
    /// screens that depend on the answer: the operator can change it in iOS
    /// Settings at any time and iOS never tells the app.
    func refreshAuthorization() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorization = settings.authorizationStatus
        // Permission granted outside the app — in iOS Settings — leaves us
        // with no token until we ask for one, so this is also where a
        // re-enabled app gets back on the air.
        if isAllowed && deviceToken == nil {
            UIApplication.shared.registerForRemoteNotifications()
        }
        // Turned off (or back on) in iOS Settings since the server last
        // heard: it says so on the device row, which is what the platform's
        // delivery status reads — a phone that silently stopped showing
        // banners is otherwise indistinguishable from one that gets them.
        if isRegistered, reportedPermission != permissionString {
            await pushToServer()
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
        // Not gated on permission: a token that exists was issued while it
        // was granted, and a revocation since is exactly what the row should
        // now say.
        guard isSignedIn, let deviceToken else { return }
        let permission = permissionString
        do {
            let result = try await api.registerPushDevice(
                token: deviceToken,
                deviceID: deviceID,
                deviceName: deviceName,
                appVersion: appVersion,
                permission: permission,
                workspaceID: workspaceID
            )
            isRegistered = true
            reportedPermission = permission
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
        forgetSession()
        // Best effort: a failure here must never block a sign-out. The device
        // row's next send will fail with an unregistered token and be
        // disabled anyway.
        try? await api.unregisterPushDevice(deviceID: deviceID)
    }

    /// The session ended without a sign-out: it expired, was revoked, or
    /// the account was deleted.
    ///
    /// The server's device row cannot be switched off from here — that call
    /// needs the session that has just ended — and left alone it would go on
    /// putting this operator's customers on a phone nobody is signed in to.
    /// So the address itself is given up: Apple stops delivering to it, and
    /// the next sign-in asks for a fresh one and registers that.
    func sessionEnded() {
        forgetSession()
        deviceToken = nil
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    /// Everything that belonged to the account that just left: where it was
    /// going, what it was reading, and what it left on the lock screen.
    private func forgetSession() {
        isSignedIn = false
        isRegistered = false
        platformCanSend = nil
        reportedPermission = nil
        pendingOpen = nil
        viewing = nil
        viewingColleague = nil
        viewingEmailThread = nil
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        applyBadge(0)
    }

    // MARK: - What a notification asked for

    /// Set when the operator taps a banner, cleared once a screen has acted
    /// on it. Nothing navigates from inside the delegate: a tap can arrive
    /// while the app is still launching, before there is a navigation stack
    /// to push onto.
    var pendingOpen: PushTarget?

    /// The conversation currently on screen, if any.
    ///
    /// A banner for the thread the operator is already reading is noise, and
    /// worse than noise on a phone: it covers the newest message with a copy
    /// of itself. Set by `ChatView`.
    var viewing: String?
    /// The colleague whose thread is on screen. Set by `TeamThreadView`.
    var viewingColleague: String?
    /// The email thread on screen. Set by `EmailThreadView`.
    var viewingEmailThread: String?

    /// Foreground arrival: what iOS should do with it.
    ///
    /// The app is open, so the conversation it names is read now — only
    /// what changed in it, and a revalidation of the list — rather than
    /// waiting for the next event or poll. Never a reload of everything: a
    /// push may be late, grouped or duplicated, and it is only ever a nudge.
    ///
    /// The icon's number is left alone here: while the app is open it
    /// follows the inbox's own count (`MainTabView`), which a payload counted
    /// for another workspace would only contradict.
    func presentation(for content: UNNotificationContent) -> UNNotificationPresentationOptions {
        // Nobody signed in: whatever this is belongs to an account that is
        // not here, and the sign-in screen is no place to show it.
        guard isSignedIn else { return [] }
        let target = PushTarget(userInfo: content.userInfo)
        noteArrival(target, content.userInfo)
        return isOnScreen(target) ? [] : [.banner, .sound, .list]
    }

    /// Whether the notification is about what the operator is looking at.
    private func isOnScreen(_ target: PushTarget?) -> Bool {
        switch target {
        case .conversation(_, let id)?: id == viewing
        case .colleague(_, let peer)?: peer == viewingColleague
        case .email(_, let thread)?: thread == viewingEmailThread
        case nil: false
        }
    }

    /// Hands a notification's identifiers to the sync layer. The message id,
    /// when the payload has one, lets an open thread that already has that
    /// message (realtime was faster) skip the read altogether.
    private func noteArrival(_ target: PushTarget?, _ info: [AnyHashable: Any]) {
        switch target {
        case .conversation(let workspaceID, let conversationID)?:
            SyncCoordinator.shared.pushArrived(
                workspaceID: workspaceID,
                conversationID: conversationID,
                messageID: info["messageId"] as? String
            )
        case .colleague(let workspaceID, let peerID)?:
            SyncCoordinator.shared.teamPushArrived(workspaceID: workspaceID, peerID: peerID)
        case .email?, nil:
            break
        }
    }

    /// A tap, or one of the buttons on the banner.
    func handle(_ response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let target = PushTarget(userInfo: info) else { return }
        noteArrival(target, info)

        // The two buttons act on the server as whoever holds the token. With
        // nobody signed in there is nobody to act as — and a pending open
        // left behind would surface in whichever account signs in next — so
        // they do nothing at all. The token rather than `isSignedIn`: a
        // button pressed on a cold launch arrives before the session has been
        // restored, and that operator is signed in all the same.
        if response.actionIdentifier == "MARK_READ" || response.actionIdentifier == "REPLY" {
            guard await api.hasToken else { return }
        }

        switch response.actionIdentifier {
        case "MARK_READ":
            // Nothing opens. If it fails, fall through to opening the thread
            // — it is marked read by being read, which is the right failure.
            do {
                switch target {
                case .conversation(_, let conversationID):
                    try await api.markSeen(conversationID: conversationID)
                case .colleague(let workspaceID, let peerID):
                    try await api.markTeamThreadRead(workspaceID: workspaceID, peerID: peerID)
                case .email:
                    pendingOpen = target
                }
            } catch {
                pendingOpen = target
            }

        case "REPLY":
            guard let typed = (response as? UNTextInputNotificationResponse)?.userText
                .trimmingCharacters(in: .whitespacesAndNewlines), !typed.isEmpty
            else {
                pendingOpen = target
                return
            }
            do {
                switch target {
                case .conversation(let workspaceID, let conversationID):
                    try await api.send(
                        body: typed,
                        conversationID: conversationID,
                        workspaceID: workspaceID,
                        // A resumed app can replay the same action, and the
                        // server dedupes on this — so it has to be the same
                        // key on the replay: derived from the notification
                        // and the words, not made up fresh each time.
                        clientMessageID: Self.replyKey(
                            notification: response.notification.request.identifier, body: typed
                        ),
                        attachmentID: nil
                    )
                case .colleague(let workspaceID, let peerID):
                    // To the colleague who wrote, in team chat — never to a
                    // customer.
                    try await api.sendTeamMessage(
                        workspaceID: workspaceID, recipientID: peerID, body: typed, attachmentID: nil
                    )
                case .email:
                    // No reply from a banner for mail: it needs the thread.
                    pendingOpen = target
                }
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

    /// The idempotency key of a reply typed on a banner: the same reply to
    /// the same notification is the same message, however often iOS hands
    /// the action over. 8–64 characters, as the server requires.
    nonisolated static func replyKey(notification: String, body: String) -> String {
        let digest = SHA256.hash(data: Data((notification + "\u{1F}" + body).utf8))
        return "push-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// Handed to whichever screen can act on it, once.
    func takePendingOpen() -> PushTarget? {
        defer { pendingOpen = nil }
        return pendingOpen
    }

    /// Takes the banners about something off the lock screen and out of
    /// Notification Centre once it has been read here — the conversation,
    /// the colleague's thread, the email — so what is left there is what is
    /// still waiting.
    nonisolated static func clearDelivered(_ target: PushTarget) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let stale = delivered
                .filter { PushTarget(userInfo: $0.request.content.userInfo) == target }
                .map(\.request.identifier)
            if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
        }
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
            // A customer's message, a conversation handed to the operator, one
            // the AI let go of: all answered to the customer.
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
            // A colleague's message: the same two buttons, answered to the
            // colleague in team chat.
            UNNotificationCategory(
                identifier: "WEBYAR_TEAM",
                actions: [reply, markRead],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: "WEBYAR_EMAIL",
                actions: [open],
                intentIdentifiers: [],
                options: []
            ),
        ])
    }

    // MARK: - Badge

    /// The unread count Apple draws on the icon.
    ///
    /// Two sources, one rule. While the app is closed it is the payload's,
    /// counted by the server the way the inbox counts (Open, not the AI's,
    /// not spam, plus unread colleagues). While it is open it is the inbox's
    /// own count — the same number as the Inbox tab — so the icon never
    /// disagrees with the screen the operator just left.
    func applyBadge(_ value: Int) {
        UNUserNotificationCenter.current().setBadgeCount(max(0, value))
    }
}
