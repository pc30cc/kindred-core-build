import Foundation
import XCTest
@testable import Webyar

/// The mobile app as a plan feature, read exactly as
/// docs/operations/MOBILE_APP_PLAN.md spells it: the app is locked only by
/// an explicit `false` for the workspace on screen — loading, a failed read,
/// a missing key and `true` never lock — and while it is, a colleague's ring
/// for that workspace is reported to CallKit and ended at once, and a tapped
/// notification does nothing.
@MainActor
final class MobileAppLockTests: XCTestCase {
    private actor PlanAPI: TestAPIBase {
        /// Each workspace's snapshot; a workspace without one fails to read.
        let snapshots: [String: Entitlements]
        let list: [Workspace]

        init(_ snapshots: [String: Entitlements], workspaces: [String] = ["w-lock"]) {
            self.snapshots = snapshots
            self.list = workspaces.map { Workspace(id: $0, name: "Acme \($0)", slug: $0, logoURL: nil) }
        }

        func workspaces() async throws -> [Workspace] { list }

        func entitlements(workspaceID: String) async throws -> Entitlements {
            guard let snapshot = snapshots[workspaceID] else { throw APIError.transport }
            return snapshot
        }
    }

    /// A workspace list that can change and a plan read that can be held, to
    /// look at the app between a change of workspace and that one's plan.
    private actor MovingAPI: TestAPIBase {
        let snapshots: [String: Entitlements]
        private var list: [Workspace]
        private var holding: String?
        private var held: CheckedContinuation<Void, Never>?

        init(_ snapshots: [String: Entitlements], workspaces: [String]) {
            self.snapshots = snapshots
            self.list = workspaces.map { Workspace(id: $0, name: "Acme \($0)", slug: $0, logoURL: nil) }
        }

        func workspaces() async throws -> [Workspace] { list }

        func entitlements(workspaceID: String) async throws -> Entitlements {
            if workspaceID == holding { await withCheckedContinuation { held = $0 } }
            guard let snapshot = snapshots[workspaceID] else { throw APIError.transport }
            return snapshot
        }

        func move(to workspaces: [String], holdingThePlanOf workspaceID: String) {
            list = workspaces.map { Workspace(id: $0, name: "Acme \($0)", slug: $0, logoURL: nil) }
            holding = workspaceID
        }

        var isHolding: Bool { held != nil }

        func release() {
            holding = nil
            held?.resume()
            held = nil
        }
    }

    /// A fresh account per test, so no test opens on the workspace another
    /// one left selected in this phone's saved copy (`AccountSnapshot`).
    private var member: User!

    /// A plan whose `features` carry `mobile_app` as given: a value, a JSON
    /// null (`.some(nil)`), or no key at all (nil).
    private static func plan(_ mobileApp: Bool??, workspaceID: String = "w-lock") -> Entitlements {
        var features: [String: EffectiveState<Bool>] = [
            "inbox_team_chat": EffectiveState(value: true, source: "plan", note: nil),
        ]
        if let mobileApp {
            features[Entitlements.mobileAppKey] = EffectiveState(value: mobileApp, source: "plan", note: nil)
        }
        return Entitlements(workspaceId: workspaceID, features: features, modules: [:], channels: [:], limits: [:], plan: nil)
    }

    private var suite: UserDefaults!
    private let suiteName = "MobileAppLockTests"

    override func setUp() async throws {
        member = User(id: "u-mobile-app-lock-\(UUID().uuidString)", email: "sara@example.com", fullName: "Sara", emailVerified: true)
        SessionCache.clear()
        MobileAppLock.clear()
        suite = UserDefaults(suiteName: suiteName)
        suite.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() async throws {
        SessionCache.clear()
        MobileAppLock.clear()
        // The singletons a locked AppState reached, back as a fresh app has them.
        PushController.shared.appLocked = false
        SyncCoordinator.shared.setSuspended(false)
        suite.removePersistentDomain(forName: suiteName)
        LocalStore.removeUser(member.id)
    }

    // MARK: - The rule

    func testOnlyAnExplicitFalseLocks() {
        XCTAssertTrue(Self.plan(false).mobileAppLocked)
        XCTAssertFalse(Self.plan(true).mobileAppLocked)
        XCTAssertFalse(Self.plan(nil).mobileAppLocked, "a plan without the key is not locked")
        XCTAssertFalse(Self.plan(.some(nil)).mobileAppLocked, "a key without a value is not locked")
        let noFeatures = Entitlements(workspaceId: "w-lock", features: nil, modules: nil, channels: nil, limits: nil, plan: nil)
        XCTAssertFalse(noFeatures.mobileAppLocked)
    }

    func testLoadingAndAFailedReadNeverLock() {
        XCTAssertFalse(EntitlementsState.loading.mobileAppLocked)
        XCTAssertFalse(EntitlementsState.failed.mobileAppLocked)
        XCTAssertTrue(EntitlementsState.loaded(Self.plan(false)).mobileAppLocked)
        XCTAssertFalse(EntitlementsState.loaded(Self.plan(true)).mobileAppLocked)
    }

    /// The server's own words decode into the rule: `false` locks, a JSON
    /// null does not.
    func testTheSnapshotAsTheServerSendsIt() throws {
        func decode(_ json: String) throws -> Entitlements {
            try JSONDecoder().decode(Entitlements.self, from: Data(json.utf8))
        }
        XCTAssertTrue(try decode(#"{"features": {"mobile_app": {"value": false, "source": "plan"}}}"#).mobileAppLocked)
        XCTAssertFalse(try decode(#"{"features": {"mobile_app": {"value": true, "source": "plan"}}}"#).mobileAppLocked)
        XCTAssertFalse(try decode(#"{"features": {"mobile_app": {"value": null, "source": "default"}}}"#).mobileAppLocked)
        XCTAssertFalse(try decode(#"{"features": {"inbox_team_chat": {"value": true}}}"#).mobileAppLocked)
    }

    // MARK: - What the app does with it

    func testNothingIsLockedBeforeThePlanIsIn() {
        let appState = AppState(api: PlanAPI(["w-lock": Self.plan(false)]))
        XCTAssertFalse(appState.isAppLocked)
    }

    func testAnExplicitFalseLocksTheAppAndStopsItsWork() async {
        let appState = AppState(api: PlanAPI(["w-lock": Self.plan(false)]))
        await appState.signedIn(member)
        XCTAssertTrue(appState.planResolved)
        XCTAssertTrue(appState.isAppLocked)
        XCTAssertTrue(SyncCoordinator.shared.isSuspended, "no realtime or upkeep for a locked workspace")
        XCTAssertTrue(PushController.shared.appLocked, "a tapped notification does nothing")
        XCTAssertTrue(MobileAppLock.isLocked(workspaceID: "w-lock"), "kept for the ring that comes without the app")
    }

    func testTrueAMissingKeyAndAFailedReadDoNotLock() async {
        for snapshots in [["w-lock": Self.plan(true)], ["w-lock": Self.plan(nil)], [:]] as [[String: Entitlements]] {
            let appState = AppState(api: PlanAPI(snapshots))
            await appState.signedIn(member)
            XCTAssertTrue(appState.planResolved)
            XCTAssertFalse(appState.isAppLocked, "\(snapshots.keys)")
            XCTAssertFalse(SyncCoordinator.shared.isSuspended)
            XCTAssertFalse(PushController.shared.appLocked)
            XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "w-lock"))
        }
    }

    /// Another workspace is another plan: switching to one whose plan has the
    /// app on unlocks it, and the locked one is still known as locked.
    func testASwitchToAnotherWorkspaceFollowsItsOwnPlan() async {
        let appState = AppState(api: PlanAPI(
            ["w-lock": Self.plan(false), "w-open": Self.plan(true, workspaceID: "w-open")],
            workspaces: ["w-lock", "w-open"]
        ))
        await appState.signedIn(member)
        XCTAssertEqual(appState.selectedWorkspace?.id, "w-lock")
        XCTAssertTrue(appState.isAppLocked)

        let open = appState.workspaces.first { $0.id == "w-open" }!
        appState.select(open)
        XCTAssertFalse(appState.isAppLocked, "a switch reads the plan again, and loading never locks")
        await appState.loadPlan()
        XCTAssertFalse(appState.isAppLocked)
        XCTAssertFalse(SyncCoordinator.shared.isSuspended)
        XCTAssertTrue(MobileAppLock.isLocked(workspaceID: "w-lock"))
        XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "w-open"))
    }

    func testTheLockEndsWithTheSession() async {
        let appState = AppState(api: PlanAPI(["w-lock": Self.plan(false)]))
        await appState.signedIn(member)
        XCTAssertTrue(appState.isAppLocked)
        await appState.handleUnauthorized()
        XCTAssertFalse(appState.isAppLocked)
        XCTAssertFalse(SyncCoordinator.shared.isSuspended)
        XCTAssertFalse(PushController.shared.appLocked)
        XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "w-lock"), "the next session learns its plans afresh")
    }

    /// The lock is the open workspace's own: when the list loses the
    /// workspace that was open and the app moves to another, the last one's
    /// snapshot — still in hand until the new plan is in — does not lock it.
    func testTheLockIsTheOpenWorkspacesOwn() async throws {
        let api = MovingAPI(
            ["w-lock": Self.plan(false), "w-open": Self.plan(true, workspaceID: "w-open")],
            workspaces: ["w-lock"]
        )
        let appState = AppState(api: api)
        await appState.signedIn(member)
        XCTAssertTrue(appState.isAppLocked)

        await api.move(to: ["w-open"], holdingThePlanOf: "w-open")
        let reload = Task { await appState.loadWorkspaces() }
        for _ in 0..<200 {
            if await api.isHolding { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let holding = await api.isHolding
        XCTAssertTrue(holding, "the new workspace's plan was never asked for")
        XCTAssertEqual(appState.selectedWorkspace?.id, "w-open")
        XCTAssertFalse(appState.isAppLocked, "the last workspace's lock is drawn over this one")
        XCTAssertFalse(SyncCoordinator.shared.isSuspended)

        await api.release()
        await reload.value
        XCTAssertFalse(appState.isAppLocked)
    }

    /// Nothing a notification asked to open while the app was locked is
    /// opened once it unlocks.
    func testALockForgetsWhatANotificationAskedToOpen() {
        PushController.shared.pendingOpen = .conversation(workspaceID: "w-lock", conversationID: "c1")
        PushController.shared.appLocked = true
        XCTAssertNil(PushController.shared.pendingOpen)
    }

    // MARK: - A tapped notification

    func testATapDoesNothingWhileTheAppIsLocked() async {
        let push = PushController(api: PlanAPI(["w-lock": Self.plan(false)]))
        push.appLocked = true
        let tapped = await push.tapMayAct(on: .conversation(workspaceID: "w-other", conversationID: "c1"))
        XCTAssertFalse(tapped)
    }

    func testATapForAWorkspaceStillLockedDoesNothing() async {
        MobileAppLock.record(workspaceID: "w-lock", locked: true)
        let push = PushController(api: PlanAPI(["w-lock": Self.plan(false)]))
        let tapped = await push.tapMayAct(on: .conversation(workspaceID: "w-lock", conversationID: "c1"))
        XCTAssertFalse(tapped)
        XCTAssertTrue(MobileAppLock.isLocked(workspaceID: "w-lock"))
    }

    /// The memory went stale — the plan was switched back on while another
    /// workspace was open here: the tap opens, and the workspace is
    /// forgotten as locked.
    func testATapForAWorkspaceSwitchedBackOnOpens() async {
        MobileAppLock.record(workspaceID: "w-back", locked: true)
        let push = PushController(api: PlanAPI(["w-back": Self.plan(true, workspaceID: "w-back")]))
        let tapped = await push.tapMayAct(on: .colleague(workspaceID: "w-back", peerID: "u2"))
        XCTAssertTrue(tapped)
        XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "w-back"), "the next ring rings again")
    }

    /// Fail-open: a plan that cannot be read never stops a tap.
    func testATapWhosePlanCannotBeReadOpens() async {
        MobileAppLock.record(workspaceID: "w-lock", locked: true)
        let push = PushController(api: PlanAPI([:]))
        let tapped = await push.tapMayAct(on: .conversation(workspaceID: "w-lock", conversationID: "c1"))
        XCTAssertTrue(tapped)
        XCTAssertTrue(MobileAppLock.isLocked(workspaceID: "w-lock"), "a failed read changes nothing")
    }

    /// Support is one chat from every workspace, whichever one it is filed under.
    func testASupportTapIsNotHeldByAnotherWorkspacesLock() async {
        MobileAppLock.record(workspaceID: "w-lock", locked: true)
        let push = PushController(api: PlanAPI(["w-lock": Self.plan(false)]))
        let tapped = await push.tapMayAct(on: .support(workspaceID: "w-lock", threadID: "s1"))
        XCTAssertTrue(tapped)
    }

    func testARecheckOnlyEverForgets() async {
        MobileAppLock.record(workspaceID: "w-lock", locked: true, defaults: suite)
        let stillOff = await MobileAppLock.recheck(
            workspaceID: "w-lock", api: PlanAPI(["w-lock": Self.plan(false)]), defaults: suite
        )
        XCTAssertEqual(stillOff, true)
        XCTAssertTrue(MobileAppLock.isLocked(workspaceID: "w-lock", defaults: suite))

        let unread = await MobileAppLock.recheck(workspaceID: "w-lock", api: PlanAPI([:]), defaults: suite)
        XCTAssertNil(unread)
        XCTAssertTrue(MobileAppLock.isLocked(workspaceID: "w-lock", defaults: suite))

        let backOn = await MobileAppLock.recheck(
            workspaceID: "w-lock", api: PlanAPI(["w-lock": Self.plan(nil)]), defaults: suite
        )
        XCTAssertEqual(backOn, false)
        XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "w-lock", defaults: suite))

        // A workspace never seen locked is never added by one.
        _ = await MobileAppLock.recheck(
            workspaceID: "w-new", api: PlanAPI(["w-new": Self.plan(false, workspaceID: "w-new")]), defaults: suite
        )
        XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "w-new", defaults: suite))
    }

    // MARK: - A visitor call on screen

    /// A visitor call's screen lives inside the app's shell: the lock waits
    /// for it to close rather than take the call away with the shell.
    func testAVisitorCallOnScreenHoldsTheLockBack() {
        XCTAssertTrue(SignedInRoot.showsLock(appLocked: true, visitorCallOnScreen: false))
        XCTAssertFalse(SignedInRoot.showsLock(appLocked: true, visitorCallOnScreen: true), "the call is cut")
        XCTAssertFalse(SignedInRoot.showsLock(appLocked: false, visitorCallOnScreen: false))
        XCTAssertFalse(SignedInRoot.showsLock(appLocked: false, visitorCallOnScreen: true))

        let screens = VisitorCallScreens()
        let call = Self.invitation("inv-1", expiresIn: 60)
        XCTAssertFalse(screens.isOn)
        screens.opened(call, phase: .waiting)
        screens.opened(call, phase: .waiting)
        XCTAssertTrue(screens.isOn)
        screens.closed(call.id)
        XCTAssertFalse(screens.isOn, "one screen, however often it appeared")
        screens.closed(call.id)
        XCTAssertFalse(screens.isOn)
    }

    private static func invitation(_ id: String, expiresIn seconds: TimeInterval) -> CallInvitation {
        CallInvitation(
            id: id, status: "pending", channel: "audio", conversationId: "c1",
            callSessionId: nil, expiresAt: Date().addingTimeInterval(seconds)
        )
    }

    /// A colleague's ring meets a visitor call (docs/operations/TEAM_CALLS.md,
    /// "iOS"): declined only in the visitor's room, ended here alone while
    /// inviting, rung as usual past a stale screen.
    func testAVisitorCallIsBusyOnlyWhileItIsOne() {
        let screens = VisitorCallScreens()
        let now = Date()
        XCTAssertEqual(screens.busy(now: now), .none)

        screens.requesting("request-1")
        XCTAssertEqual(screens.busy(now: now), .inviting, "the invitation on its way")

        let live = Self.invitation("inv-live", expiresIn: 60)
        screens.handOver("request-1", to: live)
        XCTAssertEqual(screens.busy(now: now), .inviting, "handed over, no gap")
        screens.opened(live, phase: .waiting)
        XCTAssertEqual(screens.busy(now: now), .inviting)
        XCTAssertEqual(screens.busy(now: now.addingTimeInterval(120)), .none, "an invitation that ran out is not a call")

        screens.changed(live.id, phase: .connecting)
        XCTAssertEqual(screens.busy(now: now.addingTimeInterval(120)), .live)
        screens.changed(live.id, phase: .connected)
        XCTAssertEqual(screens.busy(now: now), .live)

        screens.changed(live.id, phase: .ended(.hungUp))
        XCTAssertEqual(screens.busy(now: now), .none, "an ended screen left behind is not a call")
        XCTAssertTrue(screens.isOn, "the plan lock still waits for the screen to close")
        screens.closed(live.id)
        XCTAssertFalse(screens.isOn)
    }

    // MARK: - The store the ring reads

    func testTheLastReadIsKeptPerWorkspace() {
        XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "w1", defaults: suite))
        MobileAppLock.record(workspaceID: "w1", locked: true, defaults: suite)
        MobileAppLock.record(workspaceID: "w2", locked: false, defaults: suite)
        XCTAssertTrue(MobileAppLock.isLocked(workspaceID: "w1", defaults: suite))
        XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "w2", defaults: suite))
        MobileAppLock.record(workspaceID: "w1", locked: false, defaults: suite)
        XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "w1", defaults: suite), "the plan switched back on")
        MobileAppLock.record(workspaceID: "w1", locked: true, defaults: suite)
        MobileAppLock.clear(defaults: suite)
        XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "w1", defaults: suite))
        XCTAssertFalse(MobileAppLock.isLocked(workspaceID: "", defaults: suite))
    }

    // MARK: - A colleague's ring for a locked workspace

    /// A colleague's ring as the VoIP push carries it (docs/operations/TEAM_CALLS.md).
    private func ring(workspaceID: String) throws -> TeamCallRing {
        let payload: [AnyHashable: Any] = [
            "kind": "team_call",
            "event": "incoming",
            "call_id": "7d3f8c2e-1a4b-4c5d-9e6f-0a1b2c3d4e5f",
            "workspace_id": workspaceID,
            "workspace_name": "Acme",
            "channel": "audio",
            "caller_name": "Daniel Carter",
            "caller_user_id": "u2",
            "expires_at": NSNumber(value: 1_762_000_045),
        ]
        return try XCTUnwrap(TeamCallRing(payload: payload))
    }

    /// Reported to CallKit and ended at once (`CallManager.reportIncoming`
    /// reports every push first, then ends one that may not ring).
    func testARingForALockedWorkspaceDoesNotRing() throws {
        let ring = try ring(workspaceID: "w-lock")
        let now = ring.expiresAt.addingTimeInterval(-30)
        MobileAppLock.record(workspaceID: "w-lock", locked: true, defaults: suite)
        let locked = MobileAppLock.isLocked(workspaceID: ring.workspaceID, defaults: suite)
        XCTAssertFalse(ring.mayRing(now: now, holdsAudio: false, signedIn: true, workspaceLocked: locked))
    }

    func testARingForAnotherWorkspaceStillRings() throws {
        MobileAppLock.record(workspaceID: "w-lock", locked: true, defaults: suite)
        let ring = try ring(workspaceID: "w-open")
        let now = ring.expiresAt.addingTimeInterval(-30)
        let locked = MobileAppLock.isLocked(workspaceID: ring.workspaceID, defaults: suite)
        XCTAssertFalse(locked)
        XCTAssertTrue(ring.mayRing(now: now, holdsAudio: false, signedIn: true, workspaceLocked: locked))
    }

    /// The lock is one more reason among the ones a ring already had.
    func testTheOtherReasonsStillEndARing() throws {
        let ring = try ring(workspaceID: "w-open")
        let now = ring.expiresAt.addingTimeInterval(-30)
        XCTAssertFalse(ring.mayRing(now: ring.expiresAt, holdsAudio: false, signedIn: true, workspaceLocked: false), "ran out")
        XCTAssertFalse(ring.mayRing(now: now, holdsAudio: true, signedIn: true, workspaceLocked: false), "another call")
        XCTAssertFalse(ring.mayRing(now: now, holdsAudio: false, signedIn: false, workspaceLocked: false), "nobody here")
    }
}
