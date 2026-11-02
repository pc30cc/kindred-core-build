import Foundation

/// The mobile app as a plan feature (docs/operations/MOBILE_APP_PLAN.md):
/// Super Admin switches the iPhone and Android apps on or off per plan, and a
/// workspace whose plan has it off shows the whole app faded under one card.
///
/// The one plan gate that fails OPEN. Every other gate in this app asks for
/// exactly `true` (`Entitlements.featureEnabled`), so a plan that is still
/// loading, could not be read or does not carry a key hides what it gates.
/// This one locks only on an explicit `false`: loading, a failed read and a
/// missing key never lock — a network blip must not lock a whole team out of
/// their phones, and the key's default is on.
extension Entitlements {
    /// The registry key (`server/services/billing/capabilityRegistry.ts`).
    static let mobileAppKey = "mobile_app"

    /// The plan says, in so many words, that the mobile app is off.
    var mobileAppLocked: Bool {
        features?[Self.mobileAppKey]?.value == false
    }
}

extension EntitlementsState {
    /// Locked only by a snapshot in hand that says `false`; `loading` and
    /// `failed` never lock.
    var mobileAppLocked: Bool {
        value?.mobileAppLocked == true
    }
}

/// Which workspaces' plans last said the mobile app is off, as this phone
/// last read them.
///
/// For the parts of the app that run without `AppState`, or ask about a
/// workspace other than the one on screen: a colleague's ring, which can
/// launch the app on the lock screen and has to be answered synchronously
/// (`CallManager.reportIncoming`), and a notification tapped for another
/// workspace (`PushController.tapMayAct`). Written only from a snapshot that
/// was read (`AppState.loadPlan`): a failed read changes nothing, a read
/// without the key or with `true` takes the workspace off the list. Before
/// the phone's first unlock the defaults cannot be read, and then nothing is
/// locked — the same fail-open rule.
///
/// A memory can go stale: the plan switched back on while this phone looked
/// at another workspace. So whatever it stops is asked again
/// (`recheck`) — a tap before it is dropped, a ring after it was ended, and
/// every remembered workspace when the app comes forward — and a plan that
/// no longer says `false` takes the workspace off the list.
enum MobileAppLock {
    private static let lockedKey = "app.mobileAppLockedWorkspaces"

    static func isLocked(workspaceID: String, defaults: UserDefaults = .standard) -> Bool {
        guard !workspaceID.isEmpty else { return false }
        return lockedWorkspaces(defaults).contains(workspaceID)
    }

    /// Every workspace remembered as locked.
    static func lockedWorkspaceIDs(defaults: UserDefaults = .standard) -> [String] {
        lockedWorkspaces(defaults).sorted()
    }

    /// Asks the plan of a workspace remembered as locked again. True when it
    /// still says the mobile app is off; false when it no longer does — the
    /// workspace is then forgotten; nil when it could not be read, which
    /// changes nothing (and, for a tap, does not stand in its way).
    ///
    /// Only ever takes a workspace off the list: a lock is learned from the
    /// plan of the workspace on screen (`AppState.loadPlan`), so an answer
    /// that lands after a sign-out can never leave one behind for the next
    /// session.
    static func recheck(
        workspaceID: String,
        api: any WebyarAPI,
        defaults: UserDefaults = .standard
    ) async -> Bool? {
        guard let snapshot = try? await api.entitlements(workspaceID: workspaceID) else { return nil }
        guard snapshot.mobileAppLocked else {
            record(workspaceID: workspaceID, locked: false, defaults: defaults)
            return false
        }
        return true
    }

    /// What a snapshot of `workspaceID`'s plan said.
    static func record(workspaceID: String, locked: Bool, defaults: UserDefaults = .standard) {
        guard !workspaceID.isEmpty else { return }
        var list = lockedWorkspaces(defaults)
        if locked {
            list.insert(workspaceID)
        } else {
            guard list.remove(workspaceID) != nil else { return }
        }
        if list.isEmpty {
            defaults.removeObject(forKey: lockedKey)
        } else {
            defaults.set(list.sorted(), forKey: lockedKey)
        }
    }

    /// The session ended: the next one learns its plans afresh.
    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: lockedKey)
    }

    private static func lockedWorkspaces(_ defaults: UserDefaults) -> Set<String> {
        Set(defaults.stringArray(forKey: lockedKey) ?? [])
    }
}

extension TeamCallRing {
    /// Whether this colleague ring may ring here, given what the phone
    /// knows at the moment the VoIP push arrives. Anything else is reported
    /// to CallKit and ended at once (`CallManager.reportIncoming`): a ring
    /// that ran out, one that arrives while another call holds the phone,
    /// one with nobody signed in here — and one for a workspace whose plan
    /// has the mobile app off (docs/operations/MOBILE_APP_PLAN.md). A call
    /// already on is never asked this: a lock never cuts one.
    func mayRing(now: Date, holdsAudio: Bool, signedIn: Bool, workspaceLocked: Bool) -> Bool {
        !isExpired(now: now) && !holdsAudio && signedIn && !workspaceLocked
    }
}
