import Foundation
import XCTest
@testable import Webyar

/// Whether a colleague's thread offers a voice call and a video call: the
/// plan's `team_calls`, its Voice & Video module and the call's own channel
/// (`voice`, `video`), each exactly `true` — docs/operations/TEAM_CALLS.md,
/// "Plan". Nothing is offered while the plan is unknown.
@MainActor
final class TeamCallGateTests: XCTestCase {
    private actor PlanAPI: TestAPIBase {
        let snapshot: Entitlements

        init(_ snapshot: Entitlements) {
            self.snapshot = snapshot
        }

        func workspaces() async throws -> [Workspace] {
            [Workspace(id: "w1", name: "Acme", slug: "acme", logoURL: nil)]
        }

        func entitlements(workspaceID: String) async throws -> Entitlements { snapshot }
    }

    private static func plan(
        features: [String: Bool] = ["team_calls": true],
        modules: [String: Bool] = ["voice_video": true],
        channels: [String: Bool] = ["voice": true, "video": true]
    ) -> Entitlements {
        func states(_ values: [String: Bool]) -> [String: EffectiveState<Bool>] {
            values.mapValues { EffectiveState(value: $0, source: "plan", note: nil) }
        }
        return Entitlements(
            workspaceId: "w1",
            features: states(features),
            modules: states(modules),
            channels: states(channels),
            limits: [:],
            plan: nil
        )
    }

    override func tearDown() async throws {
        SessionCache.clear()
    }

    // MARK: - The rule

    func testEverythingOnOffersBothKinds() {
        let plan = Self.plan()
        XCTAssertTrue(plan.allowsTeamCall(.audio))
        XCTAssertTrue(plan.allowsTeamCall(.video))
    }

    func testWithoutTheFeatureNothingIsOffered() {
        for plan in [Self.plan(features: [:]), Self.plan(features: ["team_calls": false])] {
            XCTAssertFalse(plan.allowsTeamCall(.audio))
            XCTAssertFalse(plan.allowsTeamCall(.video))
        }
    }

    /// Colleague calls count as calls: no Voice & Video module, no call of
    /// either kind, whatever the feature says.
    func testWithoutTheVoiceAndVideoModuleNothingIsOffered() {
        let plan = Self.plan(modules: ["voice_video": false])
        XCTAssertFalse(plan.allowsTeamCall(.audio))
        XCTAssertFalse(plan.allowsTeamCall(.video))
    }

    func testEachKindFollowsItsOwnChannel() {
        let voiceOnly = Self.plan(channels: ["voice": true, "video": false])
        XCTAssertTrue(voiceOnly.allowsTeamCall(.audio))
        XCTAssertFalse(voiceOnly.allowsTeamCall(.video))

        let videoOnly = Self.plan(channels: ["video": true])
        XCTAssertFalse(videoOnly.allowsTeamCall(.audio), "a channel the plan does not carry is off")
        XCTAssertTrue(videoOnly.allowsTeamCall(.video))
    }

    // MARK: - What the thread reads

    func testNothingIsOfferedBeforeThePlanIsIn() {
        let appState = AppState(api: PlanAPI(Self.plan()))
        XCTAssertFalse(appState.teamCallAllowed(.audio))
        XCTAssertFalse(appState.teamCallAllowed(.video))
    }

    func testTheThreadOffersWhatTheWorkspacesPlanAllows() async {
        let appState = AppState(api: PlanAPI(Self.plan(channels: ["voice": true])))
        await appState.signedIn(User(id: "u-team-call-gate", email: "sara@example.com", fullName: "Sara", emailVerified: true))
        XCTAssertTrue(appState.planResolved)
        XCTAssertTrue(appState.teamCallAllowed(.audio))
        XCTAssertFalse(appState.teamCallAllowed(.video))
    }
}
