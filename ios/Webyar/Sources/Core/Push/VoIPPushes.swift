import Foundation
import PushKit
import UIKit

/// PushKit: how a colleague call rings this phone when the app is not
/// running, the screen is off or the phone is locked.
///
/// A VoIP push is not a notification. It wakes the app — launching it if it
/// has to — and iOS holds the app to one rule in return: every VoIP push must
/// become a CallKit call, reported before the push is done with, or iOS ends
/// the app and, after a few times, stops delivering VoIP pushes to it at all.
/// So nothing here decides whether a push deserves a call; `CallManager`
/// reports every one and ends at once the ones that are not a live colleague
/// ring for whoever is signed in.
///
/// The registry is made in `AppDelegate.didFinishLaunching`, before any scene:
/// a push that launched the app is delivered as soon as a registry with a
/// delegate asks for VoIP pushes, and one made later — in a SwiftUI `.task` —
/// would be too late for a launch that has no scene at all.
///
/// The address needs no permission: it goes to the server with the device row
/// (`PushController`, `voip_token`) whether or not banners are allowed, and is
/// given up with the session (`listen(false)` from `signOut()` and
/// `sessionEnded()`), so a phone nobody is signed in to is never rung — and
/// never because the Keychain could not be read (`followSession()`).
///
/// Main-actor, with the registry delivering on the main queue: the delegate
/// calls arrive where `CallManager` and `PushController` live. The conformance
/// is `@preconcurrency`, as `AppDelegate`'s are: PushKit predates Swift
/// concurrency and does not say where it calls, and this is where it does.
@MainActor
final class VoIPPushes: NSObject, @preconcurrency PKPushRegistryDelegate {
    static let shared = VoIPPushes()

    private var registry: PKPushRegistry?
    /// Waiting for the phone's first unlock, to look at the Keychain again.
    private var unlockObserver: NSObjectProtocol?

    /// Before any scene. Listens at once when this phone holds a session —
    /// the Keychain's token is the only thing that can say so before the app
    /// has asked the server anything — and not when it definitely holds none.
    func start() {
        guard registry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        self.registry = registry
        followSession()
    }

    /// What the Keychain says decides, and only a definite answer does.
    ///
    /// A Keychain that cannot be read is not a signed-out phone. After a
    /// restart iOS may launch the app in the background before the owner's
    /// first unlock, when the session token — kept "after first unlock" —
    /// cannot be read (`errSecInteractionNotAllowed`). Taking that for "nobody
    /// is signed in" would give the address up, PushKit would invalidate it,
    /// and colleague calls would stop ringing this phone, even unlocked, until
    /// the operator happened to open the app. So the registration is left as
    /// it is, and looked at again the moment the phone is unlocked.
    private func followSession() {
        switch TokenStore.presence() {
        case .present:
            listen(true)
        case .absent:
            listen(false)
        case .unreadable:
            guard unlockObserver == nil else { return }
            unlockObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main
            ) { _ in
                MainActor.assumeIsolated { VoIPPushes.shared.unlocked() }
            }
        }
    }

    private func unlocked() {
        if let unlockObserver { NotificationCenter.default.removeObserver(unlockObserver) }
        unlockObserver = nil
        followSession()
    }

    /// Asks for VoIP pushes, or gives the address up. Giving it up is what
    /// stops iOS delivering: the server's copy of the address can only fail
    /// from then on.
    func listen(_ on: Bool) {
        guard let registry else { return }
        let wanted: Set<PKPushType> = on ? [.voIP] : []
        guard registry.desiredPushTypes != wanted else { return }
        registry.desiredPushTypes = wanted
    }

    // MARK: - PKPushRegistryDelegate

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let hex = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        Task { await PushController.shared.adopt(voipToken: hex) }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        PushController.shared.voipTokenInvalidated()
    }

    /// Reported to CallKit right here, synchronously, before `completion` —
    /// whatever the push turns out to be. The payload is read where it
    /// arrives: `PKPushPayload` is not `Sendable`, so only the values parsed
    /// from it travel on.
    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        if type == .voIP {
            CallManager.shared.reportIncoming(payload.dictionaryPayload)
        }
        completion()
    }
}
